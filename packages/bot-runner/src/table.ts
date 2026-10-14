import { join } from "node:path";
import {
  AgentToControl,
  POKER_REVIEW_TEXT_LIMIT,
  type BotId,
  type ControlToAgent,
  gatewayAlias,
  ModelPurpose,
  type PokerAction,
  type PokerEvent,
  type PokerPersona,
  type PokerSeatView,
  type RunId,
  type TablePrompt,
} from "@baize/shared";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { GATEWAY_PROVIDER_ID, type BotSession, type PiSettings, type RunnerTool } from "./bot-session.js";
import type { BotDirs } from "./paths.js";
import { tablePersona } from "./persona.js";
import { installLaneHeaders } from "./lane-fence.js";
import type { ActiveRun } from "./topic.js";

type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;
export type PokerResult = Extract<ControlToAgent, { type: "poker_result" }>["result"];

// 控制面在桌锁里落完动作才回执，正常是毫秒级；它的 60 秒兜底不给运行器发报文，这里不必等过它。
// 超时只兜回执丢失（控制面对不认的 run 静默丢帧），等的时候同一个 Bot 的串行队列被占着，所以要短，20 秒给桌锁排队留足余量。
const POKER_RESULT_TIMEOUT_MS = 20_000;

const POSITIONS = {
  button: "庄位",
  small_blind: "小盲位",
  big_blind: "大盲位",
  under_the_gun: "枪口位",
  middle: "中间位",
  cutoff: "关煞位",
} as const;
const STREETS = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", complete: "本手结束" } as const;
const STATUSES = { active: "在场", folded: "已弃牌", all_in: "已全下" } as const;
const ACT_PARAMS = Type.Object({
  action: Type.String(),
  amount: Type.Optional(Type.Number()),
  say: Type.Optional(Type.String()),
});
const REVIEW_PARAMS = Type.Object({
  hands: Type.Array(Type.Object({ number: Type.Number(), title: Type.String(), text: Type.String() })),
});

function actionText(action: PokerAction): string {
  switch (action.kind) {
    case "fold":
      return "弃牌";
    case "check":
      return "过牌";
    case "call":
      return "跟注";
    case "raise":
      return `加注到 ${action.amount}`;
    case "all_in":
      return "全下";
  }
}

function eventText(event: PokerEvent): string {
  switch (event.kind) {
    case "blind":
      return `${event.seatId} 下盲注 ${event.amount}`;
    case "action":
      return `${event.seatId} ${actionText(event.action)}，投入 ${event.put}`;
    case "street":
      return `${STREETS[event.street]}：${event.cards.join(" ")}`;
    case "showdown":
      return `${event.seatId} 摊牌：${event.hole.join(" ")}`;
    case "award":
      return `${event.seatId} 从底池 ${event.pot} 获得 ${event.amount}`;
  }
}

function renderView(view: PokerSeatView): string {
  const legal =
    view.legal.kind === "complete"
      ? "本手已结束"
      : view.legal.kind === "waiting"
        ? `等待 ${view.legal.toAct} 行动`
        : [
            `待跟注 ${view.legal.toCall}`,
            ...view.legal.options.map((option) => {
              switch (option.kind) {
                case "call":
                  return `跟注 ${option.amount}`;
                case "raise":
                  return `加注到 ${option.min} 至 ${option.max}（本街总额）`;
                case "all_in":
                  return `全下 ${option.amount}`;
                default:
                  return actionText(option);
              }
            }),
          ].join("；");
  return [
    `你的位置：${view.seatId}，${POSITIONS[view.position]}`,
    `牌力：${view.summary}`,
    `手牌：${view.hole.join(" ")}`,
    `阶段：${STREETS[view.street]}`,
    `公共牌：${view.board.join(" ") || "尚未发出"}`,
    `底池：${view.pot}；你的筹码：${view.stack}；盲注：${view.blinds.small}/${view.blinds.big}`,
    "各家：",
    ...view.seats.map(
      (seat) =>
        `${seat.seatId}，${POSITIONS[seat.position]}，筹码 ${seat.stack}，本街下注 ${seat.committed}，${STATUSES[seat.status]}${seat.shown === null ? "" : `，已亮牌 ${seat.shown.join(" ")}`}`,
    ),
    `合法动作：${legal}`,
    "本手公开事件：",
    ...(view.events.length === 0 ? ["暂无"] : view.events.map(eventText)),
  ].join("\n");
}

