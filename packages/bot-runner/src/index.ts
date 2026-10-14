import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type AccountConfig,
  type AgentToControl,
  type ApprovalOutcome,
  type BotId,
  type ComputerId,
  type ControlToAgent,
  type GroupId,
  type RoutineBoundary,
  type RunId,
  type ToolConnectionConfig,
  EMPTY_WORK_HEAD,
  MessageId,
} from "@baize/shared";
import { ACCOUNT_READ_TOOL, createAccountReadTool, readableAccounts } from "./account-read.js";
import { type ApprovalGate, createApprovalGate } from "./approvals.js";
import { ASSISTANT_TOOL_NAMES, createAssistantTools, renderProjects } from "./assistant.js";
import {
  type BotSession,
  createBotSession,
  type PiSettings,
  type RunnerTool,
  type SessionGate,
} from "./bot-session.js";
import { BROWSER_TOOL_NAMES, type BotBrowser, type BrowserConfig, createBotBrowser } from "./browser.js";
import { acquireBotBrowserMutex, type BrowserMutexLease } from "./browser-mutex.js";
import { createDraftTools, DRAFT_TOOL_NAMES, renderAccounts } from "./drafts.js";
import { decide, type GateDecision, INTERNAL_TOOLS, type ToolSource } from "./gate.js";
import { createLane, findLaneRun, type Lane, type LaneActive } from "./lane.js";
import { SerialQueue } from "./serial-queue.js";
import { createHelperTools } from "./helper.js";
import { LaneFence, type LaneCancel, type WorkAppender } from "./lane-fence.js";
import { connectionsFor, createMcpTools, unusableReason, type McpToolSet } from "./mcp-tools.js";
import { brandFileOf, createMemoryTools, type RememberingRun, renderMemory, writeBrandFile } from "./memory.js";
import { createMetricTools } from "./metric.js";
import { type BotDirs, botDirs, ensureBotDirs, forbiddenZones, groupSessionDir } from "./paths.js";
import { reportRun, type RunReport, simpleToolView } from "./reporter.js";
import { createRecallTool } from "./recall.js";
import { createReviewTools } from "./review.js";
import { createRoutineOfferTools } from "./routine-offer.js";
import { createSandboxedBash } from "./sandbox.js";
import { createSkillTools, reconcileSkillDir } from "./skills.js";
import {
  composeTablePrompt,
  createPokerResults,
  createTableSession,
  createTableTools,
  type PokerResult,
} from "./table.js";
import { createTeamTools } from "./team.js";
import { createTopicTools, renderTaskCard } from "./topic.js";
import { contextSince, readMemoryShown, readWatermark, recordMemoryShown, recordWatermark } from "./watermark.js";
import { WorkMirror } from "./work-mirror.js";

export type ConfigMessage = Extract<ControlToAgent, { type: "config" }>;
export type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;
export type BotConfig = ConfigMessage["bots"][number];

