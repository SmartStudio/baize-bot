import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentToControl,
  BotId,
  ComputerId,
  type ComputerKind,
  type ComputerView,
  GroupId,
  MessageId,
  PreferenceId,
  RoutineId,
  RunId,
  TaskId,
  type TopicTask,
} from "@baize/shared";
import { afterEach, describe, expect, it } from "vitest";
import { renderComputerSection } from "../src/computer.js";
import { botDirs, createRunner, type PromptMessage, type RunnerConfig } from "../src/index.js";
import { startGateway, type HubRequest } from "./fixtures/gateway.js";
import {
  isFollowUpTurn,
  scriptedUpstream,
  type ChatCompletionRequest,
  type ScriptedTurn,
} from "./fixtures/openai-sse.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const BOTS: RunnerConfig["bots"] = [
  { id: BotId.parse("bot-1"), role: "member", name: "小白", tags: ["运营"], description: "", preset: null },
  { id: BotId.parse("bot-2"), role: "member", name: "小销", tags: [], description: "管报价", preset: null },
];
const MEMBERS: PromptMessage["members"] = BOTS.map((bot) => ({
  id: bot.id,
  name: bot.name,
  tags: bot.tags,
  description: bot.description,
  seat: "member",
}));
const TASK: TopicTask = {
  id: TaskId.parse("task-1"),
  groupId: GroupId.parse("group-team"),
  number: "T-2482",
  title: "给老客户回一封询价邮件",
  summary: "先翻历史邮件再动笔",
  dueAt: "2026-09-20T10:00:00.000Z",
  checklist: [{ text: "起草回信", done: false, ownerBotId: null }],
  currentBotId: BotId.parse("bot-1"),
  handled: [],
  status: "active",
  cadence: "",
  goal: null,
  metricSources: [],
  metric: null,
  metrics: [],
};

const prompt = (
  botId: string,
  runId: string,
  text: string,
  options: {
    readonly team?: boolean;
    readonly computer?: ComputerView | null;
    readonly routine?: PromptMessage["routine"];
    readonly reason?: PromptMessage["reason"];
  } = {},
): PromptMessage => {
  const groupId = GroupId.parse(options.team === true ? "group-team" : `solo-${botId}`);
  return {
    type: "prompt",
    runId: RunId.parse(runId),
    botId: BotId.parse(botId),
    groupId,
    lane: { epoch: 1, heads: {} },
    messageId: MessageId.parse(`message-${runId}`),
    text,
    origin: options.routine === undefined ? { kind: "user" } : { kind: "routine" },
    reason: options.reason ?? (options.team === true ? "mentioned" : "solo"),
    group: { id: groupId, number: "", title: groupId, kind: options.team === true ? "team" : "solo" },
    context: [],
    purpose: "plan",
    routine: options.routine ?? null,
    table: null,
    task: options.team === true ? TASK : null,
    members: options.team === true ? MEMBERS : MEMBERS.filter((member) => member.id === botId),
    computer: options.computer ?? null,
  };
};

