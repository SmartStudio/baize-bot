import { randomUUID } from "node:crypto";
import {
  type AgentToControl,
  type BotId,
  type ControlToAgent,
  type GroupId,
  MessageId,
  type RunId,
  type ToolConnection,
} from "@baize/shared";
import { type ApprovalGate, approvalRule, createApprovalGate } from "./approvals.js";
import { type BotSession, createBotSession, type PiSettings, type RunnerTool } from "./bot-session.js";
import { type BotDirs, botDirs, ensureBotDirs } from "./paths.js";
import { reportRun } from "./reporter.js";
import { type ActiveRun, createTopicTools, renderTaskCard } from "./topic.js";

export type ConfigMessage = Extract<ControlToAgent, { type: "config" }>;
export type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;
export type BotConfig = ConfigMessage["bots"][number];

export { approvalKind, approvalRule } from "./approvals.js";
export { GATEWAY_PROVIDER_ID, type RunnerTool } from "./bot-session.js";
export { botDirs, type BotDirs } from "./paths.js";
export { type ActiveRun, createTopicTools, type GroupMember, renderTaskCard } from "./topic.js";

export interface RunnerConfig {
  readonly bots: readonly BotConfig[];
  readonly tools: readonly ToolConnection[];
  readonly modelGateway: ConfigMessage["modelGateway"];
  readonly send: (message: AgentToControl) => void;
  /** 每个 Bot 的 Pi 目录建在这下面。Pi 的四个落盘点全部显式钉死，不碰 ~/.pi。 */
  readonly dataDir: string;
  /** 扩展工具的注册点。`src/topic.ts` 那组主题任务工具由运行器自己挂，排在这些之后。 */
  readonly extensionTools?: readonly RunnerTool[];
  /** 覆盖 Pi 的会话设置。测试用它关掉供应商 SDK 那层重试，好让上游错误冒到 Pi 的重试逻辑。 */
  readonly settings?: PiSettings;
}

export interface Runner {
  prompt(message: PromptMessage): Promise<void>;
  /** 控制面的审批结论。runId 对不上的结论不作数。 */
  approve(runId: RunId, callId: string, approved: boolean): void;
  pause(botId: BotId): Promise<void>;
  resume(botId: BotId): Promise<void>;
  stop(): Promise<void>;
}

// 暂停不是断点续跑：Pi 只有 abort，没有 pause。中止当前运行，之后的 prompt 排队，
// resume 时把排队的整条重发一遍。详见 README。
type BotLifecycle =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly active: ActiveRun }
  | { readonly phase: "paused"; readonly queued: PromptMessage[] };

interface BotRuntime {
  readonly botId: BotId;
  readonly dirs: BotDirs;
  session: BotSession | null;
  lifecycle: BotLifecycle;
  /** 同一个 Bot 的 prompt 串行跑，不同 Bot 之间并行。 */
  chain: Promise<void>;
}

type RunnerState = "ready" | "stopped";

// 任务卡放第一段：它是这一轮的目标，上下文和当前这条都是围着它说的。放末尾的话
// 群里的闲聊会把它挤远，模型更容易照着最后几句走。
function composePrompt(message: PromptMessage): string {
  const sections: string[] = [];
  if (message.task !== null) sections.push(`任务卡：\n${renderTaskCard(message.task, message.members)}`);
  // 带 handoffId 的这条 prompt，正文就是控制面渲染好的交接报文：紧跟在任务卡后面单成一段，
  // 并点名先确认接手。混在群聊后面当「当前这条」，模型会当成又一句闲话直接开干。
  if (message.handoffId !== undefined) {
    sections.push(`交接报文：\n${message.text}\n\n先调用 accept_handoff 确认接手，再照着上面的下一步往下做。`);
  }
  if (message.context.length > 0) {
    sections.push(`群里刚才说的：\n${message.context.map((line) => `${line.from}：${line.text}`).join("\n")}`);
  }
  if (message.handoffId === undefined) {
    sections.push(message.context.length === 0 ? message.text : `当前这条：\n${message.text}`);
  }
  return sections.join("\n\n");
}

