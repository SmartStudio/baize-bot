import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentToControl,
  BotId,
  GroupId,
  HandoffId,
  RunId,
  type Skill,
  SkillId,
  TaskId,
  type ToolConnectionConfig,
  type ToolOperation,
  type TopicTask,
} from "@baize/shared";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  botDirs,
  createRunner,
  type GroupMember,
  type PromptMessage,
  renderTaskCard,
  type Runner,
  type RunnerConfig,
  type RunnerTool,
} from "../src/index.js";
import { type Gateway, startGateway } from "./fixtures/gateway.js";
import { startFakeMcp } from "./helpers/mcp.js";
import {
  type ChatCompletionRequest,
  isFollowUpTurn,
  type ScriptedTurn,
  scriptedUpstream,
} from "./fixtures/openai-sse.js";

const MODEL_ID = "baize-test-model";
// 供应商 SDK 自己那层重试会把上游的 503 吞掉，设成 0 才冒得到 Pi 的重试层。
const RETRY_TO_PI: RunnerConfig["settings"] = {
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 10, provider: { maxRetries: 0 } },
};

const SUITE_STARTED_AT = Date.now();

/** 一条分配给 bot-1 的工具连接。不给 url 就指向一个没人听的地址，工具真被调用时会连不上。 */
const toolConnection = (
  operations: ReadonlyArray<Pick<ToolOperation, "name" | "needsApproval">>,
  overrides: Partial<Pick<ToolConnectionConfig, "id" | "name" | "url" | "authorization" | "assignedBotIds">> = {},
): ToolConnectionConfig => ({
  id: "tc-1" as ToolConnectionConfig["id"],
  ownerId: "user-1" as ToolConnectionConfig["ownerId"],
  name: "客服工具",
  url: "http://127.0.0.1:9/mcp",
  operations: operations.map((op) => ({ ...op, description: "", inputSchema: {} })),
  assignedBotIds: [BotId.parse("bot-1")],
  authorization: null,
  ...overrides,
});

const promptMessage = (
  botId: string,
  runId: string,
  text: string,
  group?: {
    readonly task?: TopicTask;
    readonly members?: readonly GroupMember[];
    readonly handoffId?: string;
  },
): PromptMessage => ({
  type: "prompt",
  runId: RunId.parse(runId),
  botId: BotId.parse(botId),
  groupId: GroupId.parse("group-1"),
  text,
  origin: { kind: "user" },
  group: {
    id: GroupId.parse("group-1"),
    number: "",
    title: botId,
    kind: (group?.members?.length ?? 1) > 1 ? "team" : "solo",
  },
  context: [],
  task: group?.task ?? null,
  members: [...(group?.members ?? [member(botId, botId)])],
  ...(group?.handoffId === undefined ? {} : { handoffId: HandoffId.parse(group.handoffId) }),
});

const member = (botId: string, name: string): GroupMember => ({
  id: BotId.parse(botId),
  name,
  tag: "",
  description: "",
});
/** 两个 Bot 的群。bot-1 是跑这次 prompt 的那个，bot-2 是它能 @ 的队友。 */
const TWO_MEMBERS: readonly GroupMember[] = [member("bot-1", "小白"), member("bot-2", "小黑")];

const topicTask = (overrides: Partial<TopicTask> = {}): TopicTask => ({
  id: TaskId.parse("task-1"),
  groupId: GroupId.parse("group-1"),
  number: "T-2482",
  title: "给老客户回一封询价邮件",
  summary: "先翻历史邮件再动笔",
  dueAt: "2026-09-20T10:00:00.000Z",
  checklist: [
    { text: "翻历史邮件", done: true, ownerBotId: BotId.parse("bot-1") },
    { text: "起草回信", done: false, ownerBotId: null },
  ],
  currentBotId: BotId.parse("bot-1"),
  handled: [],
  status: "active",
  ...overrides,
});

const skillOf = (id: string, botId: string, name: string, steps: readonly string[]): Skill => ({
  id: SkillId.parse(id),
  botId: BotId.parse(botId),
  name,
  source: "chat",
  steps: [...steps],
  useCount: 0,
  createdAt: "2026-09-13T08:00:00.000Z",
});

const GLOBEX_SKILL = skillOf("skill-globex", "bot-1", "Globex 报价", [
  "打开 CRM 找到 Globex 的联系人",
  "按上季度的价目表算一版报价",
  "把报价贴进邮件草稿",
]);
const WEEKLY_SKILL = skillOf("skill-weekly", "bot-1", "周报", ["翻一遍本周的群消息", "按项目分段写成周报"]);

const skillsDirOf = (dataDir: string, botId: string): string => botDirs(dataDir, BotId.parse(botId)).skillsDir;

const skillIdsOn = (dataDir: string, botId: string): string[] => readdirSync(skillsDirOf(dataDir, botId)).toSorted();

const skillFileOn = (dataDir: string, botId: string, skillId: string): string =>
  readFileSync(join(skillsDirOf(dataDir, botId), skillId, "SKILL.md"), "utf8");

const PROPOSE_ARGS = {
  name: "Globex 报价",
  steps: ["打开 CRM 找到 Globex 的联系人", "按上季度的价目表算一版报价", "把报价贴进邮件草稿"],
};

/** 假上游按请求里出现过的字眼分派脚本，一次 prompt 的第二轮一律空着收尾。 */
const scriptBy = (turns: ReadonlyArray<readonly [marker: string, turn: ScriptedTurn]>) => {
  const follow: ScriptedTurn = { textChunks: [], usage: { input: 900, output: 8 } };
  return (req: ChatCompletionRequest): ScriptedTurn => {
    if (isFollowUpTurn(req)) return follow;
    const body = JSON.stringify(req.messages);
    const hit = turns.find(([marker]) => body.includes(marker));
    if (!hit) throw new Error(`假上游没有匹配的脚本：${body.slice(0, 200)}`);
    return hit[1];
  };
};

/** 和 scriptBy 一样分派，另外把头一轮的整份 messages 和工具结果回到模型那一轮时的内容收下来。 */
const scriptRecording = (
  seen: { firstTurn: string[]; toolResults: string[] },
  turns: ReadonlyArray<readonly [marker: string, turn: ScriptedTurn]>,
) => {
  const dispatch = scriptBy(turns);
  return (req: ChatCompletionRequest): ScriptedTurn => {
    if (isFollowUpTurn(req)) seen.toolResults.push(JSON.stringify(req.messages.filter((m) => m.role === "tool")));
    else seen.firstTurn.push(JSON.stringify(req.messages));
    return dispatch(req);
  };
};

const recorder = (): { firstTurn: string[]; toolResults: string[] } => ({ firstTurn: [], toolResults: [] });

/** 头一轮只点一个工具，不说话。 */
const callTool = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
  textChunks: [],
  toolCall: { id: "call-1", name, args },
  usage: { input: 800, output: 30 },
});

interface Harness {
  readonly runner: Runner;
  readonly sent: AgentToControl[];
  readonly sideEffects: string[];
  readonly gateway: Gateway;
  readonly dataDir: string;
  close(): Promise<void>;
}

