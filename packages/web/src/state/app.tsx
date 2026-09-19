import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import {
  ServerPush,
  type Approval,
  type ApprovalId,
  type Bot,
  type BotId,
  type ChecklistItem,
  type DecideApprovalRequest,
  type Group,
  type GroupId,
  type Handoff,
  type HandoffId,
  type Message,
  type MessageId,
  type OvernightItem,
  type CreateRoutineRequest,
  type CreateSkillRequest,
  type CreateToolRequest,
  type DecideSkillOfferRequest,
  type Routine,
  type RoutineId,
  type Settings,
  type Skill,
  type SkillId,
  type ToolConnection,
  type ToolConnectionId,
  type UpdateRoutineRequest,
  type UpdateSkillRequest,
  type UpdateToolRequest,
  type TopicTask,
  type User,
  type UsageResponse,
} from "@baize/shared";
import type { BotListItem, GroupListItem } from "@baize/shared";
import { RequestFailed, api, type BotDraft, type GroupDraft } from "../api/client.js";
import { notifyApproval } from "./notify.js";
import { applyTheme } from "./theme.js";

export type LoginPhase = { kind: "idle" } | { kind: "submitting" } | { kind: "failed"; message: string };

// 侧栏一条记录就是一个群，两段共用这一个形状。单 Bot 群只有一个成员且不带任务卡，多 Bot 群有 2 到 6 个成员和一张
// 任务卡，写成联合而不是「botIds + task 可空」，是为了让「多 Bot 群没有任务卡」这种状态根本拼不出来。
export type Conversation =
  | {
      kind: "solo";
      groupId: GroupId;
      botId: BotId;
      lastMessage: Message | null;
      pendingApprovals: number;
      pendingHandoffs: number;
    }
  | {
      kind: "team";
      groupId: GroupId;
      botIds: BotId[];
      task: TopicTask;
      lastMessage: Message | null;
      pendingApprovals: number;
      pendingHandoffs: number;
    };

export const memberIdsOf = (conversation: Conversation): BotId[] =>
  conversation.kind === "solo" ? [conversation.botId] : conversation.botIds;

export type AppState =
  | { status: "loading" }
  | { status: "anonymous"; login: LoginPhase }
  | {
      status: "ready";
      user: User;
      // Bot 的名字、标签、色相只存这一份。侧栏、气泡署名、任务卡头像、@ 弹层都从这里查，改名只落一个地方。
      bots: Record<BotId, Bot>;
      conversations: Conversation[];
      selectedGroupId: GroupId | null;
      messages: Record<GroupId, Message[]>;
      // 审批卡和交接卡的状态只在这两张表上。approval 和 handoff 类消息的正文只有一个 id，重推那条消息一个字
      // 都不会变。
      approvals: Record<ApprovalId, Approval>;
      handoffs: Record<HandoffId, Handoff>;
      // 例行任务按 Bot 分桶，开了那个 Bot 的「例行」页才拉。键在不在就是「这个 Bot 的例行任务拉过没有」，
      // 跟 messages 一个路子：没拉过的 Bot 不能凭一条推送造出一份只有一条的假列表。
      routines: Record<BotId, Routine[]>;
      // 会做的活也按 Bot 分桶，开了那个 Bot 的「会做的活」页、或者聊天框里要列 `/` 名单才拉。键在不在就是
      // 「这个 Bot 的 skill 拉过没有」，跟 routines 一个路子。
      skills: Record<BotId, Skill[]>;
      tools: ToolConnection[];
      settings: Settings;
      usage: UsageResponse;
      overnight: OvernightItem[];
    };