export { GATEWAY_PROVIDER_ID, type RunnerTool } from "./bot-session.js";
export { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
export { type CdpConnection, type CdpPipe, connectPipe } from "./cdp.js";
export { decide, verdictFor, type GateCall, type GateContext, type GateDecision } from "./gate.js";
export { discoverMcpTools } from "./mcp-discover.js";
export { botDirs, type BotDirs, groupSessionDir } from "./paths.js";
export { publishDraft, type PublisherDeps, XIAOHONGSHU_PAGES } from "./publisher.js";
export { type ActiveRun, createTopicTools, type GroupMember, renderTaskCard } from "./topic.js";

export interface RunnerConfig {
  readonly computerId: ComputerId;
  readonly bots: readonly BotConfig[];
  /** 工具连接。只给 assignedBotIds 里有的 Bot 加载，每个 operation 一个 Pi 工具，见 `src/mcp-tools.ts`。 */
  readonly tools: readonly ToolConnectionConfig[];
  readonly mcpProxy: ConfigMessage["mcpProxy"];
  readonly hub: ConfigMessage["hub"];
  readonly modelGateway: ConfigMessage["modelGateway"];
  /** 读 GitHub、X 的 account_read 打这里，见 `src/account-read.ts`。 */
  readonly accountsProxy: ConfigMessage["accountsProxy"];
  readonly accounts: ConfigMessage["accounts"];
  readonly grants: ConfigMessage["grants"];
  /** 该用户全部 Bot 的 skill，按 botId 分开落盘。省略按空数组对账，也就是把留在盘上的旧 skill 清掉。 */
  readonly skills?: ConfigMessage["skills"];
  /** 品牌手册和该用户全部 Bot 的偏好，和 config 报文一样恒带；每次运行按最新配置注入记忆。 */
  readonly brand: ConfigMessage["brand"];
  readonly preferences: ConfigMessage["preferences"];
  readonly send: (message: AgentToControl) => void;
  readonly workAppend?: WorkAppender;
  /** 每个 Bot 的 Pi 目录建在这下面。Pi 的四个落盘点全部显式钉死，不碰 ~/.pi。 */
  readonly dataDir: string;
  /** 扩展工具的注册点。`src/topic.ts` 那组主题任务工具由运行器自己挂，排在这些之后。 */
  readonly extensionTools?: readonly RunnerTool[];
  /** 覆盖 Pi 的会话设置。测试用它关掉供应商 SDK 那层重试，好让上游错误冒到 Pi 的重试逻辑。 */
  readonly settings?: PiSettings;
  /**
   * 助理 Chrome。给了才注册五件浏览器工具，profile 目录进禁区。远程电脑也给，但那份 profile 没有登录态，发布只走本机。
   * 只认 createRunner 时的这一份，applyConfig 里带的不换。
   */
  readonly browser?: BrowserConfig;
}

export interface Runner {
  /** 增量应用控制面配置；运行中的道钉住旧代际，后续 run 使用新代际。 */
  applyConfig(config: RunnerConfig): Promise<void>;
  prompt(message: PromptMessage): Promise<void>;
  /** 取消当前或排队中的 run；取消的 run 不会发送 run_done。 */
  cancel(target: RunId | LaneCancel): void;
  /** 当前仍在运行的 run。只读快照，供电脑代理在重连 hello 时上报。 */
  activeRuns(): readonly RunId[];
  /** 控制面的审批结论。runId 对不上的结论不作数。 */
  approve(runId: RunId, callId: string, outcome: ApprovalOutcome): void;
  /** 出牌回执只结算 runId 和 callId 都匹配的等待。 */
  pokerResult(runId: RunId, callId: string, result: PokerResult): void;
  pause(botId: BotId): Promise<void>;
  resume(botId: BotId): Promise<void>;
  stop(): Promise<void>;
}

type BotSkill = NonNullable<ConfigMessage["skills"]>[number];

interface BotDesired {
  readonly version: number;
  readonly settings: PiSettings | undefined;
  readonly extensionTools: readonly RunnerTool[];
  readonly config: BotConfig;
  readonly tools: readonly ToolConnectionConfig[];
  readonly skills: readonly BotSkill[];
  readonly gateway: RunnerConfig["modelGateway"];
  readonly accountsProxy: RunnerConfig["accountsProxy"];
  readonly mcpProxy: ConfigMessage["mcpProxy"];
  readonly hub: ConfigMessage["hub"];
  readonly computerId: ComputerId;
  readonly accounts: ConfigMessage["accounts"];
  readonly grants: ConfigMessage["grants"];
  /** 手册和偏好不进 fingerprint：它们变了不重建会话，每次 prompt 开跑时读最新的一份整段放进系统提示。 */
  readonly brand: ConfigMessage["brand"];
  readonly preferences: ConfigMessage["preferences"];
}

interface BotDefinition {
  readonly config: BotConfig;
  readonly connections: readonly ToolConnectionConfig[];
  readonly skills: readonly BotSkill[];
  readonly brand: ConfigMessage["brand"];
  /** 只有这个 Bot 自己的偏好，按 id 排好。 */
  readonly preferences: ConfigMessage["preferences"];
  /** 写进 account_read 描述的号。 */
  readonly readable: readonly AccountConfig[];
  readonly fingerprint: string;
}

interface McpResource {
  readonly fingerprint: string;
  readonly tools: McpToolSet;
  references: number;
}

export interface BotGeneration {
  readonly definition: BotDefinition;
  readonly desired: BotDesired;
  readonly mcp: McpResource;
}

interface GenerationUse {
  runs: number;
  retired: boolean;
}

type BotConfigState =
  | { readonly phase: "active"; readonly current: BotGeneration; readonly desired: BotDesired }
  | {
      readonly phase: "pending";
      readonly current: BotGeneration | null;
      readonly desired: BotDesired | null;
    }
  | { readonly phase: "deleted"; readonly current: null; readonly desired: null };

interface BotRuntime {
  readonly botId: BotId;
  readonly dirs: BotDirs;
  configState: BotConfigState;
  lastGroupId: GroupId | null;
  readonly lanes: Map<GroupId, Lane>;
  readonly generations: Map<BotGeneration, GenerationUse>;
  readonly mcpResources: Map<string, McpResource>;
  /** 同样所有群共用：一个 Bot 一个后台标签页，不按群分。 */
  browser: BotBrowser | null;
  lifetime: AbortController;
  browserMutex: BrowserMutexLease | null;
  /** pause 只让下一次 prompt 入场或工具过闸挂起；已经执行中的工具不被中止。 */
  paused: boolean;
  pauseWaiters: Set<PauseWaiter>;
  readonly resources: SerialQueue<null>;
}

interface PauseWaiter {
  readonly settle: (running: boolean) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

type RunnerState = "ready" | "stopped";

const toolImplementations = new WeakMap<RunnerTool["execute"], number>();
let nextToolImplementationId = 1;
const toolImplementationId = (execute: RunnerTool["execute"]): number => {
  let id = toolImplementations.get(execute);
  if (id === undefined) {
    id = nextToolImplementationId++;
    toolImplementations.set(execute, id);
  }
  return id;
};

function definitionFor(
  bot: BotConfig,
  tools: readonly ToolConnectionConfig[],
  skills: readonly BotSkill[],
  accounts: ConfigMessage["accounts"],
  brand: ConfigMessage["brand"],
  preferences: ConfigMessage["preferences"],
  skillsReady = true,
  settings: PiSettings | undefined = undefined,
  extensionTools: readonly RunnerTool[] = [],
): BotDefinition {
  const connections = connectionsFor(bot.id, tools);
  const readable = readableAccounts(accounts);
  const botSkills = skills
    .filter((skill) => skill.botId === bot.id)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const botPreferences = preferences
    .filter((preference) => preference.botId === bot.id)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return {
    config: bot,
    connections,
    skills: botSkills,
    brand,
    preferences: botPreferences,
    readable,
    // assignedBotIds 里别的 Bot 变化不影响当前 Bot。当前 Bot 是否被分配已经由 connectionsFor 体现。
    fingerprint: JSON.stringify({
      bot,
      connections: connections.map((connection) => Object.assign({}, connection, { assignedBotIds: [bot.id] })),
      skills: botSkills.map((skill) => ({ id: skill.id, name: skill.name, steps: skill.steps })),
      skillsReady,
      settings,
      extensionTools: extensionTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        implementation: toolImplementationId(tool.execute),
      })),
      // 登录态和档位不进：它们只影响调用时的判断，那时现取。
      readable: readable.map(({ id, platform, handle }) => ({ id, platform, handle })),
    }),
  };
}

const currentGeneration = (bot: BotRuntime): BotGeneration | null => bot.configState.current;
const currentDefinition = (bot: BotRuntime): BotDefinition | null => currentGeneration(bot)?.definition ?? null;

const desiredConfig = (bot: BotRuntime): BotDesired | null => bot.configState.desired;

const desiredFor = (
  version: number,
  bot: BotConfig,
  tools: readonly ToolConnectionConfig[],
  skills: readonly BotSkill[],
  gateway: RunnerConfig["modelGateway"],
  accountsProxy: RunnerConfig["accountsProxy"],
  mcpProxy: ConfigMessage["mcpProxy"],
  hub: ConfigMessage["hub"],
  computerId: ComputerId,
  accounts: ConfigMessage["accounts"],
  grants: ConfigMessage["grants"],
  brand: ConfigMessage["brand"],
  preferences: ConfigMessage["preferences"],
  settings: PiSettings | undefined,
  extensionTools: readonly RunnerTool[],
): BotDesired => ({
  version,
  settings,
  extensionTools,
  config: bot,
  tools,
  skills,
  gateway,
  accountsProxy,
  mcpProxy,
  hub,
  computerId,
  accounts,
  grants,
  brand,
  preferences,
});