export function createRunner(config: RunnerConfig): Runner {
  let state: RunnerState = "ready";
  const approvals: ApprovalGate = createApprovalGate(config.send);
  const needsApproval = approvalRule(config.tools);
  const extensionTools = config.extensionTools ?? [];

  const bots = new Map<BotId, BotRuntime>(
    config.bots.map((bot) => [
      bot.id,
      {
        botId: bot.id,
        dirs: botDirs(config.dataDir, bot.id),
        session: null,
        lifecycle: { phase: "idle" },
        chain: Promise.resolve(),
      },
    ]),
  );

  const fail = (
    code: Extract<AgentToControl, { type: "agent_error" }>["code"],
    detail: string,
    groupId: GroupId,
  ): void => {
    config.send({ type: "agent_error", code, detail, groupId });
  };

  const sessionFor = async (bot: BotRuntime): Promise<BotSession> => {
    if (bot.session !== null) return bot.session;
    const activeRun = (): ActiveRun | null => (bot.lifecycle.phase === "running" ? bot.lifecycle.active : null);
    const created = await createBotSession({
      botId: bot.botId,
      dirs: ensureBotDirs(bot.dirs),
      gateway: config.modelGateway,
      tools: [...extensionTools, ...createTopicTools({ activeRun, send: config.send })],
      needsApproval,
      approvals,
      activeRun,
      ...(config.settings === undefined ? {} : { settings: config.settings }),
    });
    bot.session = created;
    return created;
  };

  const runOne = async (bot: BotRuntime, message: PromptMessage): Promise<void> => {
    if (state === "stopped") return;
    // 排在前面那次运行跑的时候可能来过 pause，轮到自己时得回到队列里，不能丢。
    if (bot.lifecycle.phase === "paused") {
      bot.lifecycle.queued.push(message);
      return;
    }

    const active: ActiveRun = {
      run: {
        runId: message.runId,
        botId: message.botId,
        groupId: message.groupId,
        messageId: MessageId.parse(randomUUID()),
      },
      task: message.task,
      members: message.members,
      handoffId: message.handoffId,
    };
    let unsubscribe: (() => void) | null = null;
    try {
      const { session } = await sessionFor(bot);
      bot.lifecycle = { phase: "running", active };
      unsubscribe = reportRun(session, active.run, approvals.blockedCallIds, config.send);
      await session.prompt(composePrompt(message));
    } catch (error) {
      fail("runner_failed", `run ${message.runId} 跑失败：${String(error)}`, message.groupId);
    } finally {
      unsubscribe?.();
      // pause 在跑的过程中把状态改成 paused 了的话，这里不能踩回 idle。
      if (bot.lifecycle.phase === "running") bot.lifecycle = { phase: "idle" };
    }
  };

  const runner: Runner = {
    async prompt(message) {
      if (state === "stopped") return;
      const bot = bots.get(message.botId);
      if (bot === undefined) {
        fail("unsupported", `config 里没有 Bot ${message.botId}，丢弃 run ${message.runId}`, message.groupId);
        return;
      }
      if (bot.lifecycle.phase === "paused") {
        bot.lifecycle.queued.push(message);
        return;
      }
      bot.chain = bot.chain.then(() => runOne(bot, message));
      await bot.chain;
    },

    approve(runId, callId, approved) {
      approvals.settle(runId, callId, approved);
    },

    async pause(botId) {
      const bot = bots.get(botId);
      if (bot === undefined || bot.lifecycle.phase === "paused") return;
      const wasRunning = bot.lifecycle.phase === "running";
      // 先立状态再中止。abort 会让正在跑的那次走完 finally，晚立的话会被踩回 idle。
      bot.lifecycle = { phase: "paused", queued: [] };
      if (!wasRunning) return;
      // 挂起的审批不解开，Pi 的工具循环还在 await 它，abort 等不到 idle 会一直挂着。
      approvals.abandon(botId);
      await bot.session?.session.abort();
    },

    async resume(botId) {
      const bot = bots.get(botId);
      if (bot === undefined || bot.lifecycle.phase !== "paused") return;
      const queued = bot.lifecycle.queued;
      bot.lifecycle = { phase: "idle" };
      for (const message of queued) await runner.prompt(message);
    },

    async stop() {
      state = "stopped";
      approvals.abandon();
      await Promise.all(
        [...bots.values()].map(async (bot) => {
          await bot.chain.catch(() => undefined);
          await bot.session?.session.abort();
          bot.session?.dispose();
          bot.session = null;
        }),
      );
    },
  };

  return runner;
}
