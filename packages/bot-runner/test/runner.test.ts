import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToControl, BotId, GroupId, RunId, type ToolConnection } from "@baize/shared";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  botDirs,
  createRunner,
  type PromptMessage,
  type Runner,
  type RunnerConfig,
  type RunnerTool,
} from "../src/index.js";
import { type Gateway, startGateway } from "./fixtures/gateway.js";
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

const toolConnection = (operations: ToolConnection["operations"]): ToolConnection => ({
  id: "tc-1" as ToolConnection["id"],
  ownerId: "user-1" as ToolConnection["ownerId"],
  name: "客服工具",
  url: "https://tools.example.com",
  operations,
  assignedBotIds: [],
});

const promptMessage = (botId: string, runId: string, text: string): PromptMessage => ({
  type: "prompt",
  runId: RunId.parse(runId),
  botId: BotId.parse(botId),
  groupId: GroupId.parse("group-1"),
  text,
  context: [],
});

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
  readonly tools?: readonly ToolConnection[];
  readonly script: (req: ChatCompletionRequest) => ScriptedTurn;
  readonly failFirst?: number;
  /** 收到 approval_request 就按这个结论回，undefined 表示不给结论。 */
  readonly approve?: boolean;
  readonly settings?: RunnerConfig["settings"];
}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "baize-runner-"));
  usedDataDirs.push(dataDir);
  const gateway = await startGateway({
    upstream: scriptedUpstream(options.script),
    models: [{ id: MODEL_ID }],
    ...(options.failFirst === undefined ? {} : { failFirst: options.failFirst }),
  });

  const sent: AgentToControl[] = [];
  const sideEffects: string[] = [];
  let runner: Runner | null = null;

  runner = createRunner({
    bots: options.bots.map((id) => ({ id: BotId.parse(id), name: id, description: "" })),
    tools: options.tools ?? [],
    modelGateway: { baseUrl: gateway.baseUrl, apiKey: "test-key", model: MODEL_ID },
    dataDir,
    extensionTools: [sendEmailTool(sideEffects), listFilesTool(sideEffects)],
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
    await h.runner.pause(BotId.parse("bot-1"));
    await running;

    expect(h.sideEffects, "没人批过，工具体不该执行").toEqual([]);
    expect(shape(h.sent).filter((s) => s.startsWith("bot_tool_call"))).toEqual([
      "bot_tool_call:running",
      "bot_tool_call:blocked",
    ]);
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

    expect(h.sent, "暂停期间不该有任何上行报文").toEqual([]);
    expect(h.gateway.requestCount()).toBe(requestsBeforePause);

    await h.runner.resume(BotId.parse("bot-1"));

    expect(h.sent.filter((m) => m.type === "run_done").map((m) => m.runId)).toEqual(["run-2"]);
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
  it("首个补全请求返 503 时 Pi 重跑一轮，run_done 仍然只发一条", async () => {
    const h = await startHarness({
      bots: ["bot-1"],
      script: scriptBy([["干活", { textChunks: ["重试之后才说的话。"], usage: { input: 300, output: 9 } }]]),
      failFirst: 1,
      settings: RETRY_TO_PI,
    });

    await h.runner.prompt(promptMessage("bot-1", "run-1", "干活"));

    expect(h.gateway.requestCount()).toBe(2);
    expect(h.sent.filter((m) => m.type === "run_done")).toHaveLength(1);
    expect(h.sent.at(-1)?.type).toBe("run_done");
    expect(h.sent.some((m) => m.type === "bot_text" && m.delta === "重试之后才说的话。")).toBe(true);
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