const open: Harness[] = [];
// 临时目录留到最后一条用例，好让「~/.pi 没被写」的断言先证明自己能看见新文件。
const usedDataDirs: string[] = [];

function sendEmailTool(sideEffects: string[]): RunnerTool {
  return {
    name: "send_email",
    label: "发邮件",
    description: "给客户发一封邮件。",
    parameters: Type.Object({ to: Type.String() }),
    execute: async (_callId, params) => {
      sideEffects.push(`send_email:${(params as { to: string }).to}`);
      return { content: [{ type: "text", text: "已发送" }], details: {} };
    },
  };
}

function listFilesTool(sideEffects: string[]): RunnerTool {
  return {
    name: "list_files",
    label: "列文件",
    description: "列出一个目录下的文件。",
    parameters: Type.Object({ dir: Type.String() }),
    execute: async (_callId, params) => {
      sideEffects.push(`list_files:${(params as { dir: string }).dir}`);
      return { content: [{ type: "text", text: "有 report.md" }], details: {} };
    },
  };
}

async function startHarness(options: {
  readonly bots: readonly string[];
  readonly tools?: readonly ToolConnectionConfig[];
  /** 不给就挂 send_email、list_files 两个假扩展工具。 */
  readonly extensionTools?: readonly RunnerTool[];
  readonly script: (req: ChatCompletionRequest) => ScriptedTurn;
  readonly failFirst?: number;
  readonly failStatus?: 401 | 503;
  readonly failMessage?: string;
  /** 收到 approval_request 就按这个结论回，undefined 表示不给结论。 */
  readonly approve?: boolean;
  readonly settings?: RunnerConfig["settings"];
  readonly skills?: readonly Skill[];
  /** 每个 Bot 的描述，进系统提示。 */
  readonly description?: string;
  /** 复用上一台的数据目录，用来模拟同一台云电脑上又来一条 config。 */
  readonly dataDir?: string;
}): Promise<Harness> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "baize-runner-"));
  usedDataDirs.push(dataDir);
  const gateway = await startGateway({
    upstream: scriptedUpstream(options.script),
    models: [{ id: MODEL_ID }],
    ...(options.failFirst === undefined ? {} : { failFirst: options.failFirst }),
    ...(options.failStatus === undefined ? {} : { failStatus: options.failStatus }),
    ...(options.failMessage === undefined ? {} : { failMessage: options.failMessage }),
  });

  const sent: AgentToControl[] = [];
  const sideEffects: string[] = [];
  let runner: Runner | null = null;

  runner = createRunner({
    bots: options.bots.map((id) => ({
      id: BotId.parse(id),
      name: id,
      tag: "",
      description: options.description ?? "",
    })),
    tools: options.tools ?? [],
    modelGateway: { baseUrl: gateway.baseUrl, apiKey: "test-key", model: MODEL_ID },
    dataDir,
    ...(options.skills === undefined ? {} : { skills: [...options.skills] }),
    extensionTools: options.extensionTools ?? [sendEmailTool(sideEffects), listFilesTool(sideEffects)],
    send: (message) => {
      sent.push(AgentToControl.parse(message));
      if (message.type === "approval_request" && options.approve !== undefined) {
        runner?.approve(message.runId, message.callId, options.approve);
      }
    },
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });

  const harness: Harness = {
    runner,
    sent,
    sideEffects,
    gateway,
    dataDir,
    async close() {
      await runner?.stop();
      await gateway.close();
    },
  };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

afterAll(() => {
  for (const dir of usedDataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(ready: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs}ms 还没等到${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const shape = (sent: readonly AgentToControl[]): string[] =>
  sent.map((m) =>
    m.type === "bot_tool_call" ? `bot_tool_call:${m.status}` : m.type === "bot_text" ? `bot_text:${m.done}` : m.type,
  );

const sessionFilesOf = (dataDir: string, botId: string): string[] => {
  const dir = botDirs(dataDir, BotId.parse(botId)).sessionDir;
  return readdirSync(dir).map((name) => join(dir, name));
};

const headerCwdOf = (file: string): string =>
  (JSON.parse((readFileSync(file, "utf8").split("\n")[0] ?? "").trim()) as { cwd: string }).cwd;

function filesNewerThan(dir: string, since: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return [];
    if (stat.isDirectory()) return filesNewerThan(path, since);
    return stat.mtimeMs > since ? [path] : [];
  });
}

describe("运行器跑一次 prompt", () => {
  it("报文序列是 bot_text 若干、bot_tool_call 两条、run_done，全过 AgentToControl.parse", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([
        [
          "列目录",
          {
            textChunks: ["先看看", "目录。"],
            toolCall: { id: "call-1", name: "list_files", args: { dir: "/work" } },
            usage: { input: 800, output: 40 },
          },
        ],
      ]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "列目录"));

    expect(shape(h.sent)).toEqual([
      "bot_text:false",
      "bot_text:false",
      "bot_text:true",
      "bot_tool_call:running",
      "bot_tool_call:ok",
      "run_done",
    ]);
    const done = h.sent.at(-1);
    expect(done?.type === "run_done" && done.steps).toBe(2);
    expect(h.sideEffects).toEqual(["list_files:/work"]);
  });

  it("config 里没有的 botId 回 agent_error，带上这条 prompt 的群号", async () => {
    const h = await startHarness({ bots: ["bot-1"], script: scriptBy([]) });

    await h.runner.prompt(promptMessage("bot-别的", "run-x", "列目录"));

    expect(shape(h.sent)).toEqual(["agent_error"]);
    const error = h.sent[0];
    expect(error?.type === "agent_error" && error.groupId).toBe("group-1");
    expect(h.gateway.requestCount()).toBe(0);
  });

  // 关掉内置工具的话「看看电脑里有哪些文件」一件也做不了：bash 没注册，模型点它只会拿到一条错误工具结果。
  it("Pi 的内置 bash 工具是开着的，命令真的在 Bot 的 work 目录里跑了", async () => {
    const toolResults: string[] = [];
    const h = await startHarness({
      bots: ["bot-1"],
      script: (req) => {
        if (!isFollowUpTurn(req)) {
          return {
            textChunks: [],
            toolCall: { id: "call-1", name: "bash", args: { command: "ls" } },
            usage: { input: 800, output: 20 },
          };
        }
        toolResults.push(JSON.stringify(req.messages.filter((m) => m.role === "tool")));
        return { textChunks: ["有 ", "report.md。"], usage: { input: 900, output: 12 } };
      },
    });
    const { workDir } = botDirs(h.dataDir, BotId.parse("bot-1"));
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "report.md"), "报告\n");

    await h.runner.prompt(promptMessage("bot-1", "run-1", "看看电脑里有哪些文件"));

    expect(shape(h.sent)).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
      "bot_text:false",
      "bot_text:false",
      "bot_text:true",
      "run_done",
    ]);
    expect(toolResults.join(""), "ls 的真实输出要回到模型那一轮").toContain("report.md");
  });
});

