import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import {
  AgentToControl,
  BotId,
  type BotRole,
  ComputerId,
  GroupId,
  LiveId,
  MessageId,
  RoutineId,
  RunId,
} from "@baize/shared";
import { afterEach, describe, expect, it } from "vitest";
import { acquireBotBrowserMutex } from "../src/browser-mutex.js";
import type { CdpConnection, CdpEvent } from "../src/cdp.js";
import {
  createRunner,
  type LiveOutcome,
  type LiveRequest,
  type PresentPage,
  type PromptMessage,
  type Runner,
  type RunnerConfig,
} from "../src/index.js";
import { takeoverLiveId } from "../src/takeover.js";
import { startGateway } from "./fixtures/gateway.js";
import { type ChatCompletionRequest, type ScriptedTurn, scriptedUpstream } from "./fixtures/openai-sse.js";

// browser_ask_user 走真运行器、真 Pi 会话、假上游、假 CDP、假屏。屏只记下收到的请求和 signal，结束由用例亲手给。

const BOT = "bot-1";
const GROUP = "group-1";
const LOGIN_URL = "https://www.xiaohongshu.com/login";
const REASON = "登录墙，请你扫码登录后交还";
const OPEN_LOGIN = ["browser_open", { url: LOGIN_URL }] as const;
const ASK_USER = ["browser_ask_user", { reason: REASON }] as const;
const FINISHED: LiveOutcome = { end: { kind: "user", action: "finish" }, url: `${LOGIN_URL}?token=abc#frag` };

type PlannedCall = readonly [name: string, args: Record<string, unknown>];

interface CdpCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

interface FakeCdp {
  readonly connection: CdpConnection;
  /** 收到的每条命令，按顺序。 */
  readonly calls: readonly CdpCall[];
  /** 建过的页，按顺序。 */
  readonly pages: ReadonlyArray<{ readonly targetId: string; readonly sessionId: string }>;
}

/** 假页面对 Runtime.evaluate 的回答：按运行器发来的表达式回固定内容。 */
function evaluate(expression: string, url: string): unknown {
  if (expression === "location.href") return url;
  if (expression === "document.title") return "登录页";
  if (expression === "document.readyState") return "complete";
  if (expression.includes("getBoundingClientRect")) return { x: 10, y: 10 };
  if (expression.includes("el.focus()")) return true;
  if (expression.includes("可点「"))
    return { title: "登录页", url, text: "请扫码登录", elements: ["[1] 按钮「登录」"] };
  return null;
}