type Action =
  | { type: "anonymous"; login: LoginPhase }
  | {
      type: "ready";
      user: User;
      bots: BotListItem[];
      groups: GroupListItem[];
      tools: ToolConnection[];
      settings: Settings;
      usage: UsageResponse;
      overnight: OvernightItem[];
    }
  | { type: "group_selected"; groupId: GroupId }
  | { type: "bot_created"; bot: Bot; groupId: GroupId }
  | { type: "bot_updated"; bot: Bot }
  | { type: "bot_removed"; botId: BotId }
  | { type: "group_created"; group: Group; task: TopicTask; select: boolean }
  | { type: "task_updated"; task: TopicTask }
  | { type: "messages_set"; groupId: GroupId; messages: Message[] }
  | { type: "message_upserted"; message: Message }
  | ({ type: "message_delta" } & Delta)
  | { type: "approvals_loaded"; approvals: Approval[] }
  | { type: "approval_pushed"; approval: Approval }
  | { type: "handoffs_loaded"; handoffs: Handoff[] }
  | { type: "handoff_pushed"; handoff: Handoff }
  | { type: "pending_counts_loaded"; bots: BotListItem[]; groups: GroupListItem[] }
  | { type: "routines_loaded"; botId: BotId; routines: Routine[] }
  | { type: "routine_upserted"; routine: Routine }
  | { type: "routine_removed"; botId: BotId; routineId: RoutineId }
  | { type: "skills_loaded"; botId: BotId; skills: Skill[] }
  | { type: "skill_upserted"; skill: Skill }
  | { type: "skill_removed"; botId: BotId; skillId: SkillId }
  | { type: "tool_upserted"; tool: ToolConnection }
  | { type: "tool_removed"; toolId: ToolConnectionId }
  | { type: "settings_set"; settings: Settings }
  | { type: "usage_loaded"; usage: UsageResponse }
  | { type: "overnight_dismissed" };

// 流式回复的每一段。正文只有 delta 这几个字，落地成一条完整消息要靠本地已有的那条补齐。
type Delta = { groupId: GroupId; messageId: MessageId; delta: string; done: boolean };

// 同一条消息服务端会重推（tool_call 从 running 变 ok 就是重推），按 id 覆盖，不能追加成两条。
const upsert = (list: Message[], message: Message): Message[] =>
  list.some((m) => m.id === message.id) ? list.map((m) => (m.id === message.id ? message : m)) : [...list, message];

// delta 报文不带 botId。本地见过这条消息就照它署名；没见过就看这个群里现在谁在开口：单 Bot 群只有那一个，
// 多 Bot 群是当前经手的那个——派活的那一刻服务端就把它定下来了，不是这里猜的。
const signerOf = (conversation: Conversation | undefined, known: Message | undefined): BotId | null => {
  if (known?.body.kind === "bot") return known.body.botId;
  if (conversation === undefined) return null;
  return conversation.kind === "solo" ? conversation.botId : conversation.task.currentBotId;
};