describe("运行器的审批", () => {
  const approvalScript = scriptBy([
    [
      "发邮件",
      {
        textChunks: ["这就发。"],
        toolCall: { id: "call-1", name: "send_email", args: { to: "kehu@example.com" } },
        usage: { input: 1200, output: 64 },
      },
    ],
  ]);
  const tools = [toolConnection([{ name: "send_email", needsApproval: true }])];

  it("审批还挂着的时候 pause，挂起的审批当拒绝收尾，pause 不会卡住", async () => {
    const h = await startHarness({ bots: ["bot-1"], tools, script: approvalScript });

    const running = h.runner.prompt(promptMessage("bot-1", "run-1", "发邮件"));
    await until(() => h.sent.some((m) => m.type === "approval_request"), "approval_request");
    expect(h.runner.activeRuns()).toEqual([RunId.parse("run-1")]);
    await h.runner.pause(BotId.parse("bot-1"));
    await running;

    expect(h.sideEffects, "没人批过，工具体不该执行").toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:blocked",
    ]);
    expect(h.runner.activeRuns()).toEqual([]);
  }, 10_000);

  it("approve(false) 之后 bot_tool_call 终态是 blocked，工具体没执行", async () => {
    const h = await startHarness({ bots: ["bot-1"], tools, script: approvalScript, approve: false });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "发邮件"));

    const request = h.sent.find((m) => m.type === "approval_request");
    expect(request?.type === "approval_request" && request.kind).toBe("send_external");
    expect(request?.type === "approval_request" && request.tool).toBe("send_email");
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:blocked",
    ]);
    expect(h.sideEffects, "被拒绝的调用不该进工具函数体").toEqual([]);
  });

  it("approve(true) 之后终态是 ok，工具体执行了", async () => {
    const h = await startHarness({ bots: ["bot-1"], tools, script: approvalScript, approve: true });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "发邮件"));

    expect(h.sent.some((m) => m.type === "approval_request")).toBe(true);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
    ]);
    expect(h.sideEffects).toEqual(["send_email:kehu@example.com"]);
  });

  it("没在任何工具连接里出现的工具不进审批", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      tools: [toolConnection([{ name: "send_email", needsApproval: true }])],
      script: scriptBy([
        [
          "列目录",
          {
            textChunks: ["看看。"],
            toolCall: { id: "call-1", name: "list_files", args: { dir: "/work" } },
            usage: { input: 800, output: 40 },
          },
        ],
      ]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "列目录"));

    expect(h.sent.some((m) => m.type === "approval_request")).toBe(false);
    expect(h.sideEffects).toEqual(["list_files:/work"]);
  });
});

describe("运行器里的两个 Bot", () => {
  it("同时 prompt 时各自的会话目录和会话 cwd 都不同", async () => {
    const h = await startHarness({
      bots: ["bot-1", "bot-2"],
      script: scriptBy([
        ["甲的活", { textChunks: ["甲干完了。"], usage: { input: 100, output: 5 } }],
        ["乙的活", { textChunks: ["乙干完了。"], usage: { input: 200, output: 6 } }],
      ]),
    });

    await Promise.all([
      h.runner.prompt(promptMessage("bot-1", "run-1", "甲的活")),
      h.runner.prompt(promptMessage("bot-2", "run-2", "乙的活")),
    ]);

    const [fileA] = sessionFilesOf(h.dataDir, "bot-1");
    const [fileB] = sessionFilesOf(h.dataDir, "bot-2");
    expect(fileA, "bot-1 应有会话文件").toBeDefined();
    expect(fileB, "bot-2 应有会话文件").toBeDefined();
    expect(fileA).not.toBe(fileB);
    expect(headerCwdOf(fileA as string)).toBe(botDirs(h.dataDir, BotId.parse("bot-1")).workDir);
    expect(headerCwdOf(fileB as string)).toBe(botDirs(h.dataDir, BotId.parse("bot-2")).workDir);
    const doneBots = h.sent.filter((m) => m.type === "run_done").map((m) => m.botId);
    expect(doneBots).toHaveLength(2);
    expect(doneBots).toContain("bot-1");
    expect(doneBots).toContain("bot-2");
  });
});

describe("运行器的暂停和继续", () => {
  const pauseScript = scriptBy([["干活", { textChunks: ["干完了。"], usage: { input: 100, output: 5 } }]]);

  it("pause 之后的 prompt 不上网关，resume 之后补跑", async () => {
    const h = await startHarness({ bots: ["bot-1"], script: pauseScript });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "干活"));
    const requestsBeforePause = h.gateway.requestCount();
    h.sent.length = 0;

    await h.runner.pause(BotId.parse("bot-1"));
    await h.runner.prompt(promptMessage("bot-1", "run-2", "干活"));

    expect(h.runner.activeRuns()).toEqual([RunId.parse("run-2")]);
    expect(h.sent, "暂停期间不该有任何上行报文").toEqual([]);
    expect(h.gateway.requestCount()).toBe(requestsBeforePause);

    await h.runner.resume(BotId.parse("bot-1"));

    expect(h.sent.filter((m) => m.type === "run_done").map((m) => m.runId)).toEqual(["run-2"]);
    expect(h.runner.activeRuns()).toEqual([]);
    expect(h.gateway.requestCount()).toBeGreaterThan(requestsBeforePause);
  });

  it("resume 之后新来的 prompt 照常跑", async () => {
    const h = await startHarness({ bots: ["bot-1"], script: pauseScript });

    await h.runner.pause(BotId.parse("bot-1"));
    await h.runner.resume(BotId.parse("bot-1"));
    await h.runner.prompt(promptMessage("bot-1", "run-1", "干活"));

    expect(h.sent.filter((m) => m.type === "run_done").map((m) => m.runId)).toEqual(["run-1"]);
  });
});

describe("上游重试", () => {
  it("前两次补全返 503 后成功，不上报模型错误，run_done 只发一条", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([["干活", { textChunks: ["重试之后才说的话。"], usage: { input: 300, output: 9 } }]]),
      failFirst: 2,
      settings: RETRY_TO_PI,
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "干活"));

    expect(h.gateway.requestCount()).toBe(3);
    expect(h.sent.filter((message) => message.type === "agent_error")).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === "run_done")).toHaveLength(1);
    expect(h.sent.at(-1)?.type).toBe("run_done");
    expect(h.sent.some((m) => m.type === "bot_text" && m.delta === "重试之后才说的话。")).toBe(true);
  });
});

describe("模型上游报错", () => {
  it("401 回合上报一次 model_failed，仍发送 run_done 收尾", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([]),
      failFirst: 10,
      failStatus: 401,
      failMessage: `401 Unauthorized ${"x".repeat(600)}`,
      settings: RETRY_TO_PI,
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "查一条订单"));

    expect(h.sent.filter((message) => message.type === "run_done")).toHaveLength(1);
    const errors = h.sent.filter((message) => message.type === "agent_error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "agent_error", code: "model_failed", groupId: "group-1" });
    expect(errors[0]?.type === "agent_error" && errors[0].detail).toContain("401");
    expect(errors[0]?.type === "agent_error" && errors[0].detail).toHaveLength(500);
    expect(
      h.sent
        .filter((message) => message.type === "agent_error" || message.type === "run_done")
        .map((message) => message.type),
    ).toEqual(["agent_error", "run_done"]);
  });
});