/** 假助理 Chrome：每页一个 session，导航立刻 load 完，脚本按表达式回固定的页面内容。 */
function fakeCdp(): FakeCdp {
  const calls: CdpCall[] = [];
  const pages: Array<{ readonly targetId: string; readonly sessionId: string; url: string }> = [];
  const listeners = new Set<(event: CdpEvent) => void>();
  const emit = (event: CdpEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const connection: CdpConnection = {
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      const page = pages.find((candidate) => candidate.sessionId === sessionId);
      switch (method) {
        case "Target.createTarget": {
          const n = pages.length + 1;
          pages.push({ targetId: `tab-${n}`, sessionId: `session-${n}`, url: "about:blank" });
          return { targetId: `tab-${n}` };
        }
        case "Target.attachToTarget":
          return { sessionId: pages.find((candidate) => candidate.targetId === params.targetId)?.sessionId ?? "" };
        case "Page.getFrameTree":
          return { frameTree: { frame: { id: "frame-1" } } };
        case "Page.createIsolatedWorld":
          return { executionContextId: 7 };
        case "Page.navigate":
          if (page !== undefined) page.url = String(params.url);
          emit({ method: "Page.loadEventFired", params: {}, sessionId });
          return { loaderId: "loader-1" };
        case "Runtime.evaluate":
          return { result: { value: evaluate(String(params.expression), page?.url ?? "about:blank") } };
        case "Target.closeTarget": {
          const closed = pages.find((candidate) => candidate.targetId === params.targetId);
          if (closed !== undefined)
            emit({
              method: "Target.detachedFromTarget",
              params: { sessionId: closed.sessionId },
              sessionId: undefined,
            });
          return {};
        }
        default:
          return {};
      }
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isOpen: () => true,
  };
  return { connection, calls, pages };
}

interface Shown {
  readonly request: LiveRequest;
  readonly signal: AbortSignal;
  /** 用例替用户或屏给出结果。调用方撤回时屏自己回 caller。 */
  end(outcome: LiveOutcome): void;
}

interface FakeScreen {
  readonly present: PresentPage;
  readonly shown: readonly Shown[];
}

function fakeScreen(): FakeScreen {
  const shown: Shown[] = [];
  const present: PresentPage = (request, signal) =>
    new Promise<LiveOutcome>((resolve) => {
      let settled = false;
      const end = (outcome: LiveOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      signal.addEventListener("abort", () => end({ end: { kind: "caller" }, url: null }), { once: true });
      shown.push({ request, signal, end });
    });
  return { present, shown };
}

/** 按触发消息里的标记挑计划，按这条消息之后拿到几个工具结果挑第几步；计划走完就说「好了」。 */
const scriptPlans =
  (requests: ChatCompletionRequest[], plans: Readonly<Record<string, readonly PlannedCall[]>>) =>
  (req: ChatCompletionRequest): ScriptedTurn => {
    requests.push(req);
    const promptAt = req.messages.findLastIndex((message) => message.role === "user");
    const promptText = JSON.stringify(req.messages[promptAt]?.content);
    const marker = Object.keys(plans).find((key) => promptText.includes(key));
    if (marker === undefined) throw new Error(`假上游没有匹配的计划：${promptText.slice(0, 200)}`);
    const done = req.messages.slice(promptAt).filter((message) => message.role === "tool").length;
    const next = plans[marker]?.[done];
    if (next === undefined) return { textChunks: ["好了"], usage: { input: 800, output: 2 } };
    return {
      textChunks: [],
      toolCall: { id: `call-${done + 1}`, name: next[0], args: next[1] },
      usage: { input: 800, output: 30 },
    };
  };

/** 带这个标记的会话最后一次请求里，模型看到的全部工具结果正文。 */
const resultsSeenBy = (requests: readonly ChatCompletionRequest[], marker: string): string =>
  (requests.findLast((req) => JSON.stringify(req.messages).includes(marker))?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n---\n");

const toolNamesOf = (req: ChatCompletionRequest | undefined): string[] =>
  (req?.tools ?? []).map((tool) => tool.function.name).toSorted();

interface Harness {
  readonly runner: Runner;
  readonly sent: AgentToControl[];
  readonly cdp: FakeCdp;
  readonly screen: FakeScreen;
  readonly dataDir: string;
  config(bots: readonly string[]): RunnerConfig;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).toReversed()) await close();
});