async function harness(options: {
  readonly computerKind: ComputerKind;
  readonly script: (req: ChatCompletionRequest) => ScriptedTurn;
  readonly hub?: (request: HubRequest) => { readonly status: number; readonly body: unknown };
}) {
  const requests: ChatCompletionRequest[] = [];
  const gateway = await startGateway({
    models: [{ id: "test-model" }],
    upstream: scriptedUpstream((req) => {
      requests.push(req);
      return options.script(req);
    }),
    ...(options.hub === undefined ? {} : { hub: options.hub }),
  });
  const dataDir = mkdtempSync(join(tmpdir(), "baize-computer-"));
  const config: RunnerConfig = {
    computerId: ComputerId.parse("computer-1"),
    computerKind: options.computerKind,
    bots: BOTS,
    tools: [],
    grants: [],
    accounts: [],
    brand: null,
    preferences: [
      {
        id: PreferenceId.parse("pref-title"),
        botId: BotId.parse("bot-1"),
        text: "标题不超过 20 个字",
        sourceMessageId: null,
        private: false,
        createdAt: "2026-10-09T08:00:00.000Z",
      },
    ],
    modelGateway: { baseUrl: gateway.baseUrl, apiKey: "computer-test-key" },
    accountsProxy: { baseUrl: "http://127.0.0.1:9/accounts-proxy" },
    mcpProxy: { baseUrl: "http://127.0.0.1:9/mcp-proxy" },
    hub: { baseUrl: "http://127.0.0.1:9/hub/v1" },
    dataDir,
    send: (message) => AgentToControl.parse(message),
    workAppend: async () => ({ kind: "ok" }),
  };
  const runner = createRunner(config);
  cleanup.push(async () => {
    await runner.stop();
    await gateway.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { runner, requests, dataDir, gateway };
}

/** 读一个工作区里没有的文件，回一轮工具结果，好让同一次 prompt 里的续轮也进基准。 */
const readOnce = (req: ChatCompletionRequest): ScriptedTurn =>
  isFollowUpTurn(req) || !JSON.stringify(req.messages.at(-1)).includes("看看笔记")
    ? { textChunks: ["好"], usage: { input: 800, output: 2 } }
    : {
        textChunks: [],
        toolCall: { id: "call-read", name: "read", args: { path: "notes.md" } },
        usage: { input: 800, output: 9 },
      };

describe("Mac 单机用户的请求体", () => {
  it("系统段和消息与加电脑段之前逐字相同", async () => {
    const h = await harness({ computerKind: "local", script: readOnce });

    await h.runner.prompt(prompt("bot-1", "run-1", "看看笔记"));
    await h.runner.prompt(prompt("bot-1", "run-2", "再说一句"));
    await h.runner.prompt(prompt("bot-2", "run-3", "单聊里问报价"));
    await h.runner.prompt(prompt("bot-1", "run-4", "@小白 起草回信", { team: true }));

    expect(h.requests, "头一次 prompt 有一轮工具结果，一共五次请求").toHaveLength(5);
    const json = JSON.stringify(
      h.requests.map((req) => req.messages),
      null,
      2,
    )
      .replaceAll(realpathSync(h.dataDir), "<dataDir>")
      .replaceAll(h.dataDir, "<dataDir>");
    const body = `${json}\n`;
    await expect(body, "基准由加电脑段之前的提交跑出").toMatchFileSnapshot(
      "./__snapshots__/computer-mac-requests.json",
    );
  });
});

const CLOUD_SELF =
  "这一轮你在云电脑上：一台 Linux 服务器，不是主人的电脑。主人电脑上的文件、登录过的网站这里都没有，浏览器要在这里单独登录。在这里工作区里的普通读写和只读命令不用问主人，联网、删除、移动、读写工作区外的东西照旧要问。";
const LOCAL_ONLINE =
  "另一台是主人的电脑，在线。需要换过去就调用 switch_computer（kind 填 local），这一轮会在那边接着做，不用让主人自己去点。";
const REMOTE_ONLINE =
  "另一台是云电脑，在线。需要换过去就调用 switch_computer（kind 填 remote），这一轮会在那边接着做，不用让主人自己去点。";

describe("renderComputerSection", () => {
  it("主人的电脑上、账号下只有这一台也没选过：这一段不出现", () => {
    expect(renderComputerSection("local", null)).toBeNull();
  });

  it("云电脑上、另一台在线、选定一致", () => {
    expect(renderComputerSection("remote", { other: { kind: "local", dispatchable: true }, choice: "remote" })).toBe(
      `## 电脑\n${CLOUD_SELF}\n${LOCAL_ONLINE}`,
    );
  });

  it("云电脑上、另一台在线、没选过", () => {
    expect(renderComputerSection("remote", { other: { kind: "local", dispatchable: true }, choice: null })).toBe(
      `## 电脑\n${CLOUD_SELF}\n${LOCAL_ONLINE}`,
    );
  });

  it("云电脑上、主人的电脑不在线", () => {
    expect(renderComputerSection("remote", { other: { kind: "local", dispatchable: false }, choice: "remote" })).toBe(
      `## 电脑\n${CLOUD_SELF}\n另一台是主人的电脑，现在不在线，换不过去。`,
    );
  });

  it("云电脑上恒出段，哪怕控制面没给快照", () => {
    expect(renderComputerSection("remote", null)).toBe(`## 电脑\n${CLOUD_SELF}`);
  });

  it("主人的电脑上、云电脑不在线", () => {
    expect(renderComputerSection("local", { other: { kind: "remote", dispatchable: false }, choice: null })).toBe(
      "## 电脑\n这一轮你在主人的电脑上。\n另一台是云电脑，现在不在线，换不过去。",
    );
  });

  it("主人的电脑上、云电脑在线、选定的就是这台", () => {
    expect(renderComputerSection("local", { other: { kind: "remote", dispatchable: true }, choice: "local" })).toBe(
      `## 电脑\n这一轮你在主人的电脑上。\n${REMOTE_ONLINE}`,
    );
  });

  it("选定改成云电脑、这一轮还在主人的电脑上：多一行", () => {
    expect(renderComputerSection("local", { other: { kind: "remote", dispatchable: true }, choice: "remote" })).toBe(
      `## 电脑\n这一轮你在主人的电脑上。\n${REMOTE_ONLINE}\n这个群里你选定的是云电脑，这一轮在主人的电脑上跑完，下一条起会在云电脑上。`,
    );
  });

  it("选定改成主人的电脑、这一轮还在云电脑上：多一行", () => {
    expect(renderComputerSection("remote", { other: { kind: "local", dispatchable: false }, choice: "local" })).toBe(
      `## 电脑\n${CLOUD_SELF}\n另一台是主人的电脑，现在不在线，换不过去。\n这个群里你选定的是主人的电脑，这一轮在云电脑上跑完，下一条起会在主人的电脑上。`,
    );
  });

  it("账号下只剩这一台、但这个群选过它", () => {
    expect(renderComputerSection("local", { other: null, choice: "local" })).toBe("## 电脑\n这一轮你在主人的电脑上。");
  });

  it("选定的云电脑已经删了：不说下一条起会换过去", () => {
    expect(renderComputerSection("local", { other: null, choice: "remote" })).toBe("## 电脑\n这一轮你在主人的电脑上。");
  });
});

const systemOf = (req: ChatCompletionRequest | undefined): string =>
  String(req?.messages.find((message) => message.role === "system")?.content ?? "");

const sessionTextOf = (dataDir: string, botId: string, groupId: string): string => {
  const dir = join(botDirs(dataDir, BotId.parse(botId)).sessionDir, groupId);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
};

describe("云电脑上的请求体", () => {
  it("每次请求现拼电脑段，换一条 prompt 的快照下一次就跟着变，会话 JSONL 里没有", async () => {
    const h = await harness({ computerKind: "remote", script: readOnce });

    await h.runner.prompt(
      prompt("bot-1", "run-1", "看看笔记", {
        computer: { other: { kind: "local", dispatchable: true }, choice: null },
      }),
    );
    expect(h.requests, "头一次 prompt 有一轮工具结果，两次请求").toHaveLength(2);
    for (const [index, req] of h.requests.entries()) {
      expect(systemOf(req), `第 ${index + 1} 次请求带电脑段，主人的电脑在线`).toContain(
        `## 电脑\n${CLOUD_SELF}\n${LOCAL_ONLINE}`,
      );
    }

    await h.runner.prompt(
      prompt("bot-1", "run-2", "再说一句", {
        computer: { other: { kind: "local", dispatchable: false }, choice: "local" },
      }),
    );
    expect(h.requests).toHaveLength(3);
    const changed = systemOf(h.requests[2]);
    expect(changed, "同一个会话换了快照，这一段跟着换").toContain(
      `## 电脑\n${CLOUD_SELF}\n另一台是主人的电脑，现在不在线，换不过去。\n这个群里你选定的是主人的电脑，这一轮在云电脑上跑完，下一条起会在主人的电脑上。`,
    );
    expect(changed, "上一轮的「在线」没有留下").not.toContain(LOCAL_ONLINE);
    expect(changed, "记忆段照旧在").toContain("- 标题不超过 20 个字");

    const session = sessionTextOf(h.dataDir, "bot-1", "solo-bot-1");
    expect(session, "会话 JSONL 已经落盘").toContain("再说一句");
    expect(session, "电脑段只在请求里，不进会话").not.toContain("## 电脑");
    expect(session, "电脑段只在请求里，不进会话").not.toContain("这一轮你在云电脑上");
  });
});

const CONTINUATION_TEXT =
  "刚才你请求换电脑，现在已经换到云电脑上了。接着刚才没做完的事做，之前对话里的内容都在，不要重新问主人，也不要把前面做过的再做一遍。";
const SWITCHED_TO_REMOTE = "已换到云电脑，这一轮到此结束，换好后会在云电脑上接着做，不用再说什么。";

/** 最后一条带这个 tool_call_id 的工具结果正文。 */
const toolResultOf = (req: ChatCompletionRequest | undefined, callId: string): string =>
  String(
    req?.messages.findLast((message) => message.role === "tool" && message.tool_call_id === callId)?.content ?? "",
  );

const switchCall = (id: string, kind: ComputerKind) => ({ id, name: "switch_computer", args: { kind } });

const switching = () => ({ status: 200, body: { result: "switching" } });

describe("switch_computer", () => {
  it("每台电脑都注册这个工具，Mac 单机用户也看得见，调了得到「没有云电脑」", async () => {
    const h = await harness({
      computerKind: "local",
      script: (req) =>
        isFollowUpTurn(req)
          ? { textChunks: ["好吧"], usage: { input: 1, output: 1 } }
          : { textChunks: [], toolCall: switchCall("call-switch", "remote"), usage: { input: 1, output: 1 } },
      hub: () => ({
        status: 200,
        body: { result: "refused", reason: "no_such_computer", text: "没有云电脑这台电脑，换不了。" },
      }),
    });
    await h.runner.prompt(prompt("bot-1", "run-1", "换到云电脑去"));
    expect(h.requests[0]?.tools?.map((tool) => tool.function.name)).toContain("switch_computer");
    expect(h.requests, "拒绝之后模型照常续轮").toHaveLength(2);
    expect(toolResultOf(h.requests[1], "call-switch"), "拒绝的文案原样回给模型").toBe("没有云电脑这台电脑，换不了。");
    expect(h.gateway.hubRequests).toEqual([
      {
        path: "/hub/v1/lane/computer",
        key: "computer-test-key",
        lane: "bot-1/solo-bot-1/1",
        body: { runId: "run-1", kind: "remote" },
      },
    ]);
  });

  it("中枢回 switching：工具结果带 terminate，模型停下，这一轮到此结束", async () => {
    const h = await harness({
      computerKind: "local",
      script: (req) =>
        isFollowUpTurn(req)
          ? {
              textChunks: ["我还想再读一个文件"],
              toolCall: { id: "call-read", name: "read", args: { path: "notes.md" } },
              usage: { input: 1, output: 1 },
            }
          : { textChunks: [], toolCall: switchCall("call-switch", "remote"), usage: { input: 1, output: 1 } },
      hub: switching,
    });
    await h.runner.prompt(
      prompt("bot-1", "run-1", "换到云电脑去", {
        computer: { other: { kind: "remote", dispatchable: true }, choice: null },
      }),
    );
    expect(h.gateway.hubRequests.map((request) => request.body)).toEqual([{ runId: "run-1", kind: "remote" }]);
    const session = sessionTextOf(h.dataDir, "bot-1", "solo-bot-1");
    expect(session, "工具结果说换好了").toContain(SWITCHED_TO_REMOTE);
    expect(h.requests, "terminate 之后不再请求模型").toHaveLength(1);
    expect(session, "换过之后没有再执行任何工具").not.toContain("notes.md 不存在");
  });

  const readCall = { id: "call-read", name: "read", args: { path: "notes.md" } };
  it.each([
    ["排在后面", [readCall, switchCall("call-switch", "remote")]],
    ["排在前面", [switchCall("call-switch", "remote"), readCall]],
  ])("和别的工具放在同一批里、换电脑%s：换电脑挡下，别的照做", async (_order, toolCalls) => {
    const h = await harness({
      computerKind: "local",
      script: (req) =>
        isFollowUpTurn(req)
          ? { textChunks: ["好"], usage: { input: 1, output: 1 } }
          : { textChunks: [], toolCalls, usage: { input: 1, output: 1 } },
      hub: switching,
    });
    await h.runner.prompt(prompt("bot-1", "run-1", "先读笔记再换到云电脑"));
    expect(h.gateway.hubRequests, "没打到中枢").toEqual([]);
    expect(h.requests).toHaveLength(2);
    expect(toolResultOf(h.requests[1], "call-switch")).toBe("换电脑要单独调用，等这一批工具做完再换");
    expect(toolResultOf(h.requests[1], "call-read"), "同一批里的 read 照常执行").not.toBe(
      "换电脑要单独调用，等这一批工具做完再换",
    );
  });

  it("上游没给工具调用 id、同一批两个调用的 id 都是空的：照样算两个，换电脑挡下", async () => {
    const h = await harness({
      computerKind: "local",
      script: (req) =>
        isFollowUpTurn(req)
          ? { textChunks: ["好"], usage: { input: 1, output: 1 } }
          : {
              textChunks: [],
              toolCalls: [switchCall("", "remote"), { id: "", name: "write", args: { path: "a.md", content: "a" } }],
              usage: { input: 1, output: 1 },
            },
      hub: switching,
    });
    await h.runner.prompt(prompt("bot-1", "run-1", "换到云电脑再写个文件"));
    expect(h.gateway.hubRequests, "没打到中枢").toEqual([]);
    expect(sessionTextOf(h.dataDir, "bot-1", "solo-bot-1")).toContain("换电脑要单独调用，等这一批工具做完再换");
  });

  it("只读例行里不能换电脑", async () => {
    const h = await harness({
      computerKind: "local",
      script: (req) =>
        isFollowUpTurn(req)
          ? { textChunks: ["好"], usage: { input: 1, output: 1 } }
          : { textChunks: [], toolCall: switchCall("call-switch", "remote"), usage: { input: 1, output: 1 } },
      hub: switching,
    });
    await h.runner.prompt(
      prompt("bot-1", "run-1", "每天看一眼", {
        routine: { routineId: RoutineId.parse("routine-1"), boundary: "read_only" },
      }),
    );
    expect(h.gateway.hubRequests).toEqual([]);
    expect(toolResultOf(h.requests[1], "call-switch")).toContain("这是「只读」例行，不能换电脑。");
  });

  it("接续的 prompt 只有控制面给的那句话，没有群标签、任务卡和「当前这条」", async () => {
    const h = await harness({
      computerKind: "remote",
      script: () => ({ textChunks: ["接着做"], usage: { input: 1, output: 1 } }),
    });
    await h.runner.prompt(
      prompt("bot-1", "run-2", CONTINUATION_TEXT, {
        reason: "continuation",
        computer: { other: { kind: "local", dispatchable: true }, choice: "remote" },
      }),
    );
    const last = h.requests[0]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toEqual([{ type: "text", text: CONTINUATION_TEXT }]);
    expect(systemOf(h.requests[0])).toContain("这一轮你在云电脑上");
  });
});