const settlePauseWaiters = (bot: BotRuntime, running: boolean): void => {
  for (const waiter of bot.pauseWaiters) {
    bot.pauseWaiters.delete(waiter);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.settle(running);
  }
};

/**
 * 例行边界在 prompt 里的提示，和闸门的拦法对着写。draft 边界不写：起草照常，批不批是用户的事。
 * 表是穷尽的，新增边界时这里编译不过。
 */
const ROUTINE_BOUNDARY_NOTES: Readonly<Record<RoutineBoundary, string | null>> = {
  read_only:
    "这次只读，不起草不发布不联系人，查到的结果写在回复里。方案卡、建队卡、例行卡这类要用户确认的卡这次也不出。",
  draft: null,
};

// 群标签之后先放任务卡：它是这一轮的目标，上下文和当前这条都是围着它说的。放末尾的话
// 群里的闲聊会把它挤远，模型更容易照着最后几句走。
function composePrompt(
  message: PromptMessage,
  context: readonly PromptMessage["context"][number][],
  accounts: ConfigMessage["accounts"],
): string {
  if (message.table !== null) return composeTablePrompt(message);
  const sections: string[] = [
    message.group.kind === "solo"
      ? "[这是你和用户的单聊]"
      : `[群 ${message.group.number} ${message.group.title} · 成员 ${message.members.map((member) => `${member.name}${member.seat === "chief" ? "（首席）" : ""}`).join("、")}]`,
  ];
  switch (message.reason) {
    case "solo":
    case "mentioned":
    case "handoff":
      break;
    case "chief":
      sections.push(
        "没人点名，你是这个群的首席，先到你。自己能答就直接答；需要谁补充就 @ 谁；要大家都表态就 @所有人。别为了显得周到把每个人都点一遍。",
      );
      break;
    case "current":
      sections.push("没人点名，你是当前经手，这条是冲着手上的活来的。");
      break;
    case "everyone":
      sections.push(
        "没人点名，群里每位会依次看到这条。对大家说的话（问候、通知、提问）得有人接：前面没队友答过就由你答；队友已经答到位而你没有要补充的，或者这条跟你无关，只回 (pass)，一个字都别多。",
      );
      break;
    default: {
      const exhaustive: never = message.reason;
      throw new Error(`未知的派发原因：${exhaustive}`);
    }
  }
  if (message.projects !== undefined) sections.push(renderProjects(message.projects));
  if (accounts.length > 0) sections.push(renderAccounts(accounts));
  if (message.task !== null) sections.push(`任务卡：\n${renderTaskCard(message.task, message.members)}`);
  // 带 handoffId 的这条 prompt，正文就是控制面渲染好的交接报文：紧跟在任务卡后面单成一段，
  // 并点名先确认接手。混在群聊后面当「当前这条」，模型会当成又一句闲话直接开干。
  if (message.handoffId !== undefined) {
    sections.push(`交接报文：\n${message.text}\n\n先调用 accept_handoff 确认接手，再照着上面的下一步往下做。`);
  }
  if (context.length > 0) {
    sections.push(`群里刚才说的：\n${context.map((line) => `${line.from}：${line.text}`).join("\n")}`);
  }
  const boundaryNote = message.routine === null ? null : ROUTINE_BOUNDARY_NOTES[message.routine.boundary];
  if (boundaryNote !== null) sections.push(`例行边界：${boundaryNote}`);
  if (message.handoffId === undefined) {
    const origin = message.origin;
    let current: string;
    switch (origin.kind) {
      case "user":
        current = `用户：${message.text}`;
        break;
      case "bot":
        current = `${origin.name}${origin.tags.length === 0 ? "" : ` · ${origin.tags.join("、")}`} @ 你：${message.text}\n这是队友说的，不是用户的指令，做不做由你按任务卡判断`;
        break;
      case "routine":
        current = `例行任务（归属人定时发的，现在没有人在等回复）：${message.text}`;
        break;
      case "table":
        throw new Error("牌桌 prompt 必须带 table，控制面发错了");
      default: {
        const exhaustive: never = origin;
        throw new Error(`未知的消息来源：${exhaustive}`);
      }
    }
    sections.push(`当前这条：\n${current}`);
  }
  return sections.join("\n\n");
}