describe("运行器的主题任务工具", () => {
  it("renderTaskCard 每个字段都渲染一行，经手的 id 按群成员名单解析成名字", () => {
    expect(renderTaskCard(topicTask(), TWO_MEMBERS)).toBe(
      [
        "T-2482 给老客户回一封询价邮件",
        "说明：先翻历史邮件再动笔",
        "截止：2026-09-20T10:00:00.000Z",
        "当前经手：小白",
        "群成员：小白、小黑",
        "清单：",
        "1. [x] 翻历史邮件（经手：小白）",
        "2. [ ] 起草回信（经手：未指派）",
      ].join("\n"),
    );
  });

  it("renderTaskCard 的空值走固定占位词，名单里没有的 id 原样保留", () => {
    const sparse = topicTask({
      summary: "",
      dueAt: null,
      currentBotId: null,
      checklist: [{ text: "对账", done: false, ownerBotId: BotId.parse("bot-9") }],
    });

    expect(renderTaskCard(sparse, TWO_MEMBERS)).toBe(
      [
        "T-2482 给老客户回一封询价邮件",
        "说明：无",
        "截止：不限",
        "当前经手：未指派",
        "群成员：小白、小黑",
        "清单：",
        "1. [ ] 对账（经手：bot-9）",
      ].join("\n"),
    );
    expect(renderTaskCard(topicTask({ checklist: [] }), TWO_MEMBERS), "空清单也要占一行，不能整节消失").toContain(
      "清单：\n（空）",
    );
  });

  it("update_checklist 上报一条 task_checklist，经手的名字解析成 id，没给经手的补成 null", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [
        [
          "把清单过一遍",
          callTool("update_checklist", {
            items: [
              { text: "翻历史邮件", done: true, ownerBotId: "小白" },
              { text: "起草回信", done: false },
            ],
          }),
        ],
      ]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "把清单过一遍", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "task_checklist"),
      "一次调用恰好一条 task_checklist，卡片上的名字解析成 id 上行，缺省的经手补成 null",
    ).toEqual([
      {
        type: "task_checklist",
        runId: "run-1",
        botId: "bot-1",
        groupId: "group-1",
        checklist: [
          { text: "翻历史邮件", done: true, ownerBotId: "bot-1" },
          { text: "起草回信", done: false, ownerBotId: null },
        ],
      },
    ]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
    ]);
    expect(seen.toolResults.join(""), "返回值报完成进度").toContain("清单已更新，1/2 完成");
  });

  it("update_checklist 的经手不在群里：不上报，终态 failed，错误文本列出群成员的名字", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [
        ["把清单过一遍", callTool("update_checklist", { items: [{ text: "对账", done: false, ownerBotId: "小灰" }] })],
      ]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "把清单过一遍", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "task_checklist"),
      "BotId 只是带牌子的字符串，猜出来的经手不拦住就会当合法数据发到控制面",
    ).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
    expect(seen.toolResults.join(""), "错误文本要把该写的名字告诉模型").toContain("小白、小黑");
  });

  it("update_checklist 原样抄回卡片上名单外的 id：认，不拦", async () => {
    const departed = topicTask({ checklist: [{ text: "对账", done: false, ownerBotId: BotId.parse("bot-9") }] });
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([
        ["把清单过一遍", callTool("update_checklist", { items: [{ text: "对账", done: true, ownerBotId: "bot-9" }] })],
      ]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "把清单过一遍", { task: departed, members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "task_checklist").map((m) => m.type === "task_checklist" && m.checklist),
      "经手已经退群时卡片渲染的是 id，模型读改写会原样抄回来，拦住它就把正常的读改写打挂了",
    ).toEqual([[{ text: "对账", done: true, ownerBotId: "bot-9" }]]);
  });

  it("mention_bot 用群里没有的名字：不上报，终态 failed，错误文本列出可以 @ 的名字", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["叫个人来", callTool("mention_bot", { name: "小灰", text: "帮我看一眼" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "叫个人来", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "mention"),
      "名字对不上就不该有 mention 上行",
    ).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
    const results = seen.toolResults.join("");
    expect(results, "错误文本要把能 @ 的名字告诉模型，否则它只能瞎猜").toContain("小黑");
    expect(results, "自己不在可以 @ 的名单里").not.toContain("小白");
  });

  it("mention_bot 用群里有的名字：mention 上行带被 @ 的 botId 和原文", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([["叫个人来", callTool("mention_bot", { name: "小黑", text: "这单报价你帮我核一下" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "叫个人来", { task: topicTask(), members: TWO_MEMBERS }));

    expect(h.sent.filter((m) => m.type === "mention")).toEqual([
      {
        type: "mention",
        runId: "run-1",
        botId: "bot-1",
        groupId: "group-1",
        targetBotId: "bot-2",
        text: "这单报价你帮我核一下",
      },
    ]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
    ]);
  });

  it("mention_bot @ 自己：不上报，终态 failed", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([["叫个人来", callTool("mention_bot", { name: "小白", text: "自言自语" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "叫个人来", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "mention"),
      "@ 自己不该在群里产生一条 mention",
    ).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
  });

  it("read_task 在没有任务卡的群里回一句话说没有", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["看看任务", callTool("read_task", {})]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "看看任务"));

    expect(seen.toolResults.join(""), "task 为 null 时固定回这句").toContain("这个群没有任务卡");
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
    ]);
  });

  it("read_task 在有任务卡的群里回整张卡片", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["看看任务", callTool("read_task", {})]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "看看任务", { task: topicTask(), members: TWO_MEMBERS }));

    // 整张卡片逐行对，钉住 read_task 和 prompt 共用 renderTaskCard。卡片本身的格式由上面两条写死的用例管着。
    const card = renderTaskCard(topicTask(), TWO_MEMBERS);
    const results = seen.toolResults.join("");
    for (const line of card.split("\n")) {
      expect(results, `卡片里应有「${line}」这一行`).toContain(line);
    }
  });

  it("task 不为 null 时任务卡进了送给模型的第一轮请求", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["按卡片往下做", { textChunks: ["好。"], usage: { input: 800, output: 5 } }]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "按卡片往下做", { task: topicTask(), members: TWO_MEMBERS }));

    const firstTurn = seen.firstTurn.join("");
    expect(firstTurn, "任务卡要以「任务卡：」开头的一段送进去").toContain("任务卡：");
    expect(firstTurn, "编号要送到模型那里，Bot 才引用得了这张卡").toContain("T-2482");
    expect(firstTurn, "标题要送到模型那里").toContain("给老客户回一封询价邮件");
    expect(firstTurn.indexOf("任务卡："), "卡片排在当前这条之前，群里的闲聊不该把目标挤到后面").toBeLessThan(
      firstTurn.indexOf("按卡片往下做"),
    );
  });

  // composePrompt 有没有 context 是两条分支，上一条只走空 context 那条，这条走另一条。
  it("有群聊上下文时任务卡仍在最前，排在「群里刚才说的」之前", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["按卡片往下做", { textChunks: ["好。"], usage: { input: 800, output: 5 } }]]),
    });

    await h.runner.prompt({
      ...promptMessage("bot-1", "run-1", "按卡片往下做", { task: topicTask(), members: TWO_MEMBERS }),
      context: [{ from: "小黑", text: "客户刚又催了一遍" }],
    });

    const firstTurn = seen.firstTurn.join("");
    expect(firstTurn, "群聊上下文照常送").toContain("客户刚又催了一遍");
    expect(firstTurn.indexOf("任务卡："), "卡片在群聊上下文之前").toBeLessThan(firstTurn.indexOf("群里刚才说的："));
    expect(firstTurn.indexOf("群里刚才说的："), "群聊上下文在当前这条之前").toBeLessThan(
      firstTurn.indexOf("当前这条："),
    );
  });
});