const streamedInto = (previous: Message | undefined, botId: BotId, delta: Delta): Message => {
  const grown = previous?.body.kind === "bot" ? previous.body : null;
  return {
    id: delta.messageId,
    groupId: delta.groupId,
    body: { kind: "bot", botId, text: (grown?.text ?? "") + delta.delta, streaming: !delta.done },
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
};

type ReadyState = Extract<AppState, { status: "ready" }>;

// 摘要和角标是按群算的，跟这个群是单 Bot 还是多 Bot 无关。两段侧栏共用这一条写路径，加一类群不用再写一遍记账。
const touchGroup = (conversations: Conversation[], groupId: GroupId, patch: { lastMessage: Message }): Conversation[] =>
  conversations.map((c) => (c.groupId === groupId ? { ...c, ...patch } : c));

// 等你点头的审批和等 Bot 确认的交接是同一种记账：一条记录从 pending 走到一个结论就不再退回；同一条会从拉历史、
// 请求的响应、服务端推送三条路各来一次，先后不受控；侧栏的角标是这个群里还在 pending 的条数。两种卡共用下面
// 这一份对账，第三种要记账的东西来了也不用把这套先后关系再推一遍。
// 状态写死成两边的联合而不是 string：第三种要记账的东西得先把自己的状态接进这一行，才会在这里看见 pending
// 是那个唯一还没落地的值。写 string 的话它接上就能编译，然后一条都不计。
type SettlingStatus = Approval["status"] | Handoff["status"];

type Settling = { id: string; groupId: GroupId; status: SettlingStatus };

type PendingCount = "pendingApprovals" | "pendingHandoffs";

// 只认「之前知道的状态」，重到的那次自然是 0。null 表示这条该丢掉。
const reconcile = <T extends Settling>(
  previous: T | undefined,
  next: T,
  from: "history" | "push",
): { record: T; delta: number } | null => {
  // 拉历史带回来的那批，GET /api/bots 和 /api/groups 的计数已经算进去了，这里再加一次就翻倍。
  if (previous === undefined) return { record: next, delta: from === "push" && next.status === "pending" ? 1 : 0 };
  if (previous.status === "pending") return { record: next, delta: next.status === "pending" ? 0 : -1 };
  // 本地已经有结论了。结论不会退回 pending，所以说 pending 的那份是拉取在飞时拍下的旧快照。收下它，审批卡会
  // 重新长出两颗按钮，而角标早就减过了，再点只会拿到一个 409。
  return next.status === "pending" ? null : { record: next, delta: 0 };
};

// 计数字段名是个联合，用计算键去展开会把 Conversation 这个可辨识联合摊平，只能两边各写一次。
const bumped = (conversation: Conversation, count: PendingCount, delta: number): Conversation =>
  count === "pendingApprovals"
    ? { ...conversation, pendingApprovals: Math.max(0, conversation.pendingApprovals + delta) }
    : { ...conversation, pendingHandoffs: Math.max(0, conversation.pendingHandoffs + delta) };

const settled = <T extends Settling>(
  state: ReadyState,
  table: Record<string, T>,
  incoming: T[],
  from: "history" | "push",
  count: PendingCount,
): { table: Record<string, T>; conversations: Conversation[] } => {
  const next = { ...table };
  const deltaByGroup = new Map<GroupId, number>();
  for (const record of incoming) {
    const merged = reconcile(next[record.id], record, from);
    if (merged === null) continue;
    next[merged.record.id] = merged.record;
    if (merged.delta !== 0) deltaByGroup.set(record.groupId, (deltaByGroup.get(record.groupId) ?? 0) + merged.delta);
  }
  if (deltaByGroup.size === 0) return { table: next, conversations: state.conversations };
  return {
    table: next,
    conversations: state.conversations.map((c) => {
      const delta = deltaByGroup.get(c.groupId) ?? 0;
      return delta === 0 ? c : bumped(c, count, delta);
    }),
  };
};

const withApprovals = (state: ReadyState, incoming: Approval[], from: "history" | "push"): ReadyState => {
  const { table, conversations } = settled(state, state.approvals, incoming, from, "pendingApprovals");
  return { ...state, approvals: table, conversations };
};

const withHandoffs = (state: ReadyState, incoming: Handoff[], from: "history" | "push"): ReadyState => {
  const { table, conversations } = settled(state, state.handoffs, incoming, from, "pendingHandoffs");
  return { ...state, handoffs: table, conversations };
};

const enteredState = (action: Extract<Action, { type: "ready" }>): ReadyState => {
  const { user, bots, groups, tools, settings, usage, overnight } = action;
  const registry: Record<BotId, Bot> = {};
  for (const item of bots) registry[item.bot.id] = item.bot;
  const conversations: Conversation[] = [
    ...bots.map((item): Conversation => ({
      kind: "solo",
      groupId: item.groupId,
      botId: item.bot.id,
      lastMessage: item.lastMessage,
      pendingApprovals: item.pendingApprovals,
      pendingHandoffs: item.pendingHandoffs,
    })),
    ...groups.map((item): Conversation => ({
      kind: "team",
      groupId: item.group.id,
      botIds: item.group.botIds,
      task: item.task,
      lastMessage: item.lastMessage,
      pendingApprovals: item.pendingApprovals,
      pendingHandoffs: item.pendingHandoffs,
    })),
  ];
  return {
    status: "ready",
    user,
    bots: registry,
    conversations,
    selectedGroupId: conversations[0]?.groupId ?? null,
    messages: {},
    approvals: {},
    handoffs: {},
    routines: {},
    skills: {},
    tools,
    settings,
    usage,
    overnight,
  };
};

const reduce = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case "anonymous":
      return { status: "anonymous", login: action.login };
    case "ready":
      return enteredState(action);
    default:
      break;
  }
  if (state.status !== "ready") return state;
  switch (action.type) {
    case "group_selected":
      return { ...state, selectedGroupId: action.groupId };
    case "bot_created":
      return {
        ...state,
        bots: { ...state.bots, [action.bot.id]: action.bot },
        conversations: [
          ...state.conversations,
          {
            kind: "solo",
            groupId: action.groupId,
            botId: action.bot.id,
            lastMessage: null,
            pendingApprovals: 0,
            pendingHandoffs: 0,
          },
        ],
        selectedGroupId: action.groupId,
      };
    case "bot_updated":
      return { ...state, bots: { ...state.bots, [action.bot.id]: action.bot } };
    case "bot_removed": {
      const bots = { ...state.bots };
      delete bots[action.botId];
      const conversations = state.conversations.filter((c) => !(c.kind === "solo" && c.botId === action.botId));
      const stillThere = conversations.some((c) => c.groupId === state.selectedGroupId);
      return {
        ...state,
        bots,
        conversations,
        selectedGroupId: stillThere ? state.selectedGroupId : (conversations[0]?.groupId ?? null),
      };
    }
    case "group_created": {
      // 建群的人从 POST 的响应知道一次，WebSocket 的 group_created 还会再说一次。按 id 认，重到的那次什么都不做。
      if (state.conversations.some((c) => c.groupId === action.group.id)) {
        return action.select ? { ...state, selectedGroupId: action.group.id } : state;
      }
      const joined: Conversation = {
        kind: "team",
        groupId: action.group.id,
        botIds: action.group.botIds,
        task: action.task,
        lastMessage: null,
        pendingApprovals: 0,
        pendingHandoffs: 0,
      };
      return {
        ...state,
        conversations: [...state.conversations, joined],
        selectedGroupId: action.select ? action.group.id : state.selectedGroupId,
      };
    }
    case "task_updated":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.kind === "team" && c.task.id === action.task.id ? { ...c, task: action.task } : c,
        ),
      };
    case "messages_set":
      // 拉取在飞的时候推回来的消息已经在本地了，本地那份可能还带着历史里没有的流式正文，所以让它压住返回的历史。
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.groupId]: (state.messages[action.groupId] ?? []).reduce(upsert, action.messages),
        },
      };
    case "message_upserted": {
      const groupId = action.message.groupId;
      const known = state.messages[groupId];
      return {
        ...state,
        // messages 里有没有这个键就是「这组历史拉过没有」，所以没拉过的组只更侧栏摘要，不能凭一条推送造出一份假历史。
        messages:
          known === undefined ? state.messages : { ...state.messages, [groupId]: upsert(known, action.message) },
        conversations: touchGroup(state.conversations, groupId, { lastMessage: action.message }),
      };
    }
    case "message_delta": {
      const conversation = state.conversations.find((c) => c.groupId === action.groupId);
      const known = state.messages[action.groupId];
      const botId = signerOf(
        conversation,
        known?.find((m) => m.id === action.messageId),
      );
      if (botId === null) return state;
      const grown = streamedInto(
        known?.find((m) => m.id === action.messageId),
        botId,
        action,
      );
      return {
        ...state,
        messages: known === undefined ? state.messages : { ...state.messages, [action.groupId]: upsert(known, grown) },
        conversations: touchGroup(state.conversations, action.groupId, { lastMessage: grown }),
      };
    }
    case "approvals_loaded":
      return withApprovals(state, action.approvals, "history");
    case "approval_pushed":
      return withApprovals(state, [action.approval], "push");
    case "handoffs_loaded":
      return withHandoffs(state, action.handoffs, "history");
    case "handoff_pushed":
      return withHandoffs(state, [action.handoff], "push");
    case "pending_counts_loaded": {
      const counts = new Map(
        [...action.bots, ...action.groups].map((item) => [
          "bot" in item ? item.groupId : item.group.id,
          { pendingApprovals: item.pendingApprovals, pendingHandoffs: item.pendingHandoffs },
        ]),
      );
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          const current = counts.get(conversation.groupId);
          return current === undefined ? conversation : { ...conversation, ...current };
        }),
      };
    }
    case "routines_loaded":
      return { ...state, routines: { ...state.routines, [action.botId]: action.routines } };
    case "routine_upserted": {
      const known = state.routines[action.routine.botId];
      if (known === undefined) return state;
      const seen = known.some((r) => r.id === action.routine.id);
      // 每次运行记录变化都会重推整条。按 id 覆盖且不挪位置，列表不会在你正看着的时候跳一下。
      const next = seen
        ? known.map((r) => (r.id === action.routine.id ? action.routine : r))
        : [...known, action.routine];
      return { ...state, routines: { ...state.routines, [action.routine.botId]: next } };
    }
    case "routine_removed": {
      const known = state.routines[action.botId];
      if (known === undefined) return state;
      return {
        ...state,
        routines: { ...state.routines, [action.botId]: known.filter((r) => r.id !== action.routineId) },
      };
    }
    case "skills_loaded":
      return { ...state, skills: { ...state.skills, [action.botId]: action.skills } };
    case "skill_upserted": {
      const known = state.skills[action.skill.botId];
      if (known === undefined) return state;
      const seen = known.some((s) => s.id === action.skill.id);
      // 用过几次一变就会重推整条。按 id 覆盖且不挪位置，列表不会在你正看着的时候跳一下。
      const next = seen ? known.map((s) => (s.id === action.skill.id ? action.skill : s)) : [...known, action.skill];
      return { ...state, skills: { ...state.skills, [action.skill.botId]: next } };
    }
    case "skill_removed": {
      const known = state.skills[action.botId];
      if (known === undefined) return state;
      return { ...state, skills: { ...state.skills, [action.botId]: known.filter((s) => s.id !== action.skillId) } };
    }
    case "tool_upserted": {
      const known = state.tools.some((tool) => tool.id === action.tool.id);
      return {
        ...state,
        tools: known
          ? state.tools.map((tool) => (tool.id === action.tool.id ? action.tool : tool))
          : [...state.tools, action.tool],
      };
    }
    case "tool_removed":
      return { ...state, tools: state.tools.filter((tool) => tool.id !== action.toolId) };
    case "settings_set":
      return { ...state, settings: action.settings };
    case "usage_loaded":
      return { ...state, usage: action.usage };
    case "overnight_dismissed":
      return { ...state, overnight: [] };
    default:
      return state;
  }
};