async function start(options: {
  readonly script: (req: ChatCompletionRequest) => ScriptedTurn;
  readonly role?: BotRole;
  readonly takeoverLimitMs?: number;
  /** 收到 approval_request 就批准。 */
  readonly approve?: boolean;
}): Promise<Harness> {
  const gateway = await startGateway({ upstream: scriptedUpstream(options.script), models: [{ id: "fake" }] });
  const dataDir = mkdtempSync(join(tmpdir(), "baize-takeover-"));
  const profileDir = mkdtempSync(join(tmpdir(), "baize-takeover-profile-"));
  const cdp = fakeCdp();
  const screen = fakeScreen();
  const sent: AgentToControl[] = [];
  let runner: Runner | null = null;
  const send = (message: AgentToControl): void => {
    sent.push(AgentToControl.parse(message));
    if (message.type === "approval_request" && options.approve === true)
      runner?.approve(message.runId, message.callId, "approved");
  };
  const config = (bots: readonly string[]): RunnerConfig => ({
    computerId: ComputerId.parse("computer-1"),
    computerKind: "local",
    bots: bots.map((id) => ({
      id: BotId.parse(id),
      name: "老白",
      role: options.role ?? "member",
      preset: null,
      tags: [],
      description: "",
    })),
    tools: [],
    accounts: [],
    grants: [],
    brand: null,
    preferences: [],
    modelGateway: { baseUrl: gateway.baseUrl, apiKey: "test-key" },
    accountsProxy: { baseUrl: "http://127.0.0.1:9/accounts-proxy" },
    mcpProxy: { baseUrl: "http://127.0.0.1:9/mcp-proxy" },
    hub: { baseUrl: "http://127.0.0.1:9/hub/v1" },
    dataDir,
    extensionTools: [],
    send,
    // 点和填这类动作前运行器要先把工作记录送达控制面，送不到就不动手；这里当作总能送到。
    workAppend: async () => ({ kind: "ok" }),
    browser: {
      profileDir,
      connection: async () => cdp.connection,
      present: screen.present,
      ...(options.takeoverLimitMs === undefined ? {} : { takeoverLimitMs: options.takeoverLimitMs }),
    },
  });
  runner = createRunner(config([BOT]));
  const started = runner;
  open.push(async () => {
    await started.stop();
    await gateway.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  });
  return { runner: started, sent, cdp, screen, dataDir, config };
}

const prompt = (
  runId: string,
  text: string,
  extra: {
    readonly groupId?: string;
    readonly origin?: PromptMessage["origin"];
    readonly routine?: PromptMessage["routine"];
  } = {},
): PromptMessage => {
  const groupId = GroupId.parse(extra.groupId ?? GROUP);
  return {
    type: "prompt",
    computer: null,
    runId: RunId.parse(runId),
    botId: BotId.parse(BOT),
    groupId,
    lane: { epoch: 1, heads: {} },
    messageId: MessageId.parse(`message-${runId}`),
    text,
    origin: extra.origin ?? { kind: "user" },
    reason: "solo",
    group: { id: groupId, number: "", title: "老白", kind: "solo" },
    context: [],
    purpose: "plan",
    routine: extra.routine ?? null,
    table: null,
    task: null,
    members: [{ id: BotId.parse(BOT), name: "老白", tags: [], description: "", seat: "member" }],
  };
};