export function composeTablePrompt(message: PromptMessage): string {
  const table = message.table;
  if (table === null) throw new Error("牌桌运行缺少给定视图。");
  if (table.role === "reviewer") {
    return [
      "散场复盘：只根据以下关键手的用户视角写建议，不推测未公开的底牌。",
      ...(table.review ?? []).map(
        (hand) => `第 ${hand.number} 手：${hand.title}\n用户筹码变化：${hand.userDelta}\n${renderView(hand.view)}`,
      ),
      "请调用 poker_review 一次，按给定的手序号提交每手的标题和复盘文字。没有关键手时提交空数组。",
    ].join("\n\n");
  }
  if (table.view === null) throw new Error("出牌或建议缺少座位视图。");
  return [
    `本手：${table.handId}；决策点：${table.seq}`,
    renderView(table.view),
    "公开日志：",
    ...(table.publicLog.length === 0 ? ["暂无"] : table.publicLog),
    table.role === "advisor"
      ? `用户问：${table.question ?? "这手怎么打"}\n请在 120 字内给出建议和理由，只用给定视图。`
      : "请从合法动作中选择并调用 poker_act。加注金额是本街加到的总额，台词最多 40 字，可以不说。其他文字不会公开。",
  ].join("\n");
}

interface PendingAction {
  readonly runId: RunId;
  readonly callId: string;
  readonly botId: BotId;
  readonly settle: (result: PokerResult) => void;
}

const actionKey = (runId: RunId, callId: string) => JSON.stringify([runId, callId]);

export function createPokerResults(send: (message: AgentToControl) => void) {
  const waiting = new Map<string, PendingAction>();
  const settle = (runId: RunId, callId: string, result: PokerResult): void => {
    const entry = waiting.get(actionKey(runId, callId));
    if (entry?.runId !== runId) return;
    waiting.delete(actionKey(runId, callId));
    entry.settle(result);
  };
  return {
    settle,
    ask(
      message: Extract<AgentToControl, { type: "poker_act" }>,
      botId: BotId,
      signal: AbortSignal | undefined,
    ): Promise<void> {
      if (signal?.aborted) return Promise.reject(new Error("这次出牌被中止了。"));
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => settle(message.runId, message.callId, { ok: false, error: "这次出牌被中止了。" });
        const timer = setTimeout(
          () =>
            settle(message.runId, message.callId, {
              ok: false,
              error: "出牌确认超时，这次出牌没有确认，请等待新的决策点。",
            }),
          POKER_RESULT_TIMEOUT_MS,
        );
        timer.unref();
        waiting.set(actionKey(message.runId, message.callId), {
          runId: message.runId,
          callId: message.callId,
          botId,
          settle: (result) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (result.ok) resolve();
            else reject(new Error(result.error));
          },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          send(message);
        } catch (error) {
          settle(message.runId, message.callId, { ok: false, error: `出牌发送失败：${String(error)}` });
        }
      });
    },
    cancel(botId?: BotId): void {
      for (const entry of waiting.values()) {
        if (botId === undefined || entry.botId === botId)
          settle(entry.runId, entry.callId, { ok: false, error: "运行器已停止或牌友已移除，这次出牌没有完成。" });
      }
    },
  };
}

export function createTableTools(options: {
  readonly role: TablePrompt["role"];
  readonly activeRun: () => ActiveRun | null;
  readonly table: () => TablePrompt | null;
  readonly send: (message: AgentToControl) => void;
  readonly results: ReturnType<typeof createPokerResults>;
}): readonly RunnerTool[] {
  const current = (role: TablePrompt["role"]) => {
    const active = options.activeRun();
    const table = options.table();
    if (active === null || table?.role !== role) throw new Error("这个工具不属于当前牌桌角色。");
    return { active, table };
  };
  if (options.role === "player")
    return [
      {
        name: "poker_act",
        label: "出牌",
        description:
          "根据给定合法动作出牌，等待引擎确认。失败后按中文原因在本次运行里重试。加注 amount 是本街总额，say 最多 40 字。",
        parameters: ACT_PARAMS,
        async execute(callId, input, signal) {
          const params = input as Static<typeof ACT_PARAMS>;
          const { active, table } = current("player");
          if (typeof params.say === "string" && params.say.length > 40)
            throw new Error("台词最多 40 字，请缩短后再出牌。");
          const action = params.action === "raise" ? { kind: "raise", amount: params.amount } : { kind: params.action };
          const parsed = AgentToControl.safeParse({
            type: "poker_act",
            runId: active.run.runId,
            callId,
            handId: table.handId,
            seq: table.seq,
            action,
            ...(params.say === undefined ? {} : { say: params.say }),
          });
          if (!parsed.success || parsed.data.type !== "poker_act")
            throw new Error(
              "出牌动作不合法：请选择 fold、check、call、raise 或 all_in；加注需提供整数 amount（本街总额）。",
            );
          await options.results.ask(parsed.data, active.run.botId, signal);
          return { content: [{ type: "text", text: "出牌已确认。" }], details: {} };
        },
      },
    ];
  if (options.role === "reviewer") {
    let submitted: RunId | null = null;
    return [
      {
        name: "poker_review",
        label: "交复盘",
        description: "只复盘控制面挑好的关键手，按给定手序号提交标题和正文，本次运行只提交一次。",
        parameters: REVIEW_PARAMS,
        async execute(_callId, input) {
          const params = input as Static<typeof REVIEW_PARAMS>;
          const { active, table } = current("reviewer");
          if (submitted === active.run.runId) throw new Error("本次复盘已经提交，请勿重复提交。");
          const parsed = AgentToControl.safeParse({
            type: "poker_review",
            runId: active.run.runId,
            sessionId: table.sessionId,
            hands: params.hands,
          });
          if (!parsed.success || parsed.data.type !== "poker_review")
            throw new Error("复盘格式不正确，请给每手提供整数序号、标题和正文。");
          const numbers = parsed.data.hands.map((hand) => hand.number);
          const selected = (table.review ?? []).map((hand) => hand.number);
          if (
            new Set(numbers).size !== numbers.length ||
            numbers.length !== selected.length ||
            numbers.some((number) => !selected.includes(number))
          )
            throw new Error("请只提交给定的关键手，每手一次，不得遗漏或增加手序号。");
          if (parsed.data.hands.some((hand) => hand.text.length > POKER_REVIEW_TEXT_LIMIT))
            throw new Error(`每手正文最多 ${POKER_REVIEW_TEXT_LIMIT} 字，请缩短后再提交。`);
          options.send(parsed.data);
          submitted = active.run.runId;
          return { content: [{ type: "text", text: "复盘已提交。" }], details: {} };
        },
      },
    ];
  }
  return [];
}

