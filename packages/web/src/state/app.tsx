/// <reference types="vite/client" />
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import {
  LoginAttemptId,
  ServerPush,
  type AccountId,
  type ComputerId,
  type ComputerKind,
  type LiveSession,
  type AccountTier,
  type BrowserPlatform,
  type ApprovalId,
  type ApprovePlanRequest,
  type ContentPlanId,
  type DecideDraftRequest,
  type DecideProjectOfferRequest,
  type DecideTeamOfferRequest,
  type DraftId,
  type ProjectResponse,
  type TodayResponse,
  type Bot,
  type BotId,
  type BotTemplate,
  type ExportTemplateRequest,
  type ChecklistItem,
  type ProjectGoal,
  type DecideApprovalRequest,
  type GrantId,
  type GroupId,
  type LiveId,
  type Message,
  type MessageId,
  type Preference,
  type HintRequest,
  type PokerActRequest,
  type PokerHandId,
  type PokerSeatNo,
  type SwapSeatRequest,
  type CreateToolRequest,
  type DecideRoutineOfferRequest,
  type DecidePreferenceOfferRequest,
  type DecideSkillOfferRequest,
  type RoutineId,
  type Settings,
  type ToolConnectionId,
  type BrandBook,
  type UpdateBrandRequest,
  type UpdateRoutineRequest,
  type UpdateToolRequest,
  type TaskId,
  type TopicTask,
  type User,
} from "@baize/shared";
import { RequestFailed, type Api, type BotDraft } from "../api/client.js";
import { applyTheme } from "./theme.js";
import { createPushHandlers, dispatchServerPush } from "./push.js";
import { reduce } from "./reducer.js";
import { reconnectDelay } from "./reconnect.js";
import { createSessions, type Attempt, type Flight, type Session } from "./session.js";
import { createClock, type Seq } from "./stamped.js";

// 点了登录之后多久画面还没出来就算没等到：重拉一遍账号，还在等的卡改成没等到。电脑开页上屏通常几秒，Chrome
// 冷启动最多等 15 秒，这里留足余量。画面开着时不结（见 content.ts 的 login_flow）：人还在登，时限归电脑
// （computer-agent 的 loginTimeoutMs，15 分钟）；画面收起时卡改成 closed，电脑随后报的结果会盖掉它。
const LOGIN_TIMEOUT_MS = 150_000;
// 单拉漏档失败后隔一会儿再报失败计数，免得服务端一时不可用时几趟重试挤在同一瞬间用完。
const MESSAGE_GAP_RETRY_MS = 1_000;
import type { Action, AppState, LoadKey, LoginFlow } from "./types.js";

export { memberIdsOf } from "./types.js";
export type { AppState, Conversation, GroupTurn, LoginPhase } from "./types.js";
import type { LoginPhase } from "./types.js";

export type RemotePairing = { computerId: ComputerId; token: string };