describe("运行器的交接工具", () => {
  const handoffArgs = {
    to: "小黑",
    done: "翻完历史邮件，价格口径跟财务对过了",
    notDone: "回信还没起草",
    next: "照 2023 年那版模板起草，周五前发出去",
    checklistIndex: 2,
  };

  it("handoff_task 上报整条交接报文，清单指针从卡片上的序号换成下标", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["交给小黑", callTool("handoff_task", handoffArgs)]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "交给小黑", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "handoff"),
      "卡片上第 2 条在协议里是下标 1，不换算就指到隔壁那条了",
    ).toEqual([
      {
        type: "handoff",
        runId: "run-1",
        botId: "bot-1",
        groupId: "group-1",
        toBotId: "bot-2",
        done: handoffArgs.done,
        notDone: handoffArgs.notDone,
        next: handoffArgs.next,
        checklistIndex: 1,
      },
    ]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
    ]);
    expect(seen.toolResults.join(""), "返回值要点名在等谁确认").toContain("已发交接报文给小黑，等它确认。");
  });

  it("handoff_task 不给清单指针时上行补成 null", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([["交给小黑", callTool("handoff_task", { ...handoffArgs, checklistIndex: undefined })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "交给小黑", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "handoff").map((m) => m.type === "handoff" && m.checklistIndex),
      "协议里 checklistIndex 是可空不是可省，缺省在这个边界补成 null",
    ).toEqual([null]);
  });

  it("handoff_task 由非当前经手发起：不上报，终态 failed，错误文本说出当前经手是谁", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["交给小黑", callTool("handoff_task", handoffArgs)]]),
    });

    await h.runner.prompt(
      promptMessage("bot-1", "run-1", "交给小黑", {
        task: topicTask({ currentBotId: BotId.parse("bot-2") }),
        members: TWO_MEMBERS,
      }),
    );

    expect(
      h.sent.filter((m) => m.type === "handoff"),
      "手里没活的 Bot 交接出去，控制面收到的就是一条改别人经手的报文",
    ).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
    expect(seen.toolResults.join(""), "错误文本要告诉模型当前经手是谁").toContain("当前经手是小黑");
  });

  it("handoff_task 交给自己：不上报，终态 failed", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([["交给小黑", callTool("handoff_task", { ...handoffArgs, to: "小白" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "交给小黑", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "handoff"),
      "交给自己不该产生一条交接",
    ).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
  });

  // 清单有两条，0 是模型误当成下标写的，5 是它凭空编的。
  for (const bad of [0, 5]) {
    it(`handoff_task 的清单指针 ${bad} 落在清单之外：不上报，终态 failed，错误文本给出清单长度`, async () => {
      const seen = recorder();
      const h = await startHarness({
        bots: ["bot-1"],
        script: scriptRecording(seen, [
          ["交给小黑", callTool("handoff_task", { ...handoffArgs, checklistIndex: bad })],
        ]),
      });

      await h.runner.prompt(promptMessage("bot-1", "run-1", "交给小黑", { task: topicTask(), members: TWO_MEMBERS }));

      expect(
        h.sent.filter((m) => m.type === "handoff"),
        "指到不存在的清单项，接手的 Bot 拿到的就是一条查无此条的交接",
      ).toEqual([]);
      expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
        "bot_tool_call:running",
        "bot_tool_call:failed",
      ]);
      expect(seen.toolResults.join(""), "错误文本要给出清单长度，模型才知道该写几").toContain("清单一共 2 条");
    });
  }

  it("handoff_task 在没有任务卡的群里：不上报，终态 failed", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["交给小黑", callTool("handoff_task", handoffArgs)]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "交给小黑", { members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "handoff"),
      "没有任务卡就没有当前经手，交接无从谈起",
    ).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
    expect(seen.toolResults.join(""), "错误文本要说明这个群没有任务卡").toContain("这个群没有任务卡");
  });

  it("handoff_task 交给群里没有的名字：不上报，终态 failed，错误文本列出可以交接给谁", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["交给小黑", callTool("handoff_task", { ...handoffArgs, to: "小灰" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "交给小黑", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "handoff"),
      "名字对不上就不该有 handoff 上行",
    ).toEqual([]);
    const results = seen.toolResults.join("");
    expect(results, "错误文本要把能交接给谁告诉模型，否则它只能瞎猜").toContain("可以交接给的是：小黑");
    expect(results, "自己不在可以交接的名单里").not.toContain("小白");
  });

  it("accept_handoff 在带 handoffId 的 prompt 里：上报 handoff_accept，带这条 prompt 的 handoffId", async () => {
    const h = await startHarness({
      bots: ["bot-2"],
      script: scriptBy([["接一下", callTool("accept_handoff", {})]]),
    });

    await h.runner.prompt(
      promptMessage("bot-2", "run-1", "接一下", {
        task: topicTask(),
        members: TWO_MEMBERS,
        handoffId: "handoff-1",
      }),
    );

    expect(h.sent.filter((m) => m.type === "handoff_accept")).toEqual([
      { type: "handoff_accept", runId: "run-1", botId: "bot-2", groupId: "group-1", handoffId: "handoff-1" },
    ]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
    ]);
  });

  it("accept_handoff 在不带 handoffId 的 prompt 里：不上报，终态 failed", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["接一下", callTool("accept_handoff", {})]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "接一下", { task: topicTask(), members: TWO_MEMBERS }));

    expect(
      h.sent.filter((m) => m.type === "handoff_accept"),
      "没有交接可接时的确认，控制面拿不到 handoffId，只能是一条脏报文",
    ).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
    expect(seen.toolResults.join(""), "错误文本要说明这次没有可接的交接").toContain("这次没有要你接手的交接");
  });

  it("带 handoffId 的 prompt：交接报文单成一段排在任务卡之后，并让它先确认接手", async () => {
    const body = "小白交给你。做了什么：翻完历史邮件。没做什么：回信没起草。下一步：照模板起草。";
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-2"],
      script: scriptRecording(seen, [[body, { textChunks: ["好。"], usage: { input: 800, output: 5 } }]]),
    });

    await h.runner.prompt(
      promptMessage("bot-2", "run-1", body, { task: topicTask(), members: TWO_MEMBERS, handoffId: "handoff-1" }),
    );

    const firstTurn = seen.firstTurn.join("");
    expect(firstTurn, "交接报文正文要原样送进去").toContain(body);
    expect(firstTurn, "贴上标签，模型才不会把它当成群里又一句闲话").toContain("交接报文：");
    expect(firstTurn, "要点名先确认接手再动手").toContain("先调用 accept_handoff 确认接手");
    expect(firstTurn.indexOf("任务卡："), "任务卡仍排在最前").toBeLessThan(firstTurn.indexOf("交接报文："));
    expect(firstTurn, "正文已经是交接报文那一段，不再重复成「当前这条」").not.toContain("当前这条：");
  });

  // composePrompt 有没有 context 是两条分支，上一条只走空 context 那条，这条走另一条。
  it("带 handoffId 又有群聊上下文时，交接报文夹在任务卡和群聊之间", async () => {
    const body = "小白交给你。做了什么：翻完历史邮件。没做什么：回信没起草。下一步：照模板起草。";
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-2"],
      script: scriptRecording(seen, [[body, { textChunks: ["好。"], usage: { input: 800, output: 5 } }]]),
    });

    await h.runner.prompt({
      ...promptMessage("bot-2", "run-1", body, { task: topicTask(), members: TWO_MEMBERS, handoffId: "handoff-1" }),
      context: [{ from: "小白", text: "客户刚又催了一遍" }],
    });

    const firstTurn = seen.firstTurn.join("");
    expect(firstTurn, "群聊上下文照常送").toContain("客户刚又催了一遍");
    expect(firstTurn.indexOf("任务卡："), "任务卡仍排在最前").toBeLessThan(firstTurn.indexOf("交接报文："));
    expect(firstTurn.indexOf("交接报文："), "交接报文排在群聊之前，不被闲聊挤远").toBeLessThan(
      firstTurn.indexOf("群里刚才说的："),
    );
    expect(firstTurn, "正文已经是交接报文那一段，不再重复成「当前这条」").not.toContain("当前这条：");
  });
});