async function until(ready: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs}ms 还没等到${label}`);
    await delay(10);
  }
}

const settleTurns = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await nextTurn();
};

const cards = (h: Harness, tool: string) =>
  h.sent.flatMap((message) => (message.type === "bot_tool_call" && message.tool === tool ? [message] : []));
const runDones = (h: Harness): string[] =>
  h.sent.flatMap((message) => (message.type === "run_done" ? [message.runId] : []));
const methods = (h: Harness, from = 0): string[] => h.cdp.calls.slice(from).map((call) => call.method);

/** 跑到屏收到接手请求为止，把那次 run 的 promise 和屏上的请求一起交回。 */
async function askUser(
  h: Harness,
  runId = "run-1",
  text = "登录小红书",
): Promise<{ running: Promise<void>; shown: Shown }> {
  const running = h.runner.prompt(prompt(runId, text));
  await until(() => h.screen.shown.length >= 1, "屏收到接手请求");
  const shown = h.screen.shown.at(-1);
  if (shown === undefined) throw new Error("屏上没有请求");
  return { running, shown };
}

describe("browser_ask_user：Bot 请用户接手自己的那一页", () => {
  it("browser_open 之后请人接手：屏收到的 liveId 和运行中卡一致，targetId 是 browser_open 建的页，purpose 带 Bot、群和理由", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({ script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER] }) });

    const { running, shown } = await askUser(h);

    expect(
      h.cdp.pages.map((page) => page.targetId),
      "browser_open 只建了一页",
    ).toEqual(["tab-1"]);
    expect(shown.request).toEqual({
      liveId: takeoverLiveId("run-1", "call-2"),
      targetId: "tab-1",
      purpose: { kind: "takeover", botId: "bot-1", groupId: "group-1", reason: REASON },
    });
    const running_card = cards(h, "browser_ask_user").find((card) => card.status === "running");
    expect(running_card?.view, "运行中卡上的 liveId 就是屏上这块画面的 id，Web 按它开画面").toEqual({
      kind: "takeover",
      liveId: shown.request.liveId,
      reason: REASON,
      raw: { reason: REASON },
    });
    expect(toolNamesOf(requests[0]), "主会话手上有 browser_ask_user").toContain("browser_ask_user");

    shown.end(FINISHED);
    await running;
    expect(cards(h, "browser_ask_user").map((card) => card.status)).toEqual(["running", "ok"]);
    expect(runDones(h)).toEqual(["run-1"]);
  });

  it("用户交还：结果里的网址只有 origin 和路径，query 和 fragment 不给模型", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({ script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER] }) });
    const { running, shown } = await askUser(h);

    shown.end({ end: { kind: "user", action: "finish" }, url: "https://www.xiaohongshu.com/explore?token=abc#frag" });
    await running;

    const seen = resultsSeenBy(requests, "登录小红书");
    expect(seen).toContain(
      "用户交还了这一页。\n地址：https://www.xiaohongshu.com/explore\n之前的编号都作废了，要接着看先 browser_snapshot。",
    );
    expect(seen).not.toContain("token=abc");
    expect(seen).not.toContain("#frag");
  });

  it("没打开过页就请人接手：直接报错，屏没收到请求，也不替用户建页", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({ script: scriptPlans(requests, { 直接请人: [ASK_USER] }) });

    await h.runner.prompt(prompt("run-1", "直接请人"));

    expect(resultsSeenBy(requests, "直接请人")).toContain("你还没打开要接手的那一页，先 browser_open");
    expect(h.screen.shown).toHaveLength(0);
    expect(methods(h), "没有碰过假 Chrome").toEqual([]);
    expect(cards(h, "browser_ask_user").map((card) => card.status)).toEqual(["running", "failed"]);
  });

  it("借出期间：浏览器锁没被占着，同一个 Bot 别的群碰浏览器立刻拿到借出错误，假 Chrome 上没有任何新命令", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({
      script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER], 看一眼网页: [["browser_snapshot", {}]] }),
    });
    const { running, shown } = await askUser(h);
    const lentAt = h.cdp.calls.length;

    const lease = acquireBotBrowserMutex(h.dataDir, BotId.parse(BOT));
    try {
      expect(
        await Promise.race([lease.run(async () => "发布器拿到了锁"), delay(1000).then(() => "锁被接手占着")]),
        "借页不持锁，发布器照常发",
      ).toBe("发布器拿到了锁");
    } finally {
      lease.release();
    }

    await h.runner.prompt(prompt("run-2", "看一眼网页", { groupId: "group-2" }));

    expect(resultsSeenBy(requests, "看一眼网页")).toContain("这一页正交给用户操作，等用户交还之后再用浏览器。");
    expect(methods(h, lentAt), "借出期间不建新页，也不在借出的页上跑脚本").toEqual([]);
    expect(shown.signal.aborted, "别的群碰浏览器不作废接手").toBe(false);
    expect(runDones(h), "别的群那次照常跑完").toEqual(["run-2"]);

    shown.end(FINISHED);
    await running;
    expect(runDones(h)).toEqual(["run-2", "run-1"]);
  });

  it.each([
    ["用户放弃", { end: { kind: "user", action: "abandon" }, url: LOGIN_URL }, "用户说不弄了，这一页收回来了。"],
    ["页被关了", { end: { kind: "page_gone" }, url: null }, "这一页在接手时被关掉了，要接着弄先 browser_open。"],
    ["屏没展示出来", { end: { kind: "broken" }, url: null }, "助理浏览器出了问题，这次没法请用户接手。"],
  ] as const satisfies ReadonlyArray<readonly [string, LiveOutcome, string]>)(
    "%s：工具报中文错误，卡记 failed",
    async (_label, outcome, text) => {
      const requests: ChatCompletionRequest[] = [];
      const h = await start({ script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER] }) });
      const { running, shown } = await askUser(h);

      shown.end(outcome);
      await running;

      expect(resultsSeenBy(requests, "登录小红书")).toContain(text);
      expect(cards(h, "browser_ask_user").map((card) => card.status)).toEqual(["running", "failed"]);
    },
  );

  it("到点：时限一到屏收到撤回，工具报「等了 30 分钟」，用例不真等", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({
      script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER] }),
      takeoverLimitMs: 50,
    });
    const startedAt = Date.now();
    const { running, shown } = await askUser(h);

    await running;

    expect(shown.signal.aborted, "到点是运行器撤的，屏只看到 caller").toBe(true);
    expect(resultsSeenBy(requests, "登录小红书")).toContain("等了 30 分钟用户没有接手，这一页收回来了。");
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("run 被取消：屏收到撤回；页已交还，下一次 run 在同一页上 browser_snapshot，不建新页", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({
      script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER], 再看一眼: [["browser_snapshot", {}]] }),
    });
    const { running, shown } = await askUser(h);

    h.runner.cancel(RunId.parse("run-1"));
    await until(() => shown.signal.aborted, "屏收到撤回");
    await running;
    expect(runDones(h), "取消的 run 不发 run_done").toEqual([]);

    await h.runner.prompt(prompt("run-2", "再看一眼"));

    expect(resultsSeenBy(requests, "再看一眼")).toContain("标题：登录页");
    expect(
      methods(h).filter((method) => method === "Target.createTarget"),
      "还是 browser_open 建的那一页",
    ).toHaveLength(1);
    expect(runDones(h)).toEqual(["run-2"]);
  });

  it("用户在群里发了新消息：挂着的接手当场作废，模型拿到作废句，新消息排在这轮之后照常跑", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({ script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER], 换个话题: [] }) });
    const { running, shown } = await askUser(h);

    const next = h.runner.prompt(prompt("run-2", "换个话题"));

    expect(shown.signal.aborted, "prompt 一进来就撤，不等排队").toBe(true);
    await Promise.all([running, next]);
    expect(resultsSeenBy(requests, "登录小红书")).toContain(
      "用户在群里发了新消息，这次接手作废了。新消息会在这轮结束后送到你这里，别再请用户接手。",
    );
    expect(runDones(h)).toEqual(["run-1", "run-2"]);
  });

  it("队友 @ 来的和例行触发的新 prompt 不作废接手", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({
      script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER], 队友插话: [], 例行提醒: [] }),
    });
    const { running, shown } = await askUser(h);

    const fromBot = h.runner.prompt(
      prompt("run-2", "队友插话", { origin: { kind: "bot", id: BotId.parse("bot-2"), name: "小助", tags: [] } }),
    );
    const fromRoutine = h.runner.prompt(
      prompt("run-3", "例行提醒", {
        origin: { kind: "routine" },
        routine: { routineId: RoutineId.parse("routine-1"), boundary: "read_only" },
      }),
    );
    await settleTurns();

    expect(shown.signal.aborted).toBe(false);
    shown.end(FINISHED);
    await Promise.all([running, fromBot, fromRoutine]);
    expect(runDones(h)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("同一个 runId 重投不作废接手", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({ script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER] }) });
    const message = prompt("run-1", "登录小红书");
    const running = h.runner.prompt(message);
    await until(() => h.screen.shown.length === 1, "屏收到接手请求");
    const shown = h.screen.shown[0];
    if (shown === undefined) throw new Error("屏上没有请求");

    const again = h.runner.prompt(message);
    await settleTurns();

    expect(shown.signal.aborted).toBe(false);
    shown.end(FINISHED);
    await Promise.all([running, again]);
    expect(h.screen.shown, "重投不生出第二块画面").toHaveLength(1);
    expect(runDones(h)).toEqual(["run-1"]);
  });

  it("交还之后：同一页能 browser_snapshot，隔离世界重建；接手前的编号不能直接点，要先 snapshot", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({
      script: scriptPlans(requests, {
        登录小红书: [
          OPEN_LOGIN,
          ["browser_snapshot", {}],
          ASK_USER,
          ["browser_click", { ref: 1 }],
          ["browser_snapshot", {}],
        ],
      }),
      approve: true,
    });
    const { running, shown } = await askUser(h);
    const worldsBefore = methods(h).filter((method) => method === "Page.createIsolatedWorld").length;

    shown.end(FINISHED);
    await running;

    const seen = resultsSeenBy(requests, "登录小红书");
    expect(seen).toContain("用户接手过这一页，之前的编号都作废了，先 browser_snapshot 看一眼再动手");
    expect(cards(h, "browser_click").map((card) => card.status)).toEqual(["running", "failed"]);
    expect(cards(h, "browser_snapshot").map((card) => card.status)).toEqual(["running", "ok", "running", "ok"]);
    expect(
      methods(h).filter((method) => method === "Target.createTarget"),
      "交还后还是同一页",
    ).toHaveLength(1);
    expect(worldsBefore, "接手前只建过一次隔离世界").toBe(1);
    expect(
      methods(h).filter((method) => method === "Page.createIsolatedWorld"),
      "交还后隔离世界重建一次",
    ).toHaveLength(2);
    expect(
      h.cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent"),
      "没点下去",
    ).toEqual([]);
  });

  it("借出期间 Bot 从 config 里移除：屏收到撤回，借出的页被关掉", async () => {
    const requests: ChatCompletionRequest[] = [];
    const h = await start({ script: scriptPlans(requests, { 登录小红书: [OPEN_LOGIN, ASK_USER] }) });
    const { running, shown } = await askUser(h);

    await h.runner.applyConfig(h.config([]));

    await until(() => shown.signal.aborted, "屏收到撤回");
    await until(
      () => h.cdp.calls.some((call) => call.method === "Target.closeTarget" && call.params.targetId === "tab-1"),
      "借出的页被关掉",
    );
    await running;
  });

  it("帮手手上没有 browser_ask_user，只有主会话能请人接手", async () => {
    const requests: ChatCompletionRequest[] = [];
    const helperRequests: ChatCompletionRequest[] = [];
    const main = scriptPlans(requests, {
      查登录页: [["call_helper", { kind: "researcher", task: "看看登录页长什么样" }]],
    });
    const h = await start({
      role: "assistant",
      script: (req) => {
        if (!JSON.stringify(req.messages[0] ?? null).includes("你是主助理临时拉来的帮手")) return main(req);
        helperRequests.push(req);
        return { textChunks: ["登录页是扫码的"], usage: { input: 300, output: 10 } };
      },
    });

    await h.runner.prompt(prompt("run-1", "查登录页"));

    expect(helperRequests).toHaveLength(1);
    expect(toolNamesOf(helperRequests[0]), "帮手只拿读类工具，browser_ask_user 虽归 read 也不给它").toEqual([
      "account_read",
      "browser_open",
      "browser_snapshot",
      "read",
    ]);
    expect(toolNamesOf(requests[0])).toContain("browser_ask_user");
  });
});

describe("takeoverLiveId", () => {
  it("同一组 runId、callId 永远算出同一个，换一样就不同，形状过 LiveId.parse", () => {
    const id = takeoverLiveId("run-1", "call-2");
    expect(takeoverLiveId("run-1", "call-2")).toBe(id);
    expect(takeoverLiveId("run-1", "call-3")).not.toBe(id);
    expect(takeoverLiveId("run-2", "call-2")).not.toBe(id);
    expect(takeoverLiveId("run-1c", "all-2"), "两段分开算，不是拼起来再算").not.toBe(id);
    expect(LiveId.parse(id)).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
