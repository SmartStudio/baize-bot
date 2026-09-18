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
  type Message,
  type MessageId,
  type Settings,
  type TopicTask,
  type User,
} from "@baize/shared";
import type { BotListItem, GroupListItem } from "@baize/shared";
import { RequestFailed, api, type BotDraft, type GroupDraft } from "../api/client.js";
import { notifyApproval } from "./notify.js";
import { applyTheme } from "./theme.js";

export type LoginPhase = { kind: "idle" } | { kind: "submitting" } | { kind: "failed"; message: string };

// 侧栏一条记录就是一个群，两段共用这一个形状。单 Bot 群只有一个成员且不带任务卡，多 Bot 群有 2 到 6 个成员和一张
// 任务卡，写成联合而不是「botIds + task 可空」，是为了让「多 Bot 群没有任务卡」这种状态根本拼不出来。
export type Conversation =
  | { kind: "solo"; groupId: GroupId; botId: BotId; lastMessage: Message | null; pendingApprovals: number }
  | {
      kind: "team";
      groupId: GroupId;
      botIds: BotId[];
      task: TopicTask;
      lastMessage: Message | null;
      pendingApprovals: number;
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
      // 审批卡的状态只在这张表上。approval 类消息的正文只有 approvalId，重推那条消息一个字都不会变。
      approvals: Record<ApprovalId, Approval>;
      settings: Settings;
    };

type Action =
  | { type: "anonymous"; login: LoginPhase }
  | { type: "ready"; user: User; bots: BotListItem[]; groups: GroupListItem[]; settings: Settings }
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
  | { type: "settings_set"; settings: Settings };

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
const touchGroup = (
  conversations: Conversation[],
  groupId: GroupId,
  patch: { lastMessage?: Message; pendingApprovals?: number },
): Conversation[] => conversations.map((c) => (c.groupId === groupId ? { ...c, ...patch } : c));

// 同一条 approval 会从拉历史、决定的响应、服务端推送三条路各来一次，先后不受控。只认「之前知道的状态」，
// 重到的那次自然是 0。null 表示这条该丢掉。
const mergeApproval = (
  previous: Approval | undefined,
  next: Approval,
  from: "history" | "push",
): { approval: Approval; delta: number } | null => {
  // 拉历史带回来的那批，GET /api/bots 和 /api/groups 的 pendingApprovals 已经算进去了，这里再加一次就翻倍。
  if (previous === undefined) return { approval: next, delta: from === "push" && next.status === "pending" ? 1 : 0 };
  if (previous.status === "pending") return { approval: next, delta: next.status === "pending" ? 0 : -1 };
  // 本地已经有结论了。结论不会退回 pending，所以说 pending 的那份是拉取在飞时拍下的旧快照。收下它，卡片会
  // 重新长出两颗按钮，而角标早就减过了，再点只会拿到一个 409。
  return next.status === "pending" ? null : { approval: next, delta: 0 };
};

const withApprovals = (state: ReadyState, incoming: Approval[], from: "history" | "push"): ReadyState => {
  const approvals = { ...state.approvals };
  const deltaByGroup = new Map<GroupId, number>();
  for (const next of incoming) {
    const merged = mergeApproval(approvals[next.id], next, from);
    if (merged === null) continue;
    approvals[merged.approval.id] = merged.approval;
    if (merged.delta !== 0) deltaByGroup.set(next.groupId, (deltaByGroup.get(next.groupId) ?? 0) + merged.delta);
  }
  if (deltaByGroup.size === 0) return { ...state, approvals };
  return {
    ...state,
    approvals,
    conversations: state.conversations.map((c) => {
      const delta = deltaByGroup.get(c.groupId) ?? 0;
      return delta === 0 ? c : { ...c, pendingApprovals: Math.max(0, c.pendingApprovals + delta) };
    }),
  };
};

const enteredState = (user: User, bots: BotListItem[], groups: GroupListItem[], settings: Settings): ReadyState => {
  const registry: Record<BotId, Bot> = {};
  for (const item of bots) registry[item.bot.id] = item.bot;
  const conversations: Conversation[] = [
    ...bots.map((item): Conversation => ({
      kind: "solo",
      groupId: item.groupId,
      botId: item.bot.id,
      lastMessage: item.lastMessage,
      pendingApprovals: item.pendingApprovals,
    })),
    ...groups.map((item): Conversation => ({
      kind: "team",
      groupId: item.group.id,
      botIds: item.group.botIds,
      task: item.task,
      lastMessage: item.lastMessage,
      pendingApprovals: item.pendingApprovals,
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
    settings,
  };
};

const reduce = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case "anonymous":
      return { status: "anonymous", login: action.login };
    case "ready":
      return enteredState(action.user, action.bots, action.groups, action.settings);
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
          { kind: "solo", groupId: action.groupId, botId: action.bot.id, lastMessage: null, pendingApprovals: 0 },
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
    case "settings_set":
      return { ...state, settings: action.settings };
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
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
};

const AppContext = createContext<{ state: AppState; actions: AppActions } | null>(null);

export const useApp = () => {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp 必须在 AppProvider 里用");
  return value;
};

const isUnauthorized = (cause: unknown): boolean => cause instanceof RequestFailed && cause.status === 401;

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
    const enter = async (user: User) => {
      const [bots, groups, settings] = await Promise.all([api.bots(), api.groups(), api.settings()]);
      dispatch({ type: "ready", user, bots: bots.items, groups: groups.items, settings });
    };
    return {
      login: async (email, password) => {
        dispatch({ type: "anonymous", login: { kind: "submitting" } });
        try {
          const { user } = await api.login(email, password);
          await enter(user);
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
        const { messages, approvals } = await api.messages(groupId);
        dispatch({ type: "messages_set", groupId, messages });
        dispatch({ type: "approvals_loaded", approvals });
      }),
      sendMessage: signedIn(async (groupId: GroupId, text: string) => {
        const { message } = await api.sendMessage(groupId, text);
        dispatch({ type: "message_upserted", message });
      }),
      decideApproval: signedIn(async (approvalId: ApprovalId, decision: DecideApprovalRequest["decision"]) => {
        dispatch({ type: "approval_pushed", approval: await api.decideApproval(approvalId, decision) });
      }),
      updateSettings: signedIn(async (patch: Partial<Settings>) => {
        dispatch({ type: "settings_set", settings: await api.updateSettings(patch) });
      }),
    };
  }, []);

  useEffect(() => {
    let live = true;
    api
      .me()
      .then(({ user }) =>
        Promise.all([api.bots(), api.groups(), api.settings()]).then(([bots, groups, settings]) => ({
          user,
          bots,
          groups,
          settings,
        })),
      )
      .then(({ user, bots, groups, settings }) => {
        if (live) dispatch({ type: "ready", user, bots: bots.items, groups: groups.items, settings });
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

  const connected = state.status === "ready";
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
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
          dispatch({ type: "approval_pushed", approval: push.approval });
          const current = settingsRef.current;
          if (current !== null && push.approval.status === "pending" && !notified.current.has(push.approval.id)) {
            notified.current.add(push.approval.id);
            notifyApproval(push.approval, current, new Date());
          }
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
