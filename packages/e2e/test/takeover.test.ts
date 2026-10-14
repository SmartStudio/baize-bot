import { describe, expect, it } from "vitest";
import type { CdpConnection, CdpEvent } from "@baize/bot-runner";
import type { AgentHandle, AgentOptions } from "@baize/computer-agent";
import { chromeProfileDir } from "@baize/computer-agent/chrome-process";
import { BotListResponse, type ComputerId, type Message, type ServerPush } from "@baize/shared";
import { FAKE_FRAME_JPEG } from "../acceptance/fake-chrome.js";
import { cookieFor, startRemoteComputer, watchLive } from "../src/live.js";
import { startStack, type Stack } from "../src/stack.js";
import { type ChatRequest, type FakeUpstream, type ScriptedTurn, startUpstream } from "../src/upstream.js";

// Bot 在远程电脑的助理 Chrome 里打开小红书发布页，撞上登录墙请用户接手。
// 真控制面、真电脑代理、真运行器，只有模型上游和 Chrome 是假的。

const ASK = "去小红书创作者中心发一条笔记";
const LATER = "先别发了，改成明早再说";
const REASON = "小红书要扫码登录，请你接手";
const PAGE = "https://creator.xiaohongshu.com/publish/publish?source=official&token=e2e-once#cover";
const TITLE = "发布笔记 - 小红书创作服务平台";
const USAGE = { input: 40, output: 8 };

const say = (text: string): ScriptedTurn => ({ textChunks: [text], usage: USAGE });
const call = (id: string, name: string, args: Record<string, unknown>): ScriptedTurn => ({
  textChunks: [],
  toolCall: { id, name, args },
  usage: USAGE,
});

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: unknown }) => (typeof part.text === "string" ? part.text : "")).join("")
      : "";

/** 这次工具调用回给模型的结果。卡片上不带结果正文，只有上游的下一轮请求里看得到。 */
const toolResult = (req: ChatRequest, callId: string): string | undefined => {
  const found = req.messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
  return found === undefined ? undefined : text(found.content);
};

const lastUserSays = (req: ChatRequest, needle: string): boolean => {
  const last = req.messages.at(-1);
  return last?.role === "user" && text(last.content).includes(needle);
};

/** 用户说 LATER 那一轮直接回话；否则先 browser_open 发布页，开到了再请用户接手，接手有了结论就收尾。 */
function script(req: ChatRequest): ScriptedTurn {
  if (lastUserSays(req, LATER)) return say("好，明早再说");
  if (toolResult(req, "call-ask") !== undefined) return say("我接着发");
  if (toolResult(req, "call-open") !== undefined) return call("call-ask", "browser_ask_user", { reason: REASON });
  return call("call-open", "browser_open", { url: PAGE });
}

/**
 * 只有一条假 CDP 管道的助理 Chrome，kind 是 remote。每个标签页记着自己的网址：
 * Page.navigate 改网址并推 frameNavigated、loadEventFired，location.href、document.title、getFrameTree 都照它回；
 * startScreencast 之后给开屏的那个 session 推一帧。
 */