/** 普通会话默认开放电脑工具；牌桌单独注册工具，不加载 skill 和群协作提示。 */
export async function createTableSession(options: {
  readonly dirs: BotDirs;
  readonly preset: PokerPersona | null;
  readonly gateway: Extract<ControlToAgent, { type: "config" }>["modelGateway"];
  readonly role: TablePrompt["role"];
  readonly tools: readonly RunnerTool[];
  readonly waitUntilRunning: (signal: AbortSignal | undefined) => Promise<boolean>;
  readonly table: () => TablePrompt | null;
  readonly laneHeaders: () => Readonly<Record<string, string>>;
  readonly settings: PiSettings | undefined;
}): Promise<BotSession> {
  const { dirs } = options;
  const runtime = await ModelRuntime.create({
    authPath: join(dirs.agentDir, "auth.json"),
    modelsStorePath: join(dirs.agentDir, "models-store.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const register = (gateway: typeof options.gateway): void =>
    runtime.registerProvider(GATEWAY_PROVIDER_ID, {
      name: "白泽模型网关",
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      api: "openai-completions",
      models: ModelPurpose.options.map(gatewayAlias).map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      })),
    });
  register(options.gateway);
  const modelFor = (purpose: ModelPurpose) => {
    const model = runtime.getModel(GATEWAY_PROVIDER_ID, gatewayAlias(purpose));
    if (model === undefined) throw new Error("牌桌模型网关没有注册成功。");
    return model;
  };
  const settings = SettingsManager.inMemory(options.settings);
  const tools = options.tools;
  const names = tools.map((tool) => tool.name);
  const loader = new DefaultResourceLoader({
    cwd: dirs.workDir,
    agentDir: dirs.agentDir,
    settingsManager: settings,
    systemPrompt: tablePersona(options.preset),
    noSkills: true,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        installLaneHeaders(pi, options.laneHeaders);
        for (const tool of tools) pi.registerTool(tool);
        pi.on("tool_call", async (event, ctx) => {
          if (options.table()?.role !== options.role || !names.includes(event.toolName))
            return { block: true, reason: "这个工具不属于当前牌桌角色。" };
          if (!(await options.waitUntilRunning(ctx.signal)))
            return { block: true, reason: "运行器已经停止，工具调用没有执行。" };
          return undefined;
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dirs.workDir,
    agentDir: dirs.agentDir,
    model: modelFor("plan"),
    modelRuntime: runtime,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.continueRecent(dirs.workDir, dirs.sessionDir),
    tools: names,
  });
  session.agent.toolExecution = "sequential";
  return {
    session,
    sessionFile: session.sessionManager.getSessionFile(),
    clearBashRun: () => {},
    async usePurpose(purpose) {
      const next = modelFor(purpose);
      if (session.model?.id !== next.id || session.model.baseUrl !== next.baseUrl) await session.setModel(next);
    },
    async applyGateway(gateway) {
      register(gateway);
    },
    async dispose() {
      await session.dispose();
    },
  };
}