describe("运行器的 skill", () => {
  const GLOBEX_FILE = [
    "---",
    'name: "Globex 报价"',
    'description: "打开 CRM 找到 Globex 的联系人"',
    "---",
    "",
    "# Globex 报价",
    "",
    "1. 打开 CRM 找到 Globex 的联系人",
    "2. 按上季度的价目表算一版报价",
    "3. 把报价贴进邮件草稿",
    "",
  ].join("\n");

  it("config 带两个 skill：落成两个 SKILL.md，两条都进了系统提示的 available_skills", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      skills: [GLOBEX_SKILL, WEEKLY_SKILL],
      script: scriptRecording(seen, [["随便说句话", { textChunks: ["好"], usage: { input: 800, output: 2 } }]]),
    });

    expect(skillIdsOn(h.dataDir, "bot-1"), "目录名就是 skillId，一条一个目录").toEqual([
      "skill-globex",
      "skill-weekly",
    ]);
    expect(
      skillFileOn(h.dataDir, "bot-1", "skill-globex"),
      "frontmatter 的 description 用第一步，正文是编号的步骤",
    ).toBe(GLOBEX_FILE);

    await h.runner.prompt(promptMessage("bot-1", "run-1", "随便说句话"));

    const systemPrompt = seen.firstTurn.join("");
    expect(systemPrompt, "Pi 把 getSkills 的结果 formatSkillsForPrompt 进系统提示").toContain("<available_skills>");
    expect(systemPrompt, "两条都被 getSkills 列出来了才会都出现在提示里").toContain("Globex 报价");
    expect(systemPrompt).toContain("周报");
    expect(systemPrompt, "提示里给的是文件位置，模型照着名字去读步骤").toContain("skill-globex");
  });

  it("再来一条少一个 skill 的 config：盘上多出来的那个被删掉", async () => {
    const first = await startHarness({
      bots: ["bot-1"],
      skills: [GLOBEX_SKILL, WEEKLY_SKILL],
      script: scriptBy([]),
    });
    await startHarness({
      bots: ["bot-1"],
      dataDir: first.dataDir,
      skills: [GLOBEX_SKILL],
      script: scriptBy([]),
    });

    expect(skillIdsOn(first.dataDir, "bot-1"), "控制面的表是真相源，config 里没有的盘上也不能留着").toEqual([
      "skill-globex",
    ]);
  });

  it("再来一条改了步骤的 config：文件重写成新的；同一份 config 再来一次，文件不动", async () => {
    const first = await startHarness({ bots: ["bot-1"], skills: [GLOBEX_SKILL], script: scriptBy([]) });
    const changed = { ...GLOBEX_SKILL, steps: ["打开 CRM 找到 Globex 的联系人", "按新价目表算一版报价"] };

    await startHarness({ bots: ["bot-1"], dataDir: first.dataDir, skills: [changed], script: scriptBy([]) });

    const file = join(skillsDirOf(first.dataDir, "bot-1"), "skill-globex", "SKILL.md");
    expect(skillFileOn(first.dataDir, "bot-1", "skill-globex"), "同一条 skill 改了步骤，盘上那份要跟着变").toContain(
      "2. 按新价目表算一版报价",
    );
    expect(skillFileOn(first.dataDir, "bot-1", "skill-globex"), "旧步骤不留").not.toContain("按上季度的价目表");

    const before = statSync(file).mtimeMs;
    await startHarness({ bots: ["bot-1"], dataDir: first.dataDir, skills: [changed], script: scriptBy([]) });
    expect(statSync(file).mtimeMs, "内容一样就不重写，重连一次不该把所有 skill 文件翻新一遍").toBe(before);
  });

  it("要写的位置上是个普通文件时，对账把它清掉再落，不炸掉整个 runner", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "baize-runner-"));
    const dirty = skillsDirOf(dataDir, "bot-1");
    mkdirSync(dirty, { recursive: true });
    writeFileSync(join(dirty, "skill-globex"), "上一版留下的脏东西", "utf8");

    const h = await startHarness({ bots: ["bot-1"], dataDir, skills: [GLOBEX_SKILL], script: scriptBy([]) });

    expect(skillFileOn(h.dataDir, "bot-1", "skill-globex"), "对账要能从盘上任何一种状态收敛过来").toBe(GLOBEX_FILE);
  });

  it("别的 Bot 的 skill 不落到自己目录里", async () => {
    const h = await startHarness({
      bots: ["bot-1", "bot-2"],
      skills: [GLOBEX_SKILL, skillOf("skill-duiqi", "bot-2", "对账", ["拉流水", "和账单核一遍"])],
      script: scriptBy([]),
    });

    expect(skillIdsOn(h.dataDir, "bot-1")).toEqual(["skill-globex"]);
    expect(skillIdsOn(h.dataDir, "bot-2"), "config.skills 是全部 Bot 的，运行器按 botId 分").toEqual(["skill-duiqi"]);
  });

  it("skillId 带路径分隔符时不落盘，写不到 dataDir 外面去", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      // shared 的 SkillId 已经不收带分隔符的 id，这里绕过 parse 造一条，证明运行器自己的守卫还在。
      skills: [GLOBEX_SKILL, { ...GLOBEX_SKILL, id: "../../pwned" as Skill["id"], name: "越界", steps: ["一", "二"] }],
      script: scriptBy([]),
    });

    expect(skillIdsOn(h.dataDir, "bot-1"), "目录名只收一段安全的名字，越界的那条整条不落").toEqual(["skill-globex"]);
    expect(existsSync(join(h.dataDir, "pwned")), "上跳两级本该落在这里，一个文件都不该有").toBe(false);
  });

  it("propose_skill 上报整条 skill_offer", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["这件活干完了", callTool("propose_skill", PROPOSE_ARGS)]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "这件活干完了"));

    expect(
      h.sent.filter((m) => m.type === "skill_offer"),
      "存不存由 Bot 发起，控制面据此落一条卡",
    ).toEqual([
      {
        type: "skill_offer",
        runId: "run-1",
        botId: "bot-1",
        groupId: "group-1",
        name: PROPOSE_ARGS.name,
        steps: PROPOSE_ARGS.steps,
      },
    ]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
    ]);
    expect(seen.toolResults.join(""), "返回值要说清还在等用户点").toContain("已经在群里问用户存不存「Globex 报价」了");
  });

  it("同一次运行里第二次 propose_skill：不上报，终态 failed，错误文本说已经问过了", async () => {
    const seen = recorder();
    const twice = (req: ChatCompletionRequest): ScriptedTurn => {
      const answered = req.messages.filter((m) => m.role === "tool").length;
      if (answered === 0) return callTool("propose_skill", PROPOSE_ARGS);
      if (answered === 1) {
        return {
          textChunks: [],
          toolCall: { id: "call-2", name: "propose_skill", args: PROPOSE_ARGS },
          usage: { input: 900, output: 30 },
        };
      }
      return { textChunks: [], usage: { input: 1000, output: 8 } };
    };
    const h = await startHarness({
      bots: ["bot-1"],
      script: (req) => {
        if (req.messages.some((m) => m.role === "tool"))
          seen.toolResults.push(JSON.stringify(req.messages.filter((m) => m.role === "tool")));
        return twice(req);
      },
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "这件活干完了"));

    expect(h.sent.filter((m) => m.type === "skill_offer").length, "一次运行最多问一次，第二次拦在发报文之前").toBe(1);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
    expect(seen.toolResults.join("")).toContain("这次已经问过了");
  });

  it("propose_skill 只给一条步骤：不上报，终态 failed，错误文本给出该写几条", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [
        ["这件活干完了", callTool("propose_skill", { name: "Globex 报价", steps: ["打开 CRM"] })],
      ]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "这件活干完了"));

    expect(
      h.sent.filter((m) => m.type === "skill_offer"),
      "一步的活不成其为 skill，拦在发报文之前",
    ).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
    expect(seen.toolResults.join(""), "错误文本要把该写几条告诉模型").toContain("步骤要 2 到 20 条，这次给了 1 条。");
  });

  it("propose_skill 某一步超过 500 字：本地就拦住，错误文本是中文", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [
        ["这件活干完了", callTool("propose_skill", { name: "Globex 报价", steps: ["打开 CRM", "把".repeat(501)] })],
      ]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "这件活干完了"));

    expect(
      h.sent.filter((m) => m.type === "skill_offer"),
      "上行 schema 也不收，拦在发之前",
    ).toEqual([]);
    expect(seen.toolResults.join(""), "拦在 AgentToControl.parse 之前，模型才不会收到一坨英文 ZodError").toContain(
      "第 2 步有 501 个字，每步最多 500 个",
    );
  });

  it("系统提示里有提议存 skill 的规则，排在 Bot 描述之后", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      description: "只管报价的事，发出去之前先问我",
      script: scriptRecording(seen, [["随便说句话", { textChunks: ["好"], usage: { input: 800, output: 2 } }]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "随便说句话"));

    const systemPrompt = seen.firstTurn.join("");
    const describedAt = systemPrompt.indexOf("只管报价的事，发出去之前先问我");
    const ruleAt = systemPrompt.indexOf("用 propose_skill 把刚才的步骤写成清单");
    expect(describedAt, "描述是 Bot 的边界，得进系统提示").toBeGreaterThan(-1);
    expect(ruleAt, "规则排在描述之后：先知道自己是干什么的，再谈把这件活存下来").toBeGreaterThan(describedAt);
  });

  it("Bot 没写描述时，系统提示里不留一句空的边界", async () => {
    const seen = recorder();
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptRecording(seen, [["随便说句话", { textChunks: ["好"], usage: { input: 800, output: 2 } }]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "随便说句话"));

    const systemPrompt = seen.firstTurn.join("");
    expect(systemPrompt, "描述是空的就整段不占位，不给模型一句「你的描述是：」的空话").not.toContain("你的描述");
    expect(systemPrompt, "规则和描述不绑在一起，没描述照样要有").toContain("用 propose_skill 把刚才的步骤写成清单");
  });
});