export type AppActions = {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  // 建完返回新 Bot 和它的单聊，由调用方跳过去。登录过期时是 undefined。
  createBot: () => Promise<{ bot: Bot; groupId: GroupId } | undefined>;
  deleteBot: (botId: BotId) => Promise<void>;
  // 分享包建出的新 Bot 只进团队，不跳走。登录过期时是 undefined。
  importBot: (template: BotTemplate) => Promise<BotId | undefined>;
  // 导入在服务端新建了插件连接，不补进本地工具表，马上再分享时说明会漏数插件。和导入分开，失败了只重试这一步。
  // 没对上之前 Bot 记在 toolsUnsynced 里，谁调都一样，成功才划掉。
  syncBotTools: (botId: BotId) => Promise<void>;
  exportTemplate: (botId: BotId, choice: ExportTemplateRequest) => Promise<BotTemplate | undefined>;
  updateBot: (botId: BotId, draft: BotDraft) => Promise<void>;
  setChecklist: (task: TopicTask, checklist: ChecklistItem[]) => Promise<void>;
  setTaskGoal: (task: TopicTask, goal: ProjectGoal | null) => Promise<void>;
  // 只重读群列表认回这张任务卡，不重发写入。
  reloadTask: (task: TaskId) => Promise<void>;
  // after 是推送最近一次重连的号：在途那趟发得比它早，回来后要补拉一次。
  loadMessages: (groupId: GroupId, after: Seq) => Promise<void>;
  // 单拉一条消息，补流式 delta 漏掉的那几版。after 是最近一次发现漏档的号。
  loadMessage: (messageId: MessageId, after: Seq) => Promise<void>;
  sendMessage: (groupId: GroupId, text: string) => Promise<void>;
  decideApproval: (approvalId: ApprovalId, request: DecideApprovalRequest) => Promise<void>;
  decideDraft: (draftId: DraftId, request: DecideDraftRequest) => Promise<void>;
  approvePlan: (planId: ContentPlanId, request: ApprovePlanRequest) => Promise<void>;
  returnPlan: (planId: ContentPlanId) => Promise<void>;
  // 首页快照里带着草稿和计划，顺手补进同一张表，首页展开的卡和群里的卡读的是同一份。登录过期时是 undefined。
  loadToday: () => Promise<TodayResponse | undefined>;
  loadProject: (groupId: GroupId) => Promise<ProjectResponse | undefined>;
  loadAccounts: () => Promise<void>;
  loadComputers: () => Promise<void>;
  // token 明文只在这次回包里，交给调用方显示一次，不进 store。登录过期时是 undefined。
  addRemoteComputer: () => Promise<RemotePairing | undefined>;
  // 删成了就和登出一样回登录页；邮箱不符等失败照常抛给界面。
  deleteAccount: (email: string) => Promise<void>;
  updateAccountTier: (accountId: AccountId, tier: AccountTier) => Promise<void>;
  loginAccount: (accountId: AccountId) => Promise<void>;
  // 画面上点了「不登了」：只复位这次点击的按钮，不记失败。告诉电脑的那一句由画面面板自己发。
  dismissLogin: (accountId: AccountId, attempt: LoginAttemptId) => Promise<void>;
  // 电脑上正开着的画面。启动和推送重连时各拉一次，平时靠 live_session、live_closed 两种推送。
  loadLive: () => Promise<void>;
  // 接手画面只在用户点了「打开画面」后才摆；收起面板时清掉，提示和卡上的按钮还在。
  openTakeover: (liveId: LiveId) => Promise<void>;
  hideTakeover: (liveId: LiveId) => Promise<void>;
  // 在云电脑上开一个终端。回包只有号，面板等 live_session 推到再摆；没开成照常抛给电脑页。
  openTerminal: (computerId: ComputerId) => Promise<void>;
  // 回到还开着的终端，或者只收起面板：终端在电脑上接着跑，电脑页上能再点回来。
  showTerminal: (session: LiveSession) => Promise<void>;
  hideTerminal: (liveId: LiveId) => Promise<void>;
  // 建这个平台的未登录占位，已经有就回那一行。登录窗口由调用方接着在它上面开。登录过期时是 undefined。
  addAccount: (platform: BrowserPlatform, computerId: ComputerId) => Promise<AccountId | undefined>;
  loadGrants: () => Promise<void>;
  deleteGrant: (grantId: GrantId) => Promise<void>;
  pauseBot: (botId: BotId) => Promise<void>;
  resumeBot: (botId: BotId) => Promise<void>;
  loadRoutines: () => Promise<void>;
  updateRoutine: (routineId: RoutineId, patch: UpdateRoutineRequest) => Promise<void>;
  deleteRoutine: (routineId: RoutineId) => Promise<void>;
  runRoutine: (routineId: RoutineId) => Promise<void>;
  loadSkills: (botId: BotId) => Promise<void>;
  loadPreferences: (botId: BotId) => Promise<void>;
  deletePreference: (preference: Preference) => Promise<void>;
  // 这个群里每个成员选的电脑和正在跑的那台。进群、重连、几种推送之后各拉一次，after 是触发它的那个号。
  loadComputerChoices: (groupId: GroupId, after: Seq) => Promise<void>;
  // 409 的中文原文抛给选择器照登。
  chooseComputer: (groupId: GroupId, botId: BotId, kind: ComputerKind) => Promise<void>;
  // 手册回来的都是整本，走同一个 brand_set，切片只收版本更新的那本。读回的那本也交给弹窗当底稿；保存 409 时抛给弹窗。
  loadBrand: () => Promise<BrandBook | null | undefined>;
  updateBrand: (body: UpdateBrandRequest) => Promise<void>;
  decidePreferenceOffer: (messageId: MessageId, decision: DecidePreferenceOfferRequest["decision"]) => Promise<void>;
  decideSkillOffer: (messageId: MessageId, decision: DecideSkillOfferRequest["decision"]) => Promise<void>;
  decideRoutineOffer: (messageId: MessageId, decision: DecideRoutineOfferRequest["decision"]) => Promise<void>;
  // 打开群页或项目页算看过这个群里例行的结果（D3），连续三次没看例行自己停。
  markSeen: (groupId: GroupId) => Promise<void>;
  // 开始了就返回项目群，由调用方跳过去；不要或登录过期时是 undefined。
  decideProjectOffer: (messageId: MessageId, request: DecideProjectOfferRequest) => Promise<GroupId | undefined>;
  // 确认后新请的人和变大的团队由推送带来；这里只落那条卡和团队的新名单。
  // 回的是服务端落定后的那条消息，卡拿它的状态，不用等清单重拉；会话没了回 undefined。
  decideTeamOffer: (messageId: MessageId, request: DecideTeamOfferRequest) => Promise<Message | undefined>;
  // 补拉团队名单。连着失败 REFRESH_TRIES 趟才停，停了由界面给重试。
  loadGroups: () => Promise<void>;
  // 补拉待办角标的服务端绝对数，失败和停下的规则同 loadGroups。
  loadPendingCounts: () => Promise<void>;
  createTool: (draft: CreateToolRequest) => Promise<void>;
  updateTool: (toolId: ToolConnectionId, patch: UpdateToolRequest) => Promise<void>;
  deleteTool: (toolId: ToolConnectionId) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  loadUsage: () => Promise<void>;
  // 牌桌视图只有 store 里一份，项目页和牌桌页都用它拉：true 是牌桌，视图已入列，和推送一样只认更大的版本；
  // 404 是这个群不是牌桌，回 false。别的失败照常抛。登录过期时是 undefined。
  loadPokerTable: (groupId: GroupId) => Promise<boolean | undefined>;
  // 建桌后补拉群列表再回群 id，调用方跳过去才不会被弹回首页。requestId 同一次点击内不变，重试不会建出第二张桌。
  createPokerTable: (requestId: string) => Promise<GroupId | undefined>;
  swapPokerSeat: (groupId: GroupId, seat: PokerSeatNo, persona: SwapSeatRequest["persona"]) => Promise<void>;
  // 桌上还没有会话时开第一手；回的是整份视图，入列后页面按版本更新。
  startPokerHand: (groupId: GroupId) => Promise<void>;
  // 出牌、问老白、散场回的都是整份视图，一样入列。
  actPoker: (handId: PokerHandId, request: PokerActRequest) => Promise<void>;
  askPokerHint: (handId: PokerHandId, request: HintRequest) => Promise<void>;
  // 散场成了回牌桌群，由调用方跳去项目页；登录过期时是 undefined。
  leavePokerTable: (groupId: GroupId) => Promise<GroupId | undefined>;
  // 解散群：成了就把它从侧栏移掉，开着它的页面随之回首页。推送晚到也只是再移一次。
  archiveGroup: (groupId: GroupId) => Promise<void>;
};

const AppContext = createContext<{ state: AppState; actions: AppActions } | null>(null);

export const useApp = () => {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp 必须在 AppProvider 里用");
  return value;
};

const isUnauthorized = (cause: unknown): boolean => cause instanceof RequestFailed && cause.status === 401;

type Ready = Extract<Action, { type: "ready" }>;

const loadEntry = async (api: Api, user: User): Promise<Omit<Ready, "session">> => {
  const [bots, groups, tools, settings, usage] = await Promise.all([
    api.bots(),
    api.groups(),
    api.tools(),
    api.settings(),
    api.usage(),
  ]);
  return {
    type: "ready",
    user,
    bots: bots.items,
    groups: groups.items,
    tools: tools.items,
    settings,
    usage,
  };
};

// 会话里的动作只拿这几样：挂在会话 signal 上的请求，带着会话号的 dispatch，和这次会话的在途表。
export type Scope = { api: Api; put: (action: Action) => void; session: Session };

// 例行和会做的活不跟重连走，在途的那趟无论多早发出都算数。
const ANY_FLIGHT = 0 as Seq;