function pageChrome(): NonNullable<AgentOptions["makeChrome"]> {
  const urls = new Map<string, string>();
  const targetOf = new Map<string, string>();
  const listeners = new Set<(event: CdpEvent) => void>();
  let targets = 0;
  let sessions = 0;
  let worlds = 0;
  let frames = 0;

  const emit = (event: CdpEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const urlOf = (sessionId: string | undefined): string => urls.get(targetOf.get(sessionId ?? "") ?? "") ?? "";

  const reply = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => {
    switch (method) {
      case "Target.createTarget": {
        targets += 1;
        const targetId = `tab-${targets}`;
        urls.set(targetId, String(params.url));
        return { targetId };
      }
      case "Target.attachToTarget": {
        sessions += 1;
        const session = `session-${sessions}`;
        targetOf.set(session, String(params.targetId));
        return { sessionId: session };
      }
      case "Page.navigate": {
        const targetId = targetOf.get(sessionId ?? "") ?? "";
        const url = String(params.url);
        urls.set(targetId, url);
        setImmediate(() => {
          emit({ method: "Page.frameNavigated", params: { frame: { id: `frame-${targetId}`, url } }, sessionId });
          emit({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId });
        });
        return { frameId: `frame-${targetId}`, loaderId: `loader-${targetId}` };
      }
      case "Page.getFrameTree": {
        const targetId = targetOf.get(sessionId ?? "") ?? "";
        return { frameTree: { frame: { id: `frame-${targetId}`, url: urlOf(sessionId) } } };
      }
      case "Page.createIsolatedWorld":
        worlds += 1;
        return { executionContextId: worlds };
      case "Runtime.evaluate": {
        const value =
          params.expression === "location.href"
            ? urlOf(sessionId)
            : params.expression === "document.title"
              ? TITLE
              : null;
        return { result: { type: typeof value, value } };
      }
      case "Page.startScreencast":
        frames += 1;
        setImmediate(() =>
          emit({
            method: "Page.screencastFrame",
            params: {
              data: Buffer.from(FAKE_FRAME_JPEG).toString("base64"),
              sessionId: frames,
              metadata: { deviceWidth: 1280, deviceHeight: 800 },
            },
            sessionId,
          }),
        );
        return {};
      default:
        return {};
    }
  };

  const connection: CdpConnection = {
    send: async (method, params = {}, sessionId) => reply(method, params, sessionId),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isOpen: () => true,
  };
  return ({ dataDir }) => ({
    kind: "remote",
    profileDir: chromeProfileDir(dataDir),
    connection: async () => connection,
    onExit: () => () => {},
    reveal: async () => {},
    conceal: async () => {},
    pid: () => null,
    stop: async () => undefined,
  });
}

type ToolCallBody = Extract<Message["body"], { kind: "tool_call" }>;
type ToolCard = Pick<ToolCallBody, "runId" | "status" | "view"> & { readonly id: Message["id"] };

const askCards = (seen: readonly ServerPush[]): ToolCard[] =>
  seen.flatMap((push) =>
    push.type === "message" && push.message.body.kind === "tool_call" && push.message.body.tool === "browser_ask_user"
      ? [
          {
            id: push.message.id,
            runId: push.message.body.runId,
            status: push.message.body.status,
            view: push.message.body.view,
          },
        ]
      : [],
  );

const costs = (seen: readonly ServerPush[]): string[] =>
  seen.flatMap((push) =>
    push.type === "message" && push.message.body.kind === "cost" ? [push.message.body.runId] : [],
  );

/**
 * 卡片和运行收尾走电脑代理的可靠上行，画面开关走 live 通道，两条路之间没有先后保证。
 * 先把推送按到达顺序收齐，再一起断言。
 */
async function collect(stack: Stack, done: (seen: readonly ServerPush[]) => boolean): Promise<ServerPush[]> {
  const seen: ServerPush[] = [];
  while (!done(seen)) seen.push(await stack.nextPush());
  return seen;
}

type Scene = {
  readonly stack: Stack;
  readonly upstream: FakeUpstream;
  readonly computerId: ComputerId;
  readonly botId: string;
  readonly groupId: string;
  /** 断言失败时贴出来，看得见电脑代理那一侧。 */
  trace(): string;
  close(): Promise<void>;
};

async function scene(): Promise<Scene> {
  const upstream = await startUpstream(script);
  const makeChrome = pageChrome();
  let stack: Stack | undefined;
  let agent: AgentHandle | undefined;
  let agentLog = "";
  const close = async (): Promise<void> => {
    await agent?.stop();
    await stack?.close();
    await upstream.close();
  };
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      startComputer: false,
    });
    const remote = await startRemoteComputer(stack, {
      makeChrome,
      log: (line) => {
        agentLog += `${line}\n`;
      },
    });
    agent = remote.agent;
    const bot = BotListResponse.parse(await stack.get("/api/bots")).items[0];
    if (bot === undefined) throw new Error("seed 没建出 Bot");
    return {
      stack,
      upstream,
      computerId: remote.computerId,
      botId: bot.bot.id,
      groupId: bot.groupId,
      trace: () => `远程电脑代理日志：\n${agentLog}`,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** 用户发 ASK，等到接手卡（running）和那块画面都到了。 */
async function askedToTakeOver(s: Scene) {
  await s.stack.post(`/api/groups/${s.groupId}/messages`, { text: ASK });
  const seen = await collect(
    s.stack,
    (pushes) =>
      askCards(pushes).length > 0 &&
      pushes.some((push) => push.type === "live_session" && push.session.purpose.kind === "takeover"),
  );
  const card = askCards(seen)[0]!;
  const session = seen.flatMap((push) => (push.type === "live_session" ? [push.session] : []))[0]!;
  return { card, session };
}

describe("端到端：Bot 在远程电脑上请用户接手", () => {
  it("接手卡和画面对得上，用户看完一帧点交还，工具回交还那句（网址只到 path），这一轮收尾，画面关掉", async () => {
    const s = await scene();
    try {
      const { card, session } = await askedToTakeOver(s);
      expect({ status: card.status, view: card.view }, s.trace()).toEqual({
        status: "running",
        view: { kind: "takeover", liveId: session.liveId, reason: REASON, raw: { reason: REASON } },
      });
      expect(session, "画面就是卡片上那一块，挂在远程电脑上，origin 取自页面").toEqual({
        liveId: session.liveId,
        purpose: { kind: "takeover", botId: s.botId, groupId: s.groupId, reason: REASON },
        origin: "https://creator.xiaohongshu.com",
        computerId: s.computerId,
      });

      const viewer = await watchLive(s.stack.port, await cookieFor(s.stack.port), session.liveId);
      await expect.poll(() => viewer.frames().length, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(Buffer.from(viewer.frames()[0]!).equals(Buffer.from(FAKE_FRAME_JPEG)), "收到的是假 Chrome 那一帧").toBe(
        true,
      );

      viewer.end("finish");
      const seen = await collect(
        s.stack,
        (pushes) =>
          askCards(pushes).some((done) => done.id === card.id && done.status !== "running") &&
          costs(pushes).includes(card.runId) &&
          pushes.some((push) => push.type === "live_closed" && push.liveId === session.liveId),
      );
      viewer.close();
      const settled = askCards(seen).find((done) => done.id === card.id && done.status !== "running");
      expect(settled?.status, "交还了就是成功").toBe("ok");
      const settledAt = seen.findIndex((push) => push.type === "message" && push.message.id === card.id);
      const costAt = seen.findIndex((push) => push.type === "message" && push.message.body.kind === "cost");
      expect(settledAt, "工具终态先到，这一轮的账后到").toBeLessThan(costAt);

      const followUp = s.upstream.requests().find((req) => toolResult(req, "call-ask") !== undefined);
      expect(followUp && toolResult(followUp, "call-ask"), "query 和 # 后面的一次性 token 不回给模型").toBe(
        "用户交还了这一页。\n地址：https://creator.xiaohongshu.com/publish/publish\n之前的编号都作废了，要接着看先 browser_snapshot。",
      );
    } finally {
      await s.close();
    }
  });

  it("接手挂着时用户在群里又说了一句：这次接手作废，画面关掉，新消息在这一轮结束后送到 Bot", async () => {
    const s = await scene();
    try {
      const { card, session } = await askedToTakeOver(s);
      expect(card.status).toBe("running");

      await s.stack.post(`/api/groups/${s.groupId}/messages`, { text: LATER });
      const seen = await collect(
        s.stack,
        (pushes) =>
          askCards(pushes).some((done) => done.id === card.id && done.status !== "running") &&
          pushes.some((push) => push.type === "live_closed" && push.liveId === session.liveId) &&
          costs(pushes).some((runId) => runId !== card.runId),
      );
      const settled = askCards(seen).find((done) => done.id === card.id && done.status !== "running");
      expect(settled?.status, s.trace()).toBe("failed");

      const requests = s.upstream.requests();
      const voidedAt = requests.findIndex((req) => toolResult(req, "call-ask") !== undefined);
      expect(voidedAt, "作废也是一个工具结果，模型拿得到").toBeGreaterThanOrEqual(0);
      expect(toolResult(requests[voidedAt]!, "call-ask")).toBe(
        "用户在群里发了新消息，这次接手作废了。新消息会在这轮结束后送到你这里，别再请他接手。",
      );
      const laterAt = requests.findIndex((req) => lastUserSays(req, LATER));
      expect(laterAt, "新消息排在作废的那一轮之后送到 Bot").toBeGreaterThan(voidedAt);
    } finally {
      await s.close();
    }
  });
});