describe("运行器按 Bot 加载 MCP 工具", () => {
  const OPS: ReadonlyArray<Pick<ToolOperation, "name" | "needsApproval">> = [
    { name: "send_email", needsApproval: true },
    { name: "lookup_stock", needsApproval: false },
  ];

  /** 和 scriptRecording 一样分派，另外把每轮请求里报给模型的工具名单收下来。 */
  const scriptSeeingTools = (
    seen: { firstTurn: string[]; toolResults: string[]; toolNames: string[][] },
    turns: ReadonlyArray<readonly [marker: string, turn: ScriptedTurn]>,
  ) => {
    const dispatch = scriptRecording(seen, turns);
    return (req: ChatCompletionRequest): ScriptedTurn => {
      seen.toolNames.push((req.tools ?? []).map((tool) => tool.function.name));
      return dispatch(req);
    };
  };
  const toolRecorder = () => ({ ...recorder(), toolNames: [] as string[][] });

  const openMcps: { close(): Promise<void> }[] = [];
  const fakeMcp = async () => {
    const mcp = await startFakeMcp();
    openMcps.push(mcp);
    return mcp;
  };
  afterEach(async () => {
    await Promise.all(openMcps.splice(0).map((mcp) => mcp.close()));
  });

  it("分配了的 Bot：名单里有两个操作，调用 lookup_stock 时假 MCP 收到参数和 Authorization 头，结果文字回到模型", async () => {
    const mcp = await fakeMcp();
    const seen = toolRecorder();
    const h = await startHarness({
      bots: ["bot-1"],
      extensionTools: [],
      tools: [toolConnection(OPS, { url: mcp.url, authorization: "Bearer secret-token" })],
      script: scriptSeeingTools(seen, [["查库存", callTool("lookup_stock", { sku: "SKU-1" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "查库存"));

    expect(seen.toolNames[0]).toEqual(expect.arrayContaining(["send_email", "lookup_stock"]));
    expect(mcp.calls).toEqual([{ name: "lookup_stock", args: { sku: "SKU-1" }, authorization: "Bearer secret-token" }]);
    expect(seen.toolResults[0]).toContain("SKU-1 库存 42");
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:ok",
    ]);
    expect(
      h.sent.some((m) => m.type === "approval_request"),
      "lookup_stock 不需要审批",
    ).toBe(false);
  });

  it("没分配的 Bot：名单里没有这条连接的操作", async () => {
    const mcp = await fakeMcp();
    const seen = toolRecorder();
    const h = await startHarness({
      bots: ["bot-2"],
      extensionTools: [],
      tools: [toolConnection(OPS, { url: mcp.url })],
      script: scriptSeeingTools(seen, [["随便聊", { textChunks: ["好的。"], usage: { input: 100, output: 5 } }]]),
    });

    await h.runner.prompt(promptMessage("bot-2", "run-1", "随便聊"));

    expect(seen.toolNames[0]).not.toContain("send_email");
    expect(seen.toolNames[0]).not.toContain("lookup_stock");
    expect(seen.toolNames[0], "运行器自己的工具照常在").toContain("read_task");
  });

  it("审批按 Bot 算：连接只分配给 bot-1 时，bot-2 自己的 send_email 不进审批", async () => {
    const h = await startHarness({
      bots: ["bot-2"],
      tools: [toolConnection(OPS)],
      script: scriptBy([["发邮件", callTool("send_email", { to: "kehu@example.com" })]]),
    });

    await h.runner.prompt(promptMessage("bot-2", "run-1", "发邮件"));

    expect(h.sent.some((m) => m.type === "approval_request")).toBe(false);
    expect(h.sideEffects).toEqual(["send_email:kehu@example.com"]);
  });

  it("needsApproval 的 send_email 先走 approval_request，批了才到假 MCP，带参数和 Authorization 头", async () => {
    const mcp = await fakeMcp();
    const seen = toolRecorder();
    const h = await startHarness({
      bots: ["bot-1"],
      extensionTools: [],
      tools: [toolConnection(OPS, { url: mcp.url, authorization: "Bearer secret-token" })],
      script: scriptSeeingTools(seen, [
        ["发邮件", callTool("send_email", { to: "kehu@example.com", subject: "报价" })],
      ]),
      approve: true,
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "发邮件"));

    const request = h.sent.find((m) => m.type === "approval_request");
    expect(request?.type === "approval_request" && request.tool).toBe("send_email");
    expect(request?.type === "approval_request" && request.kind).toBe("send_external");
    expect(mcp.calls).toEqual([
      {
        name: "send_email",
        args: { to: "kehu@example.com", subject: "报价" },
        authorization: "Bearer secret-token",
      },
    ]);
    expect(seen.toolResults[0]).toContain("已发给 kehu@example.com");
  });

  it("拒绝之后假 MCP 一个调用都没收到", async () => {
    const mcp = await fakeMcp();
    const h = await startHarness({
      bots: ["bot-1"],
      extensionTools: [],
      tools: [toolConnection(OPS, { url: mcp.url })],
      script: scriptBy([["发邮件", callTool("send_email", { to: "kehu@example.com", subject: "报价" })]]),
      approve: false,
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "发邮件"));

    expect(mcp.calls).toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:blocked",
    ]);
  });

  it("假 MCP 没起：工具结果是「连不上」那句，run 正常收尾，没有 agent_error", async () => {
    const seen = toolRecorder();
    const h = await startHarness({
      bots: ["bot-1"],
      extensionTools: [],
      tools: [toolConnection(OPS)],
      script: scriptSeeingTools(seen, [["查库存", callTool("lookup_stock", { sku: "SKU-1" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "查库存"));

    expect(seen.toolResults[0]).toContain("工具连接「客服工具」连不上：");
    expect(shape(h.sent).at(-1)).toBe("run_done");
    expect(h.sent.some((m) => m.type === "agent_error")).toBe(false);
  });

  it("MCP 回 isError：终态 failed，错误文本是工具给的那句", async () => {
    const mcp = await fakeMcp();
    const seen = toolRecorder();
    const h = await startHarness({
      bots: ["bot-1"],
      extensionTools: [],
      tools: [toolConnection(OPS, { url: mcp.url })],
      script: scriptSeeingTools(seen, [["查库存", callTool("lookup_stock", { sku: "SKU-BAD" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "查库存"));

    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:failed",
    ]);
    expect(seen.toolResults[0]).toContain("没有这个 SKU");
  });

  it("两条连接撞了 lookup_stock：config 里靠前的赢，后面的跳过并 warn 一次", async () => {
    const first = await fakeMcp();
    const second = await fakeMcp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen = toolRecorder();
    const h = await startHarness({
      bots: ["bot-1"],
      extensionTools: [],
      tools: [
        toolConnection([{ name: "lookup_stock", needsApproval: false }], {
          id: "tc-a" as ToolConnectionConfig["id"],
          name: "仓库 A",
          url: first.url,
        }),
        toolConnection([{ name: "lookup_stock", needsApproval: false }], {
          id: "tc-b" as ToolConnectionConfig["id"],
          name: "仓库 B",
          url: second.url,
        }),
      ],
      script: scriptSeeingTools(seen, [["查库存", callTool("lookup_stock", { sku: "SKU-1" })]]),
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "查库存"));

    expect(seen.toolNames[0]?.filter((name) => name === "lookup_stock")).toHaveLength(1);
    expect(first.calls.map((c) => c.name)).toEqual(["lookup_stock"]);
    expect(second.calls).toEqual([]);
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      "Bot bot-1：连接「仓库 B」的操作「lookup_stock」和已注册的工具重名，跳过",
    ]);
    warn.mockRestore();
  });
});

describe("落盘位置", () => {
  it("Pi 的落盘全在钉死的临时目录里，~/.pi 下一个新文件都没有", () => {
    // 先证明这个探针能看见新文件，否则下面那条空断言是空的。
    const written = usedDataDirs.flatMap((dir) => filesNewerThan(dir, SUITE_STARTED_AT));
    expect(
      written.filter((f) => f.endsWith("auth.json")).length,
      "Pi 应该在钉死的 agentDir 下写过 auth.json",
    ).toBeGreaterThan(0);
    expect(
      written.filter((f) => f.endsWith(".jsonl")).length,
      "会话 JSONL 应该落在钉死的 sessionDir 下",
    ).toBeGreaterThan(0);

    expect(filesNewerThan(join(homedir(), ".pi"), SUITE_STARTED_AT)).toEqual([]);
  });
});