const REFRESH_TRIES = 3;
const retryDelay = (failures: number): number => 500 * 2 ** (failures - 1);

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

// 同一会话里同一个桶只留一趟在途请求。在途那趟发得不比 after 晚就直接跟着它；早了就记一笔待补，它回来后再拉一次。
// 失败的那趟按 tries 退避重来，重来的一趟取新号，也就兑现了在途时记下的待补。连着失败 tries 趟才停，
// 失败只记在桶上由界面给重试，不再往外抛；401 和会话取消照旧交给 signedIn。
// run 回 "terminal" 表示结果已是终态，待补的那一笔作废，不再拉。
export type LoadBucket = (
  scope: Scope,
  key: LoadKey,
  after: Seq,
  run: (seq: Seq) => Promise<void | "terminal">,
  tries?: number,
) => Promise<void>;

export const createLoadBucket =
  (nextSeq: () => Seq): LoadBucket =>
  async ({ put, session }, key, after, run, tries = 1) => {
    const flying = session.flights.get(key);
    if (flying !== undefined) {
      if (flying.seq <= after) flying.again = true;
      return;
    }
    const flight: Flight = { seq: nextSeq(), again: false };
    session.flights.set(key, flight);
    put({ type: "load_status", key, status: "loading" });
    try {
      let failures = 0;
      for (;;) {
        try {
          const outcome = await run(flight.seq);
          failures = 0;
          if (outcome === "terminal" || !flight.again) break;
        } catch (cause) {
          if (session.signal.aborted || isUnauthorized(cause)) throw cause;
          failures += 1;
          if (failures >= tries) throw cause;
          await pause(retryDelay(failures), session.signal);
        }
        flight.again = false;
        flight.seq = nextSeq();
      }
      put({ type: "load_status", key, status: "idle" });
    } catch (cause) {
      if (session.signal.aborted || isUnauthorized(cause)) throw cause;
      put({ type: "load_status", key, status: "failed" });
    } finally {
      session.flights.delete(key);
    }
  };

// 单拉一条漏档。404 是终态：桶里排着的补拉一并作废，报 message_gone。
// 失败先在桶里等一会儿再收尾，这期间别处的漏档变化再触发也只撞上在途记录；
// 结果等在途记录删掉之后再报，失败计数一涨 MainWindow 立刻再拉，那时得能发出新的一趟。
export const loadMessageGap = async (
  loadBucket: LoadBucket,
  scope: Scope,
  messageId: MessageId,
  after: Seq,
  retryMs = MESSAGE_GAP_RETRY_MS,
): Promise<void> => {
  const result: { outcome: "settled" | "gone" | "failed" } = { outcome: "settled" };
  await loadBucket(scope, `message:${messageId}`, after, async (seq) => {
    try {
      scope.put({ type: "message_upserted", message: await scope.api.message(messageId), seq });
    } catch (cause) {
      if (cause instanceof RequestFailed && cause.status === 404) {
        result.outcome = "gone";
        return "terminal";
      }
      if (isUnauthorized(cause)) throw cause;
      result.outcome = "failed";
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      throw cause;
    }
  });
  if (result.outcome === "gone") scope.put({ type: "message_gone", messageId });
  if (result.outcome === "failed") scope.put({ type: "message_gap_failed", messageId });
};

// 保存已经写进服务端，只是回包被丢后补读群列表没成功。调用方要说「存上了、刷新没成功」，不能说没存上。
export class TaskRefreshFailed extends Error {
  constructor(cause: unknown) {
    super("任务卡已保存，刷新没成功", { cause });
    this.name = "TaskRefreshFailed";
  }
}