export type AppActions = {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectGroup: (groupId: GroupId) => void;
  createBot: () => Promise<void>;
  updateBot: (botId: BotId, draft: BotDraft) => Promise<void>;
  createGroup: (draft: GroupDraft) => Promise<void>;
  setChecklist: (task: TopicTask, checklist: ChecklistItem[]) => Promise<void>;
  loadMessages: (groupId: GroupId) => Promise<void>;
  sendMessage: (groupId: GroupId, text: string) => Promise<void>;
  decideApproval: (approvalId: ApprovalId, decision: DecideApprovalRequest["decision"]) => Promise<void>;
  loadRoutines: (botId: BotId) => Promise<void>;
  createRoutine: (botId: BotId, draft: CreateRoutineRequest) => Promise<void>;
  updateRoutine: (routineId: RoutineId, patch: UpdateRoutineRequest) => Promise<void>;
  deleteRoutine: (routine: Routine) => Promise<void>;
  runRoutine: (routineId: RoutineId) => Promise<void>;
  loadSkills: (botId: BotId) => Promise<void>;
  createSkill: (botId: BotId, draft: CreateSkillRequest) => Promise<void>;
  updateSkill: (skillId: SkillId, patch: UpdateSkillRequest) => Promise<void>;
  deleteSkill: (skill: Skill) => Promise<void>;
  copySkill: (skillId: SkillId, botId: BotId) => Promise<void>;
  decideSkillOffer: (messageId: MessageId, decision: DecideSkillOfferRequest["decision"]) => Promise<void>;
  createTool: (draft: CreateToolRequest) => Promise<void>;
  updateTool: (toolId: ToolConnectionId, patch: UpdateToolRequest) => Promise<void>;
  deleteTool: (toolId: ToolConnectionId) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  loadUsage: () => Promise<void>;
  dismissOvernight: () => void;
};

