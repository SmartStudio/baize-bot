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
  RunId,
  TaskId,
  type TopicTask,
} from "@baize/shared";
import { afterEach, describe, expect, it } from "vitest";
import { renderComputerSection } from "../src/computer.js";
import { botDirs, createRunner, type PromptMessage, type RunnerConfig } from "../src/index.js";
import { startGateway } from "./fixtures/gateway.js";
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
  metricSource: null,
  metric: null,
};

const prompt = (
  botId: string,
  runId: string,
  text: string,
  options: { readonly team?: boolean; readonly computer?: ComputerView | null } = {},
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
    origin: { kind: "user" },
    reason: options.team === true ? "mentioned" : "solo",
    group: { id: groupId, number: "", title: groupId, kind: options.team === true ? "team" : "solo" },
    context: [],
    purpose: "plan",
    routine: null,
    table: null,
    task: options.team === true ? TASK : null,
    members: options.team === true ? MEMBERS : MEMBERS.filter((member) => member.id === botId),
    computer: options.computer ?? null,
  };
};

async function harness(options: {
  readonly computerKind: ComputerKind;
  readonly script: (req: ChatCompletionRequest) => ScriptedTurn;
}) {
  const requests: ChatCompletionRequest[] = [];
  const gateway = await startGateway({
    models: [{ id: "test-model" }],
    upstream: scriptedUpstream((req) => {
      requests.push(req);
      return options.script(req);
    }),
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
  return { runner, requests, dataDir };
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