// 任务卡快照有三条来路：task_updated 推送、PATCH 回包、重读的群列表。TopicTask 上没有服务端写的单调字段，只能在本地排先后。
// pushSeq 数这张卡接受过几份推送和回包，补读落地不动它：一趟补读发出后它变过，读到的就可能比那份推送旧，丢掉。
// 补读之间按票号排，landed 记这张卡已落地的最大票号，更早发出的补读晚到也不回退。
// 这些只能说明本地接受的先后，说明不了推送和这次写入谁先落库，所以 PATCH 回包被丢时要补读确认：
// 本趟或更晚的补读落了地、或者之后又接受了推送，就算认回；票号不小于本趟的补读全结束了还没认回，就是刷新失败。
const createTaskPushes = () => {
  const pushSeq = new Map<TaskId, number>();
  const landed = new Map<TaskId, number>();
  const seqOf = (id: TaskId) => pushSeq.get(id) ?? 0;
  const pushed = (id: TaskId) => void pushSeq.set(id, seqOf(id) + 1);
  const running = new Map<number, Promise<{ cause: unknown } | null>>();
  let tickets = 0;
  const reload = ({ api, put }: Pick<Scope, "api" | "put">) => {
    tickets += 1;
    const ticket = tickets;
    const sent = new Map(pushSeq);
    const run = async () => {
      try {
        const { items } = await api.groups("task");
        for (const { task } of items) {
          if (ticket <= (landed.get(task.id) ?? 0) || seqOf(task.id) !== (sent.get(task.id) ?? 0)) continue;
          landed.set(task.id, ticket);
          put({ type: "task_updated", task });
        }
        return null;
      } catch (cause) {
        return { cause };
      } finally {
        running.delete(ticket);
      }
    };
    const outcome = run();
    running.set(ticket, outcome);
    return { ticket, outcome };
  };
  const confirm = async (scope: Pick<Scope, "api" | "put">, id: TaskId) => {
    const sent = seqOf(id);
    const { ticket } = reload(scope);
    let failure: unknown;
    while ((landed.get(id) ?? 0) < ticket && seqOf(id) === sent) {
      const waiting = [...running].filter(([at]) => at >= ticket).map(([, outcome]) => outcome);
      if (waiting.length === 0) throw new TaskRefreshFailed(failure);
      const outcome = await Promise.race(waiting);
      if (outcome !== null && isUnauthorized(outcome.cause)) throw outcome.cause;
      failure = outcome?.cause ?? failure;
    }
  };
  return {
    pushed,
    save: async (scope: Scope, task: TopicTask, patch: Parameters<Api["updateTask"]>[1]) => {
      const sent = seqOf(task.id);
      const saved = await scope.api.updateTask(task.id, patch);
      if (seqOf(task.id) !== sent) return confirm(scope, task.id);
      pushed(task.id);
      scope.put({ type: "task_updated", task: saved });
    },
    reload: async (scope: Pick<Scope, "api" | "put">) => {
      const outcome = await reload(scope).outcome;
      if (outcome !== null) throw outcome.cause;
    },
    confirm,
  };
};

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(reduce, { status: "loading" } satisfies AppState);
  const stateRef = useRef<AppState>(state);
  useEffect(() => {
    stateRef.current = state;
    // 开发构建把当前状态挂到 window 上，端到端测试等确定的状态再断言，不靠请求之间的时间先后。
    if (import.meta.env.DEV) (window as Window & { __baizeState?: AppState }).__baizeState = state;
  }, [state]);

  // 请求发出时、推送到达时各取一个号，reducer 按号排先后，见 stamped.ts。
  const [nextSeq] = useState(createClock);
  const [sessions] = useState(createSessions);
  const [taskPushes] = useState(createTaskPushes);

  // 入口数据齐了才进会话；这期间有了更新的尝试，这一次整个作废，返回 null。
  const enter = useMemo(
    () =>
      async (attempt: Attempt, user: User): Promise<Ready | null> => {
        const entry = await loadEntry(attempt.api, user);
        const session = sessions.begin(attempt);
        return session === null ? null : { ...entry, session };
      },
    [sessions],
  );

  const actions = useMemo<AppActions>(() => {
    // 会话过期后每个请求都会 401。不接住的话界面停在 ready 上，发消息、存设置全都静悄悄地不生效。
    const signedIn = <A extends unknown[], R>(run: (scope: Scope, ...args: A) => Promise<R>) => {
      return async (...args: A): Promise<R | undefined> => {
        const session = sessions.current();
        if (session === null) return undefined;
        const put = (action: Action) => dispatch({ type: "from_session", session: session.id, action });
        try {
          return await run({ api: session.api, put, session }, ...args);
        } catch (cause) {
          if (session.signal.aborted) return undefined;
          if (!isUnauthorized(cause)) throw cause;
          sessions.end(session.id);
          put({ type: "anonymous", login: { kind: "failed", message: "登录已过期，请重新登录" } });
          return undefined;
        }
      };
    };
    const loadBucket = createLoadBucket(nextSeq);
    const loadAccounts = signedIn(async ({ api, put }) => {
      const seq = nextSeq();
      const [{ accounts }, { computers }] = await Promise.all([api.accounts(), api.computers()]);
      put({ type: "accounts_loaded", accounts, computers, seq });
    });
    return {
      login: async (email, password) => {
        const attempt = sessions.attempt();
        dispatch({ type: "anonymous", login: { kind: "submitting" } });
        try {
          const { user } = await attempt.api.login(email, password);
          const ready = await enter(attempt, user);
          if (ready !== null) dispatch(ready);
        } catch (cause) {
          if (!sessions.isCurrent(attempt)) return;
          const message = cause instanceof RequestFailed ? cause.message : "登录失败，再试一次";
          dispatch({ type: "anonymous", login: { kind: "failed", message } });
        }
      },
      register: async (email, password, name) => {
        const attempt = sessions.attempt();
        // 被这次注册取代的登录不会再回来收尾，它的「登录中」要在这里清掉。
        dispatch({ type: "anonymous", login: { kind: "idle" } });
        dispatch({ type: "register_phase", register: { kind: "submitting" } });
        try {
          const { user } = await attempt.api.register(email, password, name);
          const ready = await enter(attempt, user);
          if (ready !== null) dispatch(ready);
        } catch (cause) {
          if (!sessions.isCurrent(attempt)) return;
          const message = cause instanceof RequestFailed ? cause.message : "注册失败，再试一次";
          dispatch({ type: "register_phase", register: { kind: "failed", message } });
        }
      },
      // 登出也占一个尝试号。之后的登录或注册会取消它，晚到的登出回包连同清 cookie 的 Set-Cookie 一起作废，不会结束新会话。
      logout: async () => {
        const session = sessions.current();
        const attempt = sessions.attempt();
        try {
          await attempt.api.logout();
        } catch (cause) {
          if (attempt.signal.aborted) return;
          throw cause;
        }
        if (!sessions.isCurrent(attempt)) return;
        if (session !== null) sessions.end(session.id);
        dispatch({ type: "anonymous", login: { kind: "idle" } });
      },
      createBot: signedIn(async ({ api, put }) => {
        const { bot, group } = await api.createBot({});
        put({ type: "bot_created", bot, groupId: group.id });
        return { bot, groupId: group.id };
      }),
      deleteBot: signedIn(async ({ api, put }, botId: BotId) => {
        await api.deleteBot(botId);
        put({ type: "bot_removed", botId });
      }),
      importBot: signedIn(async ({ api, put }, template: BotTemplate) => {
        const { bot, group } = await api.importTemplate(template);
        if (template.plugins.length > 0) put({ type: "tools_unsynced", botId: bot.id });
        put({ type: "bot_created", bot, groupId: group.id });
        return bot.id;
      }),
      syncBotTools: signedIn(async ({ api, put }, botId: BotId) => {
        for (const tool of (await api.tools()).items) {
          if (tool.assignedBotIds.includes(botId)) put({ type: "tool_upserted", tool });
        }
        put({ type: "tools_synced", botId });
      }),
      exportTemplate: signedIn(async ({ api }, botId: BotId, choice: ExportTemplateRequest) =>
        api.exportTemplate(botId, choice),
      ),
      updateBot: signedIn(async ({ api, put }, botId: BotId, draft: BotDraft) => {
        put({ type: "bot_updated", bot: await api.updateBot(botId, draft) });
      }),
      setChecklist: signedIn((scope, task: TopicTask, checklist: ChecklistItem[]) =>
        taskPushes.save(scope, task, { checklist }),
      ),
      setTaskGoal: signedIn((scope, task: TopicTask, goal: ProjectGoal | null) =>
        taskPushes.save(scope, task, { goal }),
      ),
      reloadTask: signedIn((scope, task: TaskId) => taskPushes.confirm(scope, task)),
      loadMessages: signedIn((scope, groupId: GroupId, after: Seq) =>
        loadBucket(scope, `messages:${groupId}`, after, async (seq) => {
          const { put } = scope;
          const { messages, approvals, handoffs, drafts, plans, publications } = await scope.api.messages(groupId);
          put({ type: "content_loaded", drafts, plans, seq });
          put({ type: "publications_loaded", publications });
          put({ type: "messages_set", groupId, messages, seq });
          put({ type: "approvals_loaded", approvals });
          put({ type: "handoffs_loaded", handoffs });
        }),
      ),
      loadMessage: signedIn((scope, messageId: MessageId, after: Seq) =>
        loadMessageGap(loadBucket, scope, messageId, after),
      ),
      sendMessage: signedIn(async ({ api, put }, groupId: GroupId, text: string) => {
        const seq = nextSeq();
        const { message } = await api.sendMessage(groupId, text);
        put({ type: "message_upserted", message, seq });
      }),
      decideApproval: signedIn(async ({ api, put }, approvalId: ApprovalId, request: DecideApprovalRequest) => {
        const result = await api.decideApproval(approvalId, request);
        put({ type: "approval_pushed", approval: result.approval });
        if (result.grant !== null) put({ type: "grant_upserted", grant: result.grant });
      }),
      // 批了退了之后首页的清单自己重拉，不等推送：断线时推送到不了，卡不能停在清单上。
      decideDraft: signedIn(async ({ api, put }, draftId: DraftId, request: DecideDraftRequest) => {
        const seq = nextSeq();
        const { draft } = await api.decideDraft(draftId, request);
        put({ type: "content_loaded", drafts: [draft], plans: [], seq });
        put({ type: "today_version_bumped" });
      }),
      approvePlan: signedIn(async ({ api, put }, planId: ContentPlanId, request: ApprovePlanRequest) => {
        const seq = nextSeq();
        const { plan, drafts } = await api.approvePlan(planId, request);
        put({ type: "content_loaded", drafts, plans: [plan], seq });
        put({ type: "today_version_bumped" });
      }),
      returnPlan: signedIn(async ({ api, put }, planId: ContentPlanId) => {
        const seq = nextSeq();
        const { plan } = await api.returnPlan(planId);
        put({ type: "content_loaded", drafts: [], plans: [plan], seq });
        put({ type: "today_version_bumped" });
      }),
      loadToday: signedIn(async ({ api, put }) => {
        const seq = nextSeq();
        const today = await api.today();
        const plans = today.pending.flatMap((item) => (item.kind === "plan" ? [item.plan] : []));
        const drafts = [
          ...today.pending.flatMap((item) =>
            item.kind === "plan" ? item.drafts : item.kind === "draft" ? [item.draft] : [],
          ),
          ...today.next.flatMap((item) => (item.kind === "draft" ? [item.draft] : [])),
        ];
        put({ type: "content_loaded", drafts, plans, seq });
        return today;
      }),
      loadProject: signedIn(async ({ api, put }, groupId: GroupId) => {
        const seq = nextSeq();
        const project = await api.project(groupId);
        const plans = [
          ...project.pending.flatMap((item) => (item.kind === "plan" ? [item.plan] : [])),
          ...(project.plan === null ? [] : [project.plan.plan]),
        ];
        const drafts = [
          ...project.pending.flatMap((item) =>
            item.kind === "plan" ? item.drafts : item.kind === "draft" ? [item.draft] : [],
          ),
          ...(project.plan?.drafts ?? []),
          ...(project.next?.kind === "draft" ? [project.next.draft] : []),
        ];
        put({ type: "content_loaded", drafts, plans, seq });
        return project;
      }),
      loadAccounts,
      loadComputers: signedIn(async ({ api, put }) => {
        const seq = nextSeq();
        put({ type: "computers_loaded", computers: (await api.computers()).computers, seq });
      }),
      addRemoteComputer: signedIn(async ({ api, put }) => {
        const pairing = await api.createRemoteComputer();
        const seq = nextSeq();
        put({ type: "computers_loaded", computers: (await api.computers()).computers, seq });
        return pairing;
      }),
      deleteAccount: signedIn(async ({ api, put, session }, email: string) => {
        await api.deleteAccount(email);
        sessions.end(session.id);
        put({ type: "anonymous", login: { kind: "idle" } });
      }),
      updateAccountTier: signedIn(async ({ api, put }, accountId: AccountId, tier: AccountTier) => {
        const seq = nextSeq();
        put({ type: "account_upserted", account: (await api.updateAccount(accountId, { tier })).account, seq });
      }),
      addAccount: signedIn(async ({ api, put }, platform: BrowserPlatform, computerId: ComputerId) => {
        const seq = nextSeq();
        const { account } = await api.createAccount({ platform, computerId });
        put({ type: "account_upserted", account, seq });
        return account.id;
      }),
      // 尝试号在点击时就取好，卡一开就带着它，202 之前到的旧尝试失败也对不上号。
      // 202 只说窗口在开了，登上没有随 account_updated 推回来；回包里那份账号比推送旧，按号挡掉。
      // 这次点击之后的每一步都带着 startedAt，卡已经被别的结果结算、或者又点了一次，这些晚到的一步就不落。
      loginAccount: signedIn(async ({ api, put, session }, accountId: AccountId) => {
        const startedAt = nextSeq();
        const attempt = LoginAttemptId.parse(crypto.randomUUID());
        put({ type: "login_opened", accountId, startedAt, attempt });
        const settle = (flow: LoginFlow) => put({ type: "login_flow", accountId, startedAt, flow });
        const seq = nextSeq();
        try {
          const { account } = await api.loginAccount(accountId, attempt);
          put({ type: "account_upserted", account, seq });
        } catch (cause) {
          if (session.signal.aborted || isUnauthorized(cause)) throw cause;
          settle(
            cause instanceof RequestFailed && cause.status === 409
              ? { status: "offline" }
              : { status: "refused", message: cause instanceof RequestFailed ? cause.message : "请重试" },
          );
          return;
        }
        const timer = setTimeout(() => {
          if (session.signal.aborted) return;
          void loadAccounts()
            .catch(() => undefined)
            .then(() => settle({ status: "lapsed" }));
        }, LOGIN_TIMEOUT_MS);
        session.signal.addEventListener("abort", () => clearTimeout(timer));
      }),
      dismissLogin: signedIn(async ({ put }, accountId: AccountId, attempt: LoginAttemptId) => {
        put({ type: "login_dismissed", accountId, attempt });
      }),
      loadLive: signedIn(async ({ api, put }) => {
        const seq = nextSeq();
        put({ type: "live_loaded", sessions: (await api.live()).sessions, seq });
      }),
      openTakeover: signedIn(async ({ put }, liveId: LiveId) => {
        put({ type: "takeover_opened", liveId, openedAt: nextSeq() });
      }),
      hideTakeover: signedIn(async ({ put }, liveId: LiveId) => {
        put({ type: "takeover_hidden", liveId });
      }),
      openTerminal: signedIn(async ({ api, put }, computerId: ComputerId) => {
        const openedAt = nextSeq();
        const { liveId } = await api.openTerminal(computerId);
        put({ type: "terminal_opened", liveId, computerId, openedAt });
      }),
      showTerminal: signedIn(async ({ put }, { liveId, computerId }: LiveSession) => {
        put({ type: "terminal_opened", liveId, computerId, openedAt: nextSeq() });
      }),
      hideTerminal: signedIn(async ({ put }, liveId: LiveId) => {
        put({ type: "terminal_hidden", liveId });
      }),
      loadGrants: signedIn(async ({ api, put }) => {
        put({ type: "grants_loaded", grants: (await api.grants()).grants });
      }),
      deleteGrant: signedIn(async ({ api, put }, grantId: GrantId) => {
        await api.deleteGrant(grantId);
        put({ type: "grant_deleted", grantId });
      }),
      pauseBot: signedIn(async ({ api, put }, botId: BotId) => {
        put({ type: "bot_updated", bot: await api.pauseBot(botId) });
      }),
      resumeBot: signedIn(async ({ api, put }, botId: BotId) => {
        put({ type: "bot_updated", bot: await api.resumeBot(botId) });
      }),
      loadRoutines: signedIn((scope) =>
        loadBucket(scope, "routines", ANY_FLIGHT, async (seq) => {
          scope.put({ type: "routines_loaded", routines: (await scope.api.routines()).items, seq });
        }),
      ),
      updateRoutine: signedIn(async ({ api, put }, routineId: RoutineId, patch: UpdateRoutineRequest) => {
        const seq = nextSeq();
        put({ type: "routine_upserted", routine: await api.updateRoutine(routineId, patch), seq });
      }),
      deleteRoutine: signedIn(async ({ api, put }, routineId: RoutineId) => {
        const seq = nextSeq();
        await api.deleteRoutine(routineId);
        put({ type: "routine_removed", routineId, seq });
      }),
      runRoutine: signedIn(async ({ api, put }, routineId: RoutineId) => {
        const seq = nextSeq();
        put({ type: "routine_upserted", routine: await api.runRoutine(routineId), seq });
      }),
      loadSkills: signedIn((scope, botId: BotId) =>
        loadBucket(scope, `skills:${botId}`, ANY_FLIGHT, async (seq) => {
          scope.put({ type: "skills_loaded", botId, skills: (await scope.api.skills(botId)).items, seq });
        }),
      ),
      loadPreferences: signedIn((scope, botId: BotId) =>
        loadBucket(scope, `preferences:${botId}`, ANY_FLIGHT, async (seq) => {
          scope.put({ type: "preferences_loaded", botId, preferences: await scope.api.preferences(botId), seq });
        }),
      ),
      // DELETE 回 204，响应里没有 botId，少了它就不知道该从哪个桶里删，所以整条传进来。
      // 204 和 404 都是服务端说这条已经没了，是定论，所以号在回包之后才取：
      // 删除在途时先到的更新推送拿着更大的号，回包前取号会被它挡住；404 是错过了删除推送，同样就地去掉。
      deletePreference: signedIn(async ({ api, put }, preference: Preference) => {
        try {
          await api.deletePreference(preference.id);
        } catch (error) {
          if (!(error instanceof RequestFailed && error.status === 404)) throw error;
        }
        put({ type: "preference_removed", botId: preference.botId, preferenceId: preference.id, seq: nextSeq() });
      }),
      loadComputerChoices: signedIn((scope, groupId: GroupId, after: Seq) =>
        loadBucket(
          scope,
          `computer-choices:${groupId}`,
          after,
          async (seq) => {
            const choices = await scope.api.computerChoices(groupId);
            scope.put({ type: "computer_choices_loaded", groupId, choices, seq });
          },
          REFRESH_TRIES,
        ),
      ),
      chooseComputer: signedIn(async ({ api, put }, groupId: GroupId, botId: BotId, kind: ComputerKind) => {
        const seq = nextSeq();
        await api.putComputerChoice(groupId, botId, { kind });
        put({ type: "computer_choice_set", groupId, botId, kind, seq });
      }),
      loadBrand: signedIn(async ({ api, put }) => {
        const brand = await api.brand();
        put({ type: "brand_set", brand });
        return brand;
      }),
      updateBrand: signedIn(async ({ api, put }, body: UpdateBrandRequest) =>
        put({ type: "brand_set", brand: await api.updateBrand(body) }),
      ),
      // 结论随这条消息的正文走，所以先落那条消息。存下或改过的那条 skill 是顺带回来的；删掉的回包里没有，
      // 按卡上的 targetId 就地去掉，不等推送。
      decideSkillOffer: signedIn(
        async ({ api, put }, messageId: MessageId, decision: DecideSkillOfferRequest["decision"]) => {
          const seq = nextSeq();
          const res = await api.decideSkillOffer(messageId, decision);
          put({ type: "message_upserted", message: res.message, seq });
          if (res.skill !== null) put({ type: "skill_upserted", skill: res.skill, seq });
          const card = res.message.body;
          if (card.kind === "skill_offer" && card.status === "saved" && card.change.op === "remove") {
            put({ type: "skill_removed", botId: card.botId, skillId: card.change.targetId, seq });
          }
        },
      ),
      // 点「记住」之前这句话不在偏好表里，所以只有 save 才顺带回来那条偏好。
      decidePreferenceOffer: signedIn(
        async ({ api, put }, messageId: MessageId, decision: DecidePreferenceOfferRequest["decision"]) => {
          const seq = nextSeq();
          try {
            const res = await api.decidePreferenceOffer(messageId, decision);
            put({ type: "message_upserted", message: res.message, seq });
            if (res.preference !== null) put({ type: "preference_upserted", preference: res.preference, seq });
          } catch (cause) {
            // 409 是别处已经结了这张卡，推送又没到。取回那份结论盖上，别处点的是「记住」就把这个 Bot 的偏好列表一并重拉，
            // 卡和计数一起收敛；错还照抛，让卡上说一句。补读本身失败就只剩这句话，404 和网络错也一样。
            if (cause instanceof RequestFailed && cause.status === 409) {
              const fetched = nextSeq();
              const message = await api.message(messageId).catch(() => undefined);
              if (message !== undefined) {
                put({ type: "message_upserted", message, seq: fetched });
                if (message.body.kind === "preference_offer" && message.body.status === "saved") {
                  const botId = message.body.botId;
                  const listed = nextSeq();
                  await api.preferences(botId).then(
                    (preferences) => put({ type: "preferences_loaded", botId, preferences, seq: listed }),
                    () => undefined,
                  );
                }
              }
            }
            throw cause;
          }
        },
      ),
      decideRoutineOffer: signedIn(
        async ({ api, put }, messageId: MessageId, decision: DecideRoutineOfferRequest["decision"]) => {
          const seq = nextSeq();
          try {
            const res = await api.decideRoutineOffer(messageId, decision);
            put({ type: "message_upserted", message: res.message, seq });
            if (res.routine !== null) put({ type: "routine_upserted", routine: res.routine, seq });
          } catch (cause) {
            // 409 是别处已经结了这张卡，取回那份结论盖上，卡照它收起；错还照抛，让卡上说一句。
            if (cause instanceof RequestFailed && cause.status === 409) {
              const fetched = nextSeq();
              await api.message(messageId).then(
                (message) => put({ type: "message_upserted", message, seq: fetched }),
                () => undefined,
              );
            }
            throw cause;
          } finally {
            // 首页待办里也排着这张卡，断线时等不到推送，结完自己重拉。
            put({ type: "today_version_bumped" });
          }
        },
      ),
      markSeen: signedIn(async ({ api }, groupId: GroupId) => {
        await api.markSeen(groupId);
      }),
      decideProjectOffer: signedIn(async ({ api, put }, messageId: MessageId, request: DecideProjectOfferRequest) => {
        const seq = nextSeq();
        const { message, group, task } = await api.decideProjectOffer(messageId, request);
        put({ type: "message_upserted", message, seq });
        if (group === null || task === null) return undefined;
        // 推送里的 group_created 可能还在路上，侧栏没这个群时跳过去会被弹回首页，所以拿回包先入列。
        put({ type: "group_created", group, task, seq });
        return group.id;
      }),
      decideTeamOffer: signedIn(async ({ api, put }, messageId: MessageId, request: DecideTeamOfferRequest) => {
        const seq = nextSeq();
        put({ type: "team_offer_sending", messageId });
        try {
          const { message, group } = await api.decideTeamOffer(messageId, request);
          put({ type: "message_upserted", message, seq });
          if (group !== null) put({ type: "group_updated", group, seq });
          // 首页和项目页的「等你」是服务端的快照，卡的去留（确认走了、先放着排到后面）得重拉才对。
          put({ type: "today_version_bumped" });
          return message;
        } finally {
          put({ type: "team_offer_sent", messageId });
        }
      }),
      // 号在请求发出时取，和别的群写入同一套规则。在途那趟总比这次要的旧，一律记待补。
      loadGroups: signedIn((scope) =>
        loadBucket(
          scope,
          "groups",
          nextSeq(),
          async (seq) => {
            const { items } = await scope.api.groups();
            scope.put({ type: "groups_loaded", groups: items, seq });
          },
          REFRESH_TRIES,
        ),
      ),
      loadPendingCounts: signedIn((scope) =>
        loadBucket(
          scope,
          "counts",
          nextSeq(),
          async (seq) => {
            const [bots, groups] = await Promise.all([scope.api.bots(), scope.api.groups()]);
            scope.put({ type: "pending_counts_loaded", bots: bots.items, groups: groups.items, seq });
          },
          REFRESH_TRIES,
        ),
      ),
      createTool: signedIn(async ({ api, put }, draft: CreateToolRequest) => {
        put({ type: "tool_upserted", tool: await api.createTool(draft) });
      }),
      updateTool: signedIn(async ({ api, put }, toolId: ToolConnectionId, patch: UpdateToolRequest) => {
        put({ type: "tool_upserted", tool: await api.updateTool(toolId, patch) });
      }),
      deleteTool: signedIn(async ({ api, put }, toolId: ToolConnectionId) => {
        await api.deleteTool(toolId);
        put({ type: "tool_removed", toolId });
      }),
      updateSettings: signedIn(async ({ api, put }, patch: Partial<Settings>) => {
        put({ type: "settings_set", settings: await api.updateSettings(patch) });
      }),
      loadUsage: signedIn(async ({ api, put }) => {
        put({ type: "usage_loaded", usage: await api.usage() });
      }),
      loadPokerTable: signedIn(async ({ api, put }, groupId: GroupId) => {
        try {
          put({ type: "poker_table_set", table: await api.pokerTable(groupId) });
          return true;
        } catch (cause) {
          if (cause instanceof RequestFailed && cause.status === 404) return false;
          throw cause;
        }
      }),
      createPokerTable: signedIn(async ({ api, put }, requestId: string) => {
        const seq = nextSeq();
        const table = await api.createPokerTable({ requestId });
        put({ type: "poker_table_set", table });
        const { items } = await api.groups();
        put({ type: "groups_loaded", groups: items, seq });
        return table.groupId;
      }),
      swapPokerSeat: signedIn(
        async ({ api, put }, groupId: GroupId, seat: PokerSeatNo, persona: SwapSeatRequest["persona"]) => {
          put({ type: "poker_table_set", table: await api.swapSeat(groupId, seat, { persona }) });
        },
      ),
      startPokerHand: signedIn(async ({ api, put }, groupId: GroupId) => {
        put({ type: "poker_table_set", table: await api.startHand(groupId) });
      }),
      actPoker: signedIn(async ({ api, put }, handId: PokerHandId, request: PokerActRequest) => {
        put({ type: "poker_table_set", table: await api.pokerAct(handId, request) });
      }),
      askPokerHint: signedIn(async ({ api, put }, handId: PokerHandId, request: HintRequest) => {
        put({ type: "poker_table_set", table: await api.askHint(handId, request) });
      }),
      leavePokerTable: signedIn(async ({ api, put }, groupId: GroupId) => {
        const table = await api.leaveTable(groupId);
        put({ type: "poker_table_set", table });
        return table.groupId;
      }),
      archiveGroup: signedIn(async ({ api, put }, groupId: GroupId) => {
        const seq = nextSeq();
        await api.archiveGroup(groupId);
        put({ type: "group_archived", groupId, seq });
        put({ type: "today_version_bumped" });
      }),
    };
  }, [nextSeq, sessions, enter, taskPushes]);

  useEffect(() => {
    const attempt = sessions.attempt();
    attempt.api
      .me()
      .then(({ user }) => enter(attempt, user))
      .then((ready) => {
        if (ready !== null) dispatch(ready);
      })
      .catch((cause: unknown) => {
        if (!sessions.isCurrent(attempt)) return;
        // 没登录和「服务挂了」得说不一样的话，不然用户看到的都是一个空登录页。
        const login: LoginPhase = isUnauthorized(cause)
          ? { kind: "idle" }
          : { kind: "failed", message: "连不上服务，稍后再试" };
        dispatch({ type: "anonymous", login });
      });
    // 会话的请求、退避等待和待补的那趟都只听会话的 signal，Provider 卸载时不结束会话，它们会接着跑。
    return () => sessions.end();
  }, [sessions, enter]);

  const session = state.status === "ready" ? state.session : null;
  // 卡片上的「从哪台电脑发」和账号页都读这两张表。拉不到只是少写一句电脑名，不该拖住整个入口。
  useEffect(() => {
    if (session === null) return;
    actions.loadAccounts().catch(() => undefined);
    actions.loadLive().catch(() => undefined);
  }, [session, actions]);

  useEffect(() => {
    const scoped = sessions.current();
    if (session === null || scoped?.id !== session) return;
    const put = (action: Action) => dispatch({ type: "from_session", session, action });
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let hasConnected = false;
    let countsTimer: ReturnType<typeof setTimeout> | null = null;
    // 旧连接关掉之前已经排进事件队列的回调仍会跑，每个回调先认一下这还是不是当前会话。
    const live = () => !cancelled && sessions.current()?.id === session;
    const expire = () => {
      sessions.end(session);
      put({ type: "anonymous", login: { kind: "failed", message: "登录已过期，请重新登录" } });
    };
    // 角标只认服务端绝对数。会改待办数的推送和重连都只换来一趟补拉：去抖 200ms 攒成一趟，
    // 在途、失败重试和停下后的重试都归 loadPendingCounts 的桶管。
    const refreshPendingCounts = () => {
      if (countsTimer !== null) return;
      countsTimer = setTimeout(() => {
        countsTimer = null;
        if (!cancelled) actions.loadPendingCounts().catch(() => undefined);
      }, 200);
    };
    // 断线期间的登录结果收不到，重拉账号把登上的认回来，然后把重拉之前就在等的卡结掉。
    // 画面一起重拉：断线期间开关过的画面也收不到推送，还开着的那次登录不算没等到，见 logins_settled。
    // 重拉失败也结，卡不能一直停在「等你登录」；重拉期间新点的登录 startedAt 更大，不受影响。
    const recoverLogins = (computerId: ComputerId | null, flow: "offline" | "lapsed") => {
      const before = nextSeq();
      const seq = nextSeq();
      void Promise.allSettled([
        Promise.all([scoped.api.accounts(), scoped.api.computers()]).then(([{ accounts }, { computers }]) => {
          if (live()) put({ type: "accounts_loaded", accounts, computers, seq });
        }),
        scoped.api.live().then(({ sessions }) => {
          if (live()) put({ type: "live_loaded", sessions, seq });
        }),
      ]).then((results) => {
        if (!live()) return;
        if (results.some((result) => result.status === "rejected" && isUnauthorized(result.reason))) expire();
        else put({ type: "logins_settled", before, computerId, flow: { status: flow } });
      });
    };
    const pushHandlers = createPushHandlers({
      session,
      live,
      dispatch: (action) => {
        if (action.type === "task_updated") taskPushes.pushed(action.task.id);
        put(action);
      },
      stateRef,
      refreshPendingCounts,
      recoverLogins: (computerId) => recoverLogins(computerId, "offline"),
      reloadChoices: (groupId, after) => void actions.loadComputerChoices(groupId, after).catch(() => undefined),
    });
    const retryLater = () => {
      retry = setTimeout(open, reconnectDelay(failures));
      failures += 1;
    };
    const open = () => {
      put({ type: "turns_cleared" });
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${window.location.host}/api/ws`);
      socket.addEventListener("open", () => {
        failures = 0;
        put({ type: "push_link", link: "open" });
        if (hasConnected) {
          put({ type: "push_reconnected", seq: nextSeq() });
          refreshPendingCounts();
          recoverLogins(null, "lapsed");
          // 断线期间的 task_updated 收不到，项目头部、任务卡、首页「在进行」都读会话里的卡，重读一遍群列表认回来。
          void taskPushes.reload({ api: scoped.api, put }).catch((cause: unknown) => {
            if (live() && isUnauthorized(cause)) expire();
          });
        }
        hasConnected = true;
      });
      socket.addEventListener("message", (event) => {
        if (!live()) return;
        const parsed = ServerPush.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) return;
        const push = parsed.data;
        dispatchServerPush(pushHandlers, push, nextSeq());
      });
      // 断了不重连的话 HTTP 还通，界面看着是活的，其实再也收不到推送。握手被 401 拒掉时浏览器也只给一个 close，
      // 分不出是登录过期还是断网，拿这次会话打一下 /api/me 问清楚：401 回登录页，别的按退避再连。
      socket.addEventListener("close", () => {
        if (!live()) return;
        put({ type: "push_link", link: "down" });
        scoped.api.me().then(
          () => {
            if (live()) retryLater();
          },
          (cause: unknown) => {
            if (!live()) return;
            if (isUnauthorized(cause)) expire();
            else retryLater();
          },
        );
      });
    };
    open();
    return () => {
      cancelled = true;
      if (retry !== null) clearTimeout(retry);
      if (countsTimer !== null) clearTimeout(countsTimer);
      socket?.close();
    };
  }, [session, sessions, nextSeq, actions, taskPushes]);

  const groupsVersion = state.status === "ready" ? state.groupsVersion : 0;
  useEffect(() => {
    if (session !== null && groupsVersion > 0) actions.loadGroups().catch(() => undefined);
  }, [session, groupsVersion, actions]);

  const theme = state.status === "ready" ? state.settings.theme : "system";
  useEffect(() => applyTheme(theme), [theme]);

  return <AppContext.Provider value={{ state, actions }}>{children}</AppContext.Provider>;
};