const AppContext = createContext<{ state: AppState; actions: AppActions } | null>(null);

export const useApp = () => {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp 必须在 AppProvider 里用");
  return value;
};

const isUnauthorized = (cause: unknown): boolean => cause instanceof RequestFailed && cause.status === 401;

const loadEntry = async (user: User): Promise<Extract<Action, { type: "ready" }>> => {
  const [bots, groups, tools, settings, usage, overnight] = await Promise.all([
    api.bots(),
    api.groups(),
    api.tools(),
    api.settings(),
    api.usage(),
    api.overnight(),
  ]);
  return {
    type: "ready",
    user,
    bots: bots.items,
    groups: groups.items,
    tools: tools.items,
    settings,
    usage,
    overnight: overnight.items,
  };
};

const RECONNECT_DELAY_MS = 1000;

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(reduce, { status: "loading" } satisfies AppState);

  const actions = useMemo<AppActions>(() => {
    // 会话过期后每个请求都会 401。不接住的话界面停在 ready 上，发消息、存设置全都静悄悄地不生效。
    const signedIn = <A extends unknown[]>(run: (...args: A) => Promise<void>) => {
      return async (...args: A): Promise<void> => {
        try {
          await run(...args);
        } catch (cause) {
          if (!isUnauthorized(cause)) throw cause;
          dispatch({ type: "anonymous", login: { kind: "failed", message: "登录已过期，请重新登录" } });
        }
      };
    };
    return {
      login: async (email, password) => {
        dispatch({ type: "anonymous", login: { kind: "submitting" } });
        try {
          const { user } = await api.login(email, password);
          dispatch(await loadEntry(user));
        } catch (cause) {
          const message = cause instanceof RequestFailed ? cause.message : "登录失败，再试一次";
          dispatch({ type: "anonymous", login: { kind: "failed", message } });
        }
      },
      logout: async () => {
        await api.logout();
        dispatch({ type: "anonymous", login: { kind: "idle" } });
      },
      selectGroup: (groupId) => dispatch({ type: "group_selected", groupId }),
      createBot: signedIn(async () => {
        const { bot, group } = await api.createBot({});
        dispatch({ type: "bot_created", bot, groupId: group.id });
      }),
      updateBot: signedIn(async (botId: BotId, draft: BotDraft) => {
        dispatch({ type: "bot_updated", bot: await api.updateBot(botId, draft) });
      }),
      createGroup: signedIn(async (draft: GroupDraft) => {
        const { group, task } = await api.createGroup(draft);
        dispatch({ type: "group_created", group, task, select: true });
      }),
      setChecklist: signedIn(async (task: TopicTask, checklist: ChecklistItem[]) => {
        dispatch({ type: "task_updated", task: await api.updateTask(task.id, { checklist }) });
      }),
      loadMessages: signedIn(async (groupId: GroupId) => {
        const { messages, approvals, handoffs } = await api.messages(groupId);
        dispatch({ type: "messages_set", groupId, messages });
        dispatch({ type: "approvals_loaded", approvals });
        dispatch({ type: "handoffs_loaded", handoffs });
      }),
      sendMessage: signedIn(async (groupId: GroupId, text: string) => {
        const { message } = await api.sendMessage(groupId, text);
        dispatch({ type: "message_upserted", message });
      }),
      decideApproval: signedIn(async (approvalId: ApprovalId, decision: DecideApprovalRequest["decision"]) => {
        dispatch({ type: "approval_pushed", approval: await api.decideApproval(approvalId, decision) });
      }),
      loadRoutines: signedIn(async (botId: BotId) => {
        dispatch({ type: "routines_loaded", botId, routines: (await api.routines(botId)).items });
      }),
      createRoutine: signedIn(async (botId: BotId, draft: CreateRoutineRequest) => {
        dispatch({ type: "routine_upserted", routine: await api.createRoutine(botId, draft) });
      }),
      updateRoutine: signedIn(async (routineId: RoutineId, patch: UpdateRoutineRequest) => {
        dispatch({ type: "routine_upserted", routine: await api.updateRoutine(routineId, patch) });
      }),
      // DELETE 回 204，响应里没有 botId，而少了它就不知道该从哪个桶里删。所以整条传进来。
      deleteRoutine: signedIn(async (routine: Routine) => {
        await api.deleteRoutine(routine.id);
        dispatch({ type: "routine_removed", botId: routine.botId, routineId: routine.id });
      }),
      runRoutine: signedIn(async (routineId: RoutineId) => {
        dispatch({ type: "routine_upserted", routine: await api.runRoutine(routineId) });
      }),
      loadSkills: signedIn(async (botId: BotId) => {
        dispatch({ type: "skills_loaded", botId, skills: (await api.skills(botId)).items });
      }),
      createSkill: signedIn(async (botId: BotId, draft: CreateSkillRequest) => {
        dispatch({ type: "skill_upserted", skill: await api.createSkill(botId, draft) });
      }),
      updateSkill: signedIn(async (skillId: SkillId, patch: UpdateSkillRequest) => {
        dispatch({ type: "skill_upserted", skill: await api.updateSkill(skillId, patch) });
      }),
      // DELETE 回 204，响应里没有 botId，而少了它就不知道该从哪个桶里删。所以整条传进来。
      deleteSkill: signedIn(async (skill: Skill) => {
        await api.deleteSkill(skill.id);
        dispatch({ type: "skill_removed", botId: skill.botId, skillId: skill.id });
      }),
      copySkill: signedIn(async (skillId: SkillId, botId: BotId) => {
        dispatch({ type: "skill_upserted", skill: await api.copySkill(skillId, botId) });
      }),
      // 结论随这条消息的正文走，所以先落那条消息。存下来的那条 skill 是顺带回来的，dismiss 时没有。
      decideSkillOffer: signedIn(async (messageId: MessageId, decision: DecideSkillOfferRequest["decision"]) => {
        const res = await api.decideSkillOffer(messageId, decision);
        dispatch({ type: "message_upserted", message: res.message });
        if (res.skill !== null) dispatch({ type: "skill_upserted", skill: res.skill });
      }),
      createTool: signedIn(async (draft: CreateToolRequest) => {
        dispatch({ type: "tool_upserted", tool: await api.createTool(draft) });
      }),
      updateTool: signedIn(async (toolId: ToolConnectionId, patch: UpdateToolRequest) => {
        dispatch({ type: "tool_upserted", tool: await api.updateTool(toolId, patch) });
      }),
      deleteTool: signedIn(async (toolId: ToolConnectionId) => {
        await api.deleteTool(toolId);
        dispatch({ type: "tool_removed", toolId });
      }),
      updateSettings: signedIn(async (patch: Partial<Settings>) => {
        dispatch({ type: "settings_set", settings: await api.updateSettings(patch) });
      }),
      loadUsage: signedIn(async () => {
        dispatch({ type: "usage_loaded", usage: await api.usage() });
      }),
      dismissOvernight: () => dispatch({ type: "overnight_dismissed" }),
    };
  }, []);

  useEffect(() => {
    let live = true;
    api
      .me()
      .then(({ user }) => loadEntry(user))
      .then((action) => {
        if (live) dispatch(action);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        // 没登录和「服务挂了」得说不一样的话，不然用户看到的都是一个空登录页。
        const login: LoginPhase = isUnauthorized(cause)
          ? { kind: "idle" }
          : { kind: "failed", message: "连不上服务，稍后再试" };
        dispatch({ type: "anonymous", login });
      });
    return () => {
      live = false;
    };
  }, []);

  // 通知要读当下的设置，而 WebSocket 只在 connected 上重建。把 settings 塞进它的依赖，改一次设置就断一次连。
  const settings = state.status === "ready" ? state.settings : null;
  const settingsRef = useRef<Settings | null>(null);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // 同一条 pending 审批会被重推（控制面重连回放就会），计数那边按「之前知道的状态」自然幂等，通知这边没有
  // 这个信息，会照弹第二遍。记下弹过谁，一条审批只打断你一次。
  const notified = useRef(new Set<ApprovalId>());
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const connected = state.status === "ready";
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let countsQueued = false;
    const refreshPendingCounts = () => {
      if (countsQueued) return;
      countsQueued = true;
      queueMicrotask(() => {
        countsQueued = false;
        if (cancelled) return;
        void Promise.all([api.bots(), api.groups()])
          .then(([bots, groups]) => {
            if (!cancelled) dispatch({ type: "pending_counts_loaded", bots: bots.items, groups: groups.items });
          })
          .catch((cause: unknown) => {
            if (!cancelled && isUnauthorized(cause)) {
              dispatch({ type: "anonymous", login: { kind: "failed", message: "登录已过期，请重新登录" } });
            }
          });
      });
    };
    const open = () => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${window.location.host}/api/ws`);
      socket.addEventListener("message", (event) => {
        const parsed = ServerPush.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) return;
        const push = parsed.data;
        if (push.type === "message") dispatch({ type: "message_upserted", message: push.message });
        if (push.type === "message_delta") {
          const { messageId, groupId, delta, done } = push;
          dispatch({ type: "message_delta", messageId, groupId, delta, done });
        }
        if (push.type === "bot_updated") dispatch({ type: "bot_updated", bot: push.bot });
        if (push.type === "bot_deleted") dispatch({ type: "bot_removed", botId: push.botId });
        // 建群的人已经从 POST 的响应知道了这个群。这条推送是给同一个账号别的窗口看的，不抢它们当下的选中。
        if (push.type === "group_created") {
          dispatch({ type: "group_created", group: push.group, task: push.task, select: false });
        }
        if (push.type === "task_updated") dispatch({ type: "task_updated", task: push.task });
        if (push.type === "approval_updated") {
          const unseenTerminal =
            push.approval.status !== "pending" &&
            stateRef.current.status === "ready" &&
            stateRef.current.approvals[push.approval.id] === undefined;
          dispatch({ type: "approval_pushed", approval: push.approval });
          if (unseenTerminal) refreshPendingCounts();
          const current = settingsRef.current;
          if (current !== null && push.approval.status === "pending" && !notified.current.has(push.approval.id)) {
            notified.current.add(push.approval.id);
            notifyApproval(push.approval, current, new Date());
          }
        }
        // 交接是 Bot 等 Bot，不是等你。它记角标，但不该弹一个系统通知把你从别的事上拽回来。
        if (push.type === "handoff_updated") {
          const unseenTerminal =
            push.handoff.status !== "pending" &&
            stateRef.current.status === "ready" &&
            stateRef.current.handoffs[push.handoff.id] === undefined;
          dispatch({ type: "handoff_pushed", handoff: push.handoff });
          if (unseenTerminal) refreshPendingCounts();
        }
        if (push.type === "routine_updated") dispatch({ type: "routine_upserted", routine: push.routine });
        if (push.type === "routine_deleted") {
          dispatch({ type: "routine_removed", botId: push.botId, routineId: push.routineId });
        }
        if (push.type === "skill_updated") dispatch({ type: "skill_upserted", skill: push.skill });
        if (push.type === "skill_deleted") {
          dispatch({ type: "skill_removed", botId: push.botId, skillId: push.skillId });
        }
      });
      // 断了不重连的话 HTTP 还通，界面看着是活的，其实再也收不到推送。
      socket.addEventListener("close", () => {
        if (!cancelled) retry = setTimeout(open, RECONNECT_DELAY_MS);
      });
    };
    open();
    return () => {
      cancelled = true;
      if (retry !== null) clearTimeout(retry);
      socket?.close();
    };
  }, [connected]);

  const theme = state.status === "ready" ? state.settings.theme : "system";
  useEffect(() => applyTheme(theme), [theme]);

  return <AppContext.Provider value={{ state, actions }}>{children}</AppContext.Provider>;
};