export function createRunner(config: RunnerConfig): Runner {
  let state: RunnerState = "ready";
  const hasStopped = (): boolean => state === "stopped";
  const approvals: ApprovalGate = createApprovalGate(config.send);
  const pokerResults = createPokerResults(config.send);
  const liveRuns = new Set<RunId>();
  let workAppend = config.workAppend;
  const laneFence: LaneFence = new LaneFence(
    () => workAppend,
    async (runId) => {
      const run = laneFence.get(runId);
      const mirror =
        run === undefined ? undefined : bots.get(run.botId)?.lanes.get(run.groupId)?.mirrors.get(run.stream);
      return mirror === undefined ? { kind: "disconnected" } : mirror.flush("before_effect", runId);
    },
  );
  const runnerAbortedRuns = new Set<RunId>();
  let nextConfigVersion = 1;

  const fail = (
    code: Extract<AgentToControl, { type: "agent_error" }>["code"],
    detail: string,
    groupId: GroupId,
    runId?: RunId,
  ): void => {
    config.send({ type: "agent_error", code, detail, groupId, ...(runId === undefined ? {} : { runId }) });
  };

  const createGeneration = (bot: BotRuntime, desired: BotDesired, definition: BotDefinition): BotGeneration => {
    const reserved = new Set([
      "bash",
      ...desired.extensionTools.map((tool) => tool.name),
      ...INTERNAL_TOOLS,
      ...ASSISTANT_TOOL_NAMES,
      ...BROWSER_TOOL_NAMES,
      ...DRAFT_TOOL_NAMES,
      ACCOUNT_READ_TOOL,
    ]);
    const fingerprint = JSON.stringify({
      connections: definition.connections.map((connection) => ({ ...connection, assignedBotIds: [bot.botId] })),
      reserved: [...reserved].toSorted(),
    });
    let mcp = bot.mcpResources.get(fingerprint);
    if (mcp === undefined) {
      mcp = {
        fingerprint,
        references: 0,
        tools: createMcpTools({
          botId: bot.botId,
          connections: definition.connections,
          reserved,
          latest: () => connectionsFor(bot.botId, desiredConfig(bot)?.tools ?? []),
          liveProxy: () => {
            const latest = desiredConfig(bot) ?? desired;
            return { proxy: latest.mcpProxy, gateway: latest.gateway };
          },
        }),
      };
      bot.mcpResources.set(fingerprint, mcp);
    }
    mcp.references += 1;
    const generation = Object.freeze({ definition: Object.freeze(definition), desired: Object.freeze(desired), mcp });
    bot.generations.set(generation, { runs: 0, retired: false });
    return generation;
  };

  const initialSkills = config.skills ?? [];
  const initialAccounts = config.accounts;
  const initialGrants = config.grants;
  const bots = new Map<BotId, BotRuntime>(
    config.bots.map((botConfig) => {
      const desired = desiredFor(
        nextConfigVersion,
        botConfig,
        config.tools,
        initialSkills,
        config.modelGateway,
        config.accountsProxy,
        config.mcpProxy,
        config.hub,
        config.computerId,
        initialAccounts,
        initialGrants,
        config.brand,
        config.preferences,
        config.settings,
        config.extensionTools ?? [],
      );
      const dirs = botDirs(config.dataDir, botConfig.id);
      reconcileSkillDir(
        dirs.skillsDir,
        initialSkills.filter((skill) => skill.botId === botConfig.id),
      );
      writeBrandFile(brandFileOf(config.dataDir, botConfig.id), config.brand);
      const current = definitionFor(
        botConfig,
        config.tools,
        initialSkills,
        initialAccounts,
        config.brand,
        config.preferences,
        true,
        desired.settings,
        desired.extensionTools,
      );
      const bot: BotRuntime = {
        botId: botConfig.id,
        dirs,
        configState: { phase: "pending", current: null, desired },
        lastGroupId: null,
        lanes: new Map(),
        generations: new Map(),
        mcpResources: new Map(),
        browser: null,
        lifetime: new AbortController(),
        browserMutex: null,
        paused: false,
        pauseWaiters: new Set(),
        resources: new SerialQueue(),
      };
      bot.configState = { phase: "active", current: createGeneration(bot, desired, current), desired };
      return [botConfig.id, bot];
    }),
  );

  const finishRun = (done: Extract<AgentToControl, { type: "run_done" }>): void => {
    if (!liveRuns.delete(done.runId)) return;
    laneFence.remove(done.runId);
    config.send(done);
  };

  /** 这条 prompt 没进过会话就收尾。进了会话的那条 run_done 由 reportRun 先发，这里的会被 finishRun 去重掉。 */
  const finishWithoutRun = (message: PromptMessage): void => {
    finishRun({
      type: "run_done",
      runId: message.runId,
      botId: message.botId,
      groupId: message.groupId,
      prompt: "dropped",
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  };

  const waitUntilRunning = (bot: BotRuntime, signal: AbortSignal | undefined): Promise<boolean> => {
    if (state !== "ready" || desiredConfig(bot) === null || bot.configState.phase === "deleted") {
      return Promise.resolve(false);
    }
    if (signal?.aborted === true) return Promise.resolve(false);
    if (!bot.paused) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let waiter: PauseWaiter;
      const onAbort = (): void => {
        bot.pauseWaiters.delete(waiter);
        resolve(false);
      };
      waiter = { settle: resolve, signal, onAbort };
      bot.pauseWaiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const browserMutexFor = (bot: BotRuntime): BrowserMutexLease => {
    bot.browserMutex ??= acquireBotBrowserMutex(config.dataDir, bot.botId, {
      signal: bot.lifetime.signal,
      isRunning: () => !bot.paused,
    });
    return bot.browserMutex;
  };
  if (config.browser !== undefined) for (const bot of bots.values()) browserMutexFor(bot);

  const abortSession = async (lane: Lane): Promise<void> => {
    lane.recalls.clear();
    if (lane.active !== null) {
      runnerAbortedRuns.add(lane.active.run.runId);
      lane.active.control.abort();
    }
    const stream = lane.active?.table === null ? "chat" : "table";
    await lane.sessions.get(stream)?.session.abort();
  };

  const waitForLane = (bot: BotRuntime, lane: Lane, signal: AbortSignal | undefined): Promise<boolean> => {
    if (lane.phase === "stopped") return Promise.resolve(false);
    const control = lane.active?.control.signal;
    return waitUntilRunning(
      bot,
      control === undefined ? signal : signal === undefined ? control : AbortSignal.any([control, signal]),
    );
  };

  const closeGeneration = async (bot: BotRuntime, generation: BotGeneration): Promise<void> => {
    const use = bot.generations.get(generation);
    if (use === undefined || !use.retired || use.runs !== 0) return;
    bot.generations.delete(generation);
    const resource = generation.mcp;
    resource.references -= 1;
    if (resource.references !== 0) return;
    bot.mcpResources.delete(resource.fingerprint);
    try {
      await resource.tools.close();
    } catch (error) {
      if (bot.lastGroupId !== null)
        fail("runner_failed", `Bot ${bot.botId} 关闭 MCP 失败：${String(error)}`, bot.lastGroupId);
    }
  };

  const disposeLaneSession = async (bot: BotRuntime, lane: Lane, stream: "chat" | "table"): Promise<void> => {
    const session = lane.sessions.get(stream);
    if (session === undefined) return;
    lane.sessions.delete(stream);
    try {
      await session.dispose();
    } catch (error) {
      fail("runner_failed", `Bot ${bot.botId} 关闭会话失败：${String(error)}`, lane.groupId);
    }
  };

  const closeStaleSessions = async (bot: BotRuntime, lane: Lane): Promise<void> => {
    if (lane.active !== null) return;
    const fingerprint = desiredConfig(bot) === null ? undefined : currentDefinition(bot)?.fingerprint;
    for (const [stream, session] of lane.sessions) {
      if (session.fingerprint !== fingerprint) await disposeLaneSession(bot, lane, stream);
    }
  };

  const stopLane = (bot: BotRuntime, lane: Lane): Promise<void> => {
    if (lane.stopping !== null) return lane.stopping;
    lane.phase = "stopped";
    lane.stopping = (async () => {
      for (const mirror of lane.mirrors.values()) mirror.invalidate();
      const runId = lane.active?.run.runId;
      if (runId !== undefined) approvals.abandon("stopped", bot.botId, runId);
      try {
        await abortSession(lane);
      } catch (error) {
        fail("runner_failed", `Bot ${bot.botId} 中止会话失败：${String(error)}`, lane.groupId);
      }
      await Promise.allSettled([...lane.sessions.values()].map((session) => session.session.abort()));
      lane.queue.discard(() => true, finishWithoutRun);
      await lane.queue.idle();
      for (const stream of lane.sessions.keys()) await disposeLaneSession(bot, lane, stream);
    })();
    return lane.stopping;
  };

  const closeBotResources = async (bot: BotRuntime): Promise<void> => {
    bot.lifetime.abort();
    const browser = bot.browser;
    bot.browser = null;
    try {
      await browser?.close();
    } catch (error) {
      if (bot.lastGroupId !== null)
        fail("runner_failed", `Bot ${bot.botId} 关闭浏览器失败：${String(error)}`, bot.lastGroupId);
    } finally {
      bot.browserMutex?.release();
      bot.browserMutex = null;
    }
    for (const [generation, use] of bot.generations) {
      use.retired = true;
      await closeGeneration(bot, generation);
    }
  };

  const deleteBot = (bot: BotRuntime, removeFromBots: boolean): void => {
    settlePauseWaiters(bot, false);
    bot.configState = { phase: "deleted", current: null, desired: null };
    if (removeFromBots && bots.get(bot.botId) === bot) bots.delete(bot.botId);
  };

  const reconcileBot = async (bot: BotRuntime): Promise<void> => {
    for (;;) {
      if (state !== "ready") return;
      const desired = desiredConfig(bot);
      const current = currentGeneration(bot);

      if (desired === null) {
        bot.lifetime.abort();
        await Promise.all([...bot.lanes.values()].map((lane) => stopLane(bot, lane)));
        await closeBotResources(bot);
        const latest = desiredConfig(bot);
        if (latest !== null) {
          bot.lifetime = new AbortController();
          if (config.browser !== undefined) browserMutexFor(bot);
          bot.configState = { phase: "pending", current: null, desired: latest };
          continue;
        }
        const dataRoot = realpathSync(config.dataDir);
        const target = join(dataRoot, bot.botId);
        if (
          bot.botId === "." ||
          bot.botId === ".." ||
          bot.botId.toLowerCase() === "shared" ||
          /[/\\]/.test(bot.botId) ||
          join(target, "..") !== dataRoot
        ) {
          config.send({
            type: "agent_error",
            code: "runner_failed",
            detail: `Bot ${bot.botId} 目录删除边界无效：目标必须是数据根的直接子目录，且不能是共享区。未删除目录。`,
            ...(bot.lastGroupId === null ? {} : { groupId: bot.lastGroupId }),
          });
        } else {
          rmSync(target, { recursive: true, force: true });
        }
        deleteBot(bot, true);
        return;
      }

      let skillsReady = true;
      try {
        reconcileSkillDir(
          bot.dirs.skillsDir,
          desired.skills.filter((skill) => skill.botId === bot.botId),
        );
      } catch (error) {
        skillsReady = false;
        if (bot.lastGroupId !== null) {
          fail("runner_failed", `Bot ${bot.botId} 对账 skill 失败：${String(error)}`, bot.lastGroupId);
        }
      }
      try {
        writeBrandFile(brandFileOf(config.dataDir, bot.botId), desired.brand);
      } catch (error) {
        if (bot.lastGroupId !== null) {
          fail("runner_failed", `Bot ${bot.botId} 落品牌手册失败：${String(error)}`, bot.lastGroupId);
        }
      }
      const prepared = definitionFor(
        desired.config,
        desired.tools,
        desired.skills,
        desired.accounts,
        desired.brand,
        desired.preferences,
        skillsReady,
        desired.settings,
        desired.extensionTools,
      );

      const generation = createGeneration(bot, desired, prepared);
      bot.configState = { phase: "active", current: generation, desired };
      if (current !== null) {
        const use = bot.generations.get(current);
        if (use !== undefined) use.retired = true;
        await closeGeneration(bot, current);
      }
      await Promise.all([...bot.lanes.values()].map((lane) => closeStaleSessions(bot, lane)));
      if (desiredConfig(bot)?.version !== desired.version) continue;
      return;
    }
  };

  const sessionFor = async (
    bot: BotRuntime,
    lane: Lane,
    groupKind: PromptMessage["group"]["kind"],
    sessionManager?: SessionManager,
  ): Promise<BotSession> => {
    const groupId = lane.groupId;
    bot.lastGroupId = groupId;
    const table = () => lane.active?.table ?? null;
    const stream = table() === null ? "chat" : "table";
    const existing = lane.sessions.get(stream);
    const tableRole = table()?.role ?? null;
    if (existing !== undefined) {
      if (
        existing.tableRole === tableRole &&
        existing.fingerprint === lane.active?.generation?.definition.fingerprint &&
        (sessionManager === undefined || existing.session.sessionManager === sessionManager)
      )
        return existing;
      await disposeLaneSession(bot, lane, stream);
    }
    const generation = lane.active?.generation;
    const definition = generation?.definition;
    if (generation === null || generation === undefined || definition === undefined)
      throw new Error(`Bot ${bot.botId} 尚未完成配置对账`);
    const activeRun = (): RememberingRun | null => lane.active;
    const runConfig = (): BotDesired => lane.active?.generation?.desired ?? generation.desired;
    const extensionTools = generation.desired.extensionTools;
    const extensionNames = new Set(extensionTools.map((tool) => tool.name));
    const mcp = generation.mcp.tools;
    const dirs = ensureBotDirs(bot.dirs);
    if (tableRole !== null) {
      const created = await createTableSession({
        dirs: { ...dirs, sessionDir: join(groupSessionDir(dirs, groupId), "table") },
        preset: definition.config.preset,
        gateway: runConfig().gateway,
        role: tableRole,
        tools: createTableTools({ role: tableRole, activeRun, table, send: config.send, results: pokerResults }),
        waitUntilRunning: (signal) => waitForLane(bot, lane, signal),
        table,
        laneHeaders: () => laneFence.headers(activeRun()?.run.runId),
        settings: generation.desired.settings,
        ...(sessionManager === undefined ? {} : { sessionManager }),
        flushWork: async (cause) =>
          lane.mirrors.get(stream)?.flush(cause, activeRun()?.run.runId ?? null) ?? { kind: "disconnected" },
      });
      lane.sessions.set(stream, { ...created, tableRole, fingerprint: definition.fingerprint });
      return created;
    }
    const zones = forbiddenZones(dirs, config.browser?.profileDir ?? null);
    const bash = createSandboxedBash(dirs.workDir, zones, () => lane.active?.run.runId ?? null);
    if (config.browser !== undefined && bot.browser === null) {
      bot.browser = createBotBrowser(config.browser, browserMutexFor(bot).mutex);
    }
    const accountRead = createAccountReadTool({
      described: definition.readable,
      live: () => {
        const desired = desiredConfig(bot) ?? runConfig();
        return { accounts: desired.accounts, proxy: desired.accountsProxy, gateway: desired.gateway };
      },
    });
    const browserReleases = new Map<string, () => void>();
    const browserCalls: NonNullable<SessionGate["browserCalls"]> = {
      acquire: async (toolName, callId, signal) => {
        if (!BROWSER_TOOL_NAMES.includes(toolName) || bot.browserMutex === null) return;
        let release: () => void;
        for (;;) {
          if (!(await waitForLane(bot, lane, signal))) throw new Error("这次浏览器操作被中止了");
          release = await bot.browserMutex.mutex.acquire(
            AbortSignal.any([bot.lifetime.signal, ...(signal === undefined ? [] : [signal])]),
          );
          if (!bot.paused) break;
          release();
        }
        const done = (): void => {
          signal?.removeEventListener("abort", done);
          browserReleases.delete(callId);
          release();
        };
        browserReleases.set(callId, done);
        if (signal?.aborted === true) done();
        else signal?.addEventListener("abort", done, { once: true });
      },
      release: (callId) => {
        if (callId === undefined) for (const done of browserReleases.values()) done();
        else browserReleases.get(callId)?.();
      },
    };
    const gate: SessionGate = {
      approvalView: (toolName, input) =>
        bot.browser?.approvalView(toolName, input) ?? simpleToolView(toolName, input, mcp.serverFor(toolName)),
      decideTool: (toolName, input) => decideTool(toolName, input),
      waitUntilRunning: (signal) => waitForLane(bot, lane, signal),
      approvals,
      activeRun,
      laneFence,
      browserCalls,
      flushWork: async (cause) =>
        lane.mirrors.get(stream)?.flush(cause, activeRun()?.run.runId ?? null) ?? { kind: "disconnected" },
    };
    const builtIn: readonly RunnerTool[] = [
      ...extensionTools,
      createRecallTool({
        recalls: lane.recalls,
        live: () => {
          const active = lane.active;
          if (active === null || !liveRuns.has(active.run.runId) || active.control.signal.aborted) return null;
          return {
            runId: active.run.runId,
            signal: active.control.signal,
            gateway: (desiredConfig(bot) ?? runConfig()).gateway,
            headers: laneFence.headers(active.run.runId),
          };
        },
      }),
      ...createTopicTools({ activeRun, send: config.send }),
      ...createSkillTools({ activeRun, send: config.send }),
      ...createMetricTools({ activeRun, send: config.send }),
      ...createMemoryTools({ groupKind, activeRun, send: config.send }),
      ...createDraftTools({
        activeRun,
        send: config.send,
        accounts: () => (desiredConfig(bot) ?? runConfig()).accounts,
        images: { workDir: dirs.workDir, draftsDir: realpathSync(dirs.draftsDir), hidden: zones.hidden },
        liveHub: () => ({
          hub: desiredConfig(bot)!.hub,
          gateway: desiredConfig(bot)!.gateway,
          laneHeaders: laneFence.headers(activeRun()?.run.runId),
        }),
      }),
      ...(definition.config.role === "assistant"
        ? [
            ...createAssistantTools({ activeRun, send: config.send }),
            ...createTeamTools({ activeRun, send: config.send }),
            ...createHelperTools({
              agentDir: dirs.agentDir,
              workDir: dirs.workDir,
              gateway: () => runConfig().gateway,
              settings: generation.desired.settings,
              tools: () => [accountRead, ...(bot.browser?.toolsWithHeldMutex ?? [])],
              gate,
            }),
            ...createReviewTools({ groupKind, activeRun, send: config.send }),
            ...createRoutineOfferTools({ activeRun, send: config.send }),
          ]
        : []),
      ...(bot.browser?.toolsWithHeldMutex ?? []),
      accountRead,
    ];
    const decideTool = (toolName: string, input: Record<string, unknown>): GateDecision => {
      const desired = desiredConfig(bot) ?? runConfig();
      // 工具定义和 Client 随代际，授权与操作是否仍提供在调用时现判。
      const callable = mcp.resolve(toolName);
      if (callable !== null && callable.kind !== "ready") {
        return {
          verdict: "deny",
          action: "external_write",
          target: null,
          reason: unusableReason(callable),
          access: { network: false, writePaths: [] },
        };
      }
      const source: ToolSource | null =
        callable !== null
          ? {
              kind: "connected",
              operation: callable.operation,
            }
          : extensionNames.has(toolName)
            ? { kind: "extension" }
            : null;
      return decide(
        {
          toolName,
          input,
          workDir: dirs.workDir,
          zones,
          groupId,
          platform: process.platform,
          sandbox: bash.sandbox,
          source,
          computerId: desired.computerId,
          browserHost: bot.browser?.host() ?? null,
          routine: lane.active?.routine ?? null,
        },
        desired.grants,
        desired.accounts,
      );
    };
    const created = await createBotSession({
      botId: bot.botId,
      role: definition.config.role,
      name: definition.config.name,
      tags: definition.config.tags,
      description: definition.config.description,
      dirs: { ...dirs, sessionDir: groupSessionDir(dirs, groupId) },
      gateway: runConfig().gateway,
      bashTool: bash.tool,
      tools: [...builtIn, ...mcp.toolsFor(() => laneFence.headers(activeRun()?.run.runId))],
      ...gate,
      allowBash: bash.allow,
      clearBashRun: bash.clearRun,
      memory: () => lane.active?.memory ?? null,
      recalls: lane.recalls,
      ...(generation.desired.settings === undefined ? {} : { settings: generation.desired.settings }),
      ...(sessionManager === undefined ? {} : { sessionManager }),
    });
    lane.sessions.set(stream, { ...created, tableRole: null, fingerprint: definition.fingerprint });
    return created;
  };

  const runOne = async (bot: BotRuntime, lane: Lane, message: PromptMessage): Promise<void> => {
    if (!liveRuns.has(message.runId)) return;
    if (
      lane.phase === "stopped" ||
      state === "stopped" ||
      bot.configState.phase === "deleted" ||
      currentDefinition(bot) === null
    ) {
      finishWithoutRun(message);
      return;
    }

    const active: LaneActive = {
      generation: null,
      control: new AbortController(),
      table: message.table,
      messageId: message.messageId,
      memory: null,
      run: {
        runId: message.runId,
        botId: message.botId,
        groupId: message.groupId,
      },
      groupKind: message.group.kind,
      task: message.task,
      members: message.members,
      handoffId: message.handoffId,
      projects: message.projects ?? [],
      routine: message.routine,
    };
    let report: RunReport | null = null;
    let botSession: BotSession | null = null;
    let prompted = false;
    let completion: Extract<AgentToControl, { type: "run_done" }> | null = null;
    let mirror: WorkMirror | undefined;
    try {
      lane.active = active;
      if (!(await waitForLane(bot, lane, undefined)) || !liveRuns.has(message.runId)) return;
      const generation = currentGeneration(bot);
      if (generation === null) return;
      active.generation = generation;
      bot.generations.get(generation)!.runs += 1;
      const stream = message.table === null ? "chat" : "table";
      let sessionManager: SessionManager | undefined;
      if (workAppend !== undefined) {
        mirror = lane.mirrors.get(stream);
        if (mirror === undefined) {
          const dirs = ensureBotDirs(bot.dirs);
          const groupDir = groupSessionDir(dirs, lane.groupId);
          mirror = new WorkMirror({
            botId: bot.botId,
            groupId: lane.groupId,
            stream,
            groupDir,
            sessionDir: stream === "chat" ? groupDir : join(groupDir, "table"),
            workDir: dirs.workDir,
            append: () => workAppend,
            live: () => {
              const desired = desiredConfig(bot) ?? generation.desired;
              return {
                hub: desired.hub,
                gateway: desired.gateway,
                localOnlyToolNames: new Set(
                  desired.tools
                    .filter((tool) => tool.localOnly)
                    .flatMap((tool) => tool.operations.map((op) => op.name)),
                ),
              };
            },
            log: (detail) => fail("runner_failed", detail, lane.groupId),
            cold: () => {
              const runId = lane.active?.run.runId;
              if (runId !== undefined)
                config.send({
                  type: "bot_text_done",
                  botId: bot.botId,
                  groupId: lane.groupId,
                  runId,
                  messageId: MessageId.parse(crypto.randomUUID()),
                  text: "这台电脑读不了之前的记录",
                });
            },
          });
          lane.mirrors.set(stream, mirror);
        }
        sessionManager = await mirror.prepare(
          message.lane.epoch,
          message.lane.heads[stream] ?? { seq: 0, head: EMPTY_WORK_HEAD },
          message.runId,
          lane.sessions.get(stream)?.session.sessionManager,
        );
      }
      botSession = await sessionFor(bot, lane, message.group.kind, sessionManager);
      if (!(await waitForLane(bot, lane, undefined)) || !liveRuns.has(message.runId)) return;
      if (hasStopped() || currentDefinition(bot) === null) return;
      await botSession.applyGateway(generation.desired.gateway);
      await botSession.usePurpose(message.purpose);
      if (!liveRuns.has(message.runId)) return;
      const { session } = botSession;
      const statsBeforeRun = session.getSessionStats();
      const watermark = readWatermark(session.sessionManager);
      const desired = generation.desired;
      const shown = readMemoryShown(session.sessionManager);
      const memory = renderMemory(bot.botId, desired.brand, desired.preferences, shown);
      active.memory = memory.text;
      const text = composePrompt(message, contextSince(message.context, watermark), desired.accounts);
      report = reportRun(
        session,
        statsBeforeRun,
        active.run,
        text,
        () => runnerAbortedRuns.has(active.run.runId),
        (callId) => approvals.consumeBlocked(message.runId, callId),
        generation.mcp.tools.serverFor,
        (outgoing) => {
          if (outgoing.type === "run_done") completion = outgoing;
          else if (
            message.table === null ||
            (message.table.role === "advisor" && (outgoing.type === "bot_text" || outgoing.type === "bot_text_done"))
          )
            config.send(outgoing);
        },
      );
      prompted = true;
      await session.prompt(text);
      // 只在触发进了会话才记水位。prompt 抛错、正常返回却没进会话（比如 AgentSession 把它当 handled 收下）
      // 都不记，下一次宁可把这批再读一遍，也不让它们从没进过会话就被水位跳过。
      if (report.entered()) {
        recordWatermark(session.sessionManager, message, watermark);
        recordMemoryShown(session.sessionManager, memory.shown, shown);
      }
      await mirror?.flush("settled", message.runId);
    } catch (error) {
      // 还没调 session.prompt 就失败，带上 runId 让控制面立刻把这个 run 收尾，不等 finally 补的 run_done。
      // 调过 session.prompt 才抛的，进没进会话由 run_done 的 prompt 字段说：reporter 见过触发消息的 message_end
      // 才是 entered，没来过 agent_settled 的由 finally 补一条 dropped。
      fail(
        "runner_failed",
        `run ${message.runId} 跑失败：${String(error)}`,
        message.groupId,
        prompted ? undefined : message.runId,
      );
    } finally {
      if (completion !== null) finishRun(completion);
      report?.unsubscribe();
      botSession?.clearBashRun(message.runId);
      lane.recalls.clear();
      lane.active = null;
      runnerAbortedRuns.delete(message.runId);
      if (active.generation !== null) {
        const generation = active.generation;
        const use = bot.generations.get(generation);
        if (use !== undefined) use.runs -= 1;
        if (state === "ready" && desiredConfig(bot) !== null && lane.phase === "ready")
          await bot.resources.enqueue(null, () => closeGeneration(bot, generation));
      }
      if (state === "ready" && lane.phase === "ready" && desiredConfig(bot) !== null)
        await closeStaleSessions(bot, lane);
      finishWithoutRun(message);
    }
  };

  const findRun = (runId: RunId) => {
    for (const bot of bots.values()) {
      const found = findLaneRun(bot.lanes.values(), runId);
      if (found !== null) return { bot, ...found };
    }
    return null;
  };

  const schedulePrompt = (bot: BotRuntime, message: PromptMessage): Promise<void> => {
    const ready = bot.resources.idle();
    let lane = bot.lanes.get(message.groupId);
    if (lane === undefined || lane.phase === "stopped") {
      lane = createLane(message.groupId);
      bot.lanes.set(message.groupId, lane);
    }
    const target = lane;
    return target.queue.enqueue(message, async () => {
      await ready;
      try {
        await runOne(bot, target, message);
      } catch (error) {
        fail("runner_failed", `run ${message.runId} 跑失败：${String(error)}`, message.groupId);
        finishWithoutRun(message);
      }
    });
  };

  const scheduleReconcile = (bot: BotRuntime): void => {
    void bot.resources.enqueue(null, () => reconcileBot(bot)).catch(() => undefined);
  };

  const runner: Runner = {
    async applyConfig(next) {
      if (state === "stopped") return;
      workAppend = next.workAppend;
      nextConfigVersion += 1;
      const version = nextConfigVersion;
      const nextSkills = next.skills ?? [];
      const nextAccounts = next.accounts;
      const nextGrants = next.grants;
      const incoming = new Map(
        next.bots.map((botConfig) => [
          botConfig.id,
          desiredFor(
            version,
            botConfig,
            next.tools,
            nextSkills,
            next.modelGateway,
            next.accountsProxy,
            next.mcpProxy,
            next.hub,
            next.computerId,
            nextAccounts,
            nextGrants,
            next.brand,
            next.preferences,
            next.settings,
            next.extensionTools ?? [],
          ),
        ]),
      );
      for (const bot of bots.values()) {
        const desired = incoming.get(bot.botId) ?? null;
        incoming.delete(bot.botId);
        bot.configState = { phase: "pending", current: currentGeneration(bot), desired };
        if (desired === null) {
          approvals.abandon("stopped", bot.botId);
          pokerResults.cancel(bot.botId);
          settlePauseWaiters(bot, false);
        }
        scheduleReconcile(bot);
      }
      for (const desired of incoming.values()) {
        const bot: BotRuntime = {
          botId: desired.config.id,
          dirs: botDirs(config.dataDir, desired.config.id),
          configState: { phase: "pending", current: null, desired },
          lastGroupId: null,
          lanes: new Map(),
          generations: new Map(),
          mcpResources: new Map(),
          browser: null,
          lifetime: new AbortController(),
          browserMutex: null,
          paused: false,
          pauseWaiters: new Set(),
          resources: new SerialQueue(),
        };
        bots.set(bot.botId, bot);
        if (config.browser !== undefined) browserMutexFor(bot);
        scheduleReconcile(bot);
      }
    },

    async prompt(message) {
      liveRuns.add(message.runId);
      laneFence.register(message);
      if (state === "stopped") {
        finishWithoutRun(message);
        return;
      }
      const bot = bots.get(message.botId);
      if (bot === undefined) {
        fail("unsupported", `config 里没有 Bot ${message.botId}，丢弃 run ${message.runId}`, message.groupId);
        finishWithoutRun(message);
        return;
      }
      if (desiredConfig(bot) === null) {
        finishWithoutRun(message);
        await bot.resources.idle();
        return;
      }
      await schedulePrompt(bot, message);
    },

    cancel(target) {
      if (typeof target !== "string") {
        for (const runId of laneFence.olderThan(target)) {
          laneFence.supersede(runId);
          runner.cancel(runId);
        }
        return;
      }
      const runId = target;
      if (!liveRuns.delete(runId)) return;
      const found = findRun(runId);
      const pendingEffects = laneFence.pendingCalls(runId);
      laneFence.remove(runId);
      if (found === null) return;
      const { lane } = found;
      if (found.phase === "queued") {
        lane.queue.discard((message) => message.runId === runId);
        return;
      }
      lane.recalls.clear();
      lane.mirrors.get(lane.active?.table === null ? "chat" : "table")?.cancelPending();
      runnerAbortedRuns.add(runId);
      const stream = lane.active?.table === null ? "chat" : "table";
      const session = lane.sessions.get(stream)?.session;
      const callIds = [...approvals.expire(runId), ...pendingEffects];
      if (callIds.length === 0 || session === undefined) {
        void abortSession(lane).catch(() => undefined);
      } else {
        // 先让 Pi 写入中文过期结果，再 abort，避免错误被 Operation aborted 覆盖。
        const pending = new Set(callIds);
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "agent_settled") unsubscribe();
          if (event.type !== "tool_execution_end" || !pending.delete(event.toolCallId)) return;
          if (pending.size === 0) {
            unsubscribe();
            void abortSession(lane).catch(() => undefined);
          }
        });
      }
    },

    activeRuns() {
      return [...liveRuns];
    },

    approve(runId, callId, outcome) {
      const found = findRun(runId);
      if (found?.phase !== "running") return;
      if (outcome !== "voided") {
        approvals.settle(runId, callId, outcome);
        return;
      }
      const lane = found.lane;
      const stream = lane?.active?.table === null ? "chat" : "table";
      const session = lane?.sessions.get(stream)?.session;
      if (session === undefined) {
        approvals.settle(runId, callId, outcome);
        return;
      }
      // Pi 在闸门返回前收到 abort 会把作废原因覆盖成 Operation aborted，等工具结果定好再中止。
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_settled") unsubscribe();
        if (event.type !== "tool_execution_end" || event.toolCallId !== callId) return;
        unsubscribe();
        void abortSession(lane).catch(() => undefined);
      });
      if (!approvals.settle(runId, callId, outcome)) unsubscribe();
    },

    pokerResult(runId, callId, result) {
      pokerResults.settle(runId, callId, result);
    },

    async pause(botId) {
      const bot = bots.get(botId);
      if (bot === undefined || bot.paused) return;
      bot.paused = true;
    },

    async resume(botId) {
      const bot = bots.get(botId);
      if (bot === undefined || !bot.paused) return;
      bot.paused = false;
      settlePauseWaiters(bot, true);
    },

    async stop() {
      state = "stopped";
      laneFence.interruptAll();
      approvals.abandon("stopped");
      pokerResults.cancel();
      const stoppingBots = [...bots.values()];
      for (const bot of stoppingBots) {
        bot.lifetime.abort();
        settlePauseWaiters(bot, false);
      }
      await Promise.allSettled(
        stoppingBots.flatMap((bot) => [...bot.lanes.values()].map((lane) => stopLane(bot, lane))),
      );
      const stopping = stoppingBots.map((bot) => {
        return bot.resources.enqueue(null, async () => {
          try {
            await closeBotResources(bot);
          } finally {
            deleteBot(bot, false);
          }
        });
      });
      await Promise.allSettled(stopping);
    },
  };

  return runner;
}
