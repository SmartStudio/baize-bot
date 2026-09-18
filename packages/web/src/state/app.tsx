import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import {
  ServerPush,
  type Bot,
  type BotId,
  type GroupId,
  type Message,
  type MessageId,
  type Settings,
  type User,
} from "@baize/shared";
import type { BotListItem } from "@baize/shared";
import { RequestFailed, api, type BotDraft } from "../api/client.js";
import { applyTheme } from "./theme.js";

export type LoginPhase = { kind: "idle" } | { kind: "submitting" } | { kind: "failed"; message: string };

export type AppState =
  | { status: "loading" }
  | { status: "anonymous"; login: LoginPhase }
  | {
      status: "ready";
      user: User;
      bots: BotListItem[];
      selectedBotId: BotId | null;
      messages: Record<GroupId, Message[]>;
      settings: Settings;
    };

type Action =
  | { type: "anonymous"; login: LoginPhase }
  | { type: "ready"; user: User; bots: BotListItem[]; settings: Settings }
  | { type: "bot_selected"; botId: BotId }
  | { type: "bot_created"; item: BotListItem }
  | { type: "bot_updated"; bot: Bot }
  | { type: "bot_removed"; botId: BotId }
  | { type: "messages_set"; groupId: GroupId; messages: Message[] }
  | { type: "message_upserted"; message: Message }
  | ({ type: "message_delta" } & Delta)
  | { type: "settings_set"; settings: Settings };

// 流式回复的每一段。正文只有 delta 这几个字，落地成一条完整消息要靠本地已有的那条补齐。
type Delta = { groupId: GroupId; messageId: MessageId; delta: string; done: boolean };

// 同一条消息服务端会重推（tool_call 从 running 变 ok 就是重推），按 id 覆盖，不能追加成两条。
const upsert = (list: Message[], message: Message): Message[] =>
  list.some((m) => m.id === message.id) ? list.map((m) => (m.id === message.id ? message : m)) : [...list, message];

const streamedInto = (previous: Message | undefined, groupBotId: BotId, delta: Delta): Message => {
  const grown = previous?.body.kind === "bot" ? previous.body : null;
  return {
    id: delta.messageId,
    groupId: delta.groupId,
    // delta 报文不带 botId，第一段到的时候只能按「这个群里的 Bot」署名。
    body: {
      kind: "bot",
      botId: grown?.botId ?? groupBotId,
      text: (grown?.text ?? "") + delta.delta,
      streaming: !delta.done,
    },
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
};

const reduce = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case "anonymous":
      return { status: "anonymous", login: action.login };
    case "ready":
      return {
        status: "ready",
        user: action.user,
        bots: action.bots,
        selectedBotId: action.bots[0]?.bot.id ?? null,
        messages: {},
        settings: action.settings,
      };
    default:
      break;
  }
  if (state.status !== "ready") return state;
  switch (action.type) {
    case "bot_selected":
      return { ...state, selectedBotId: action.botId };
    case "bot_created":
      return { ...state, bots: [...state.bots, action.item], selectedBotId: action.item.bot.id };
    case "bot_updated":
      return {
        ...state,
        bots: state.bots.map((item) => (item.bot.id === action.bot.id ? { ...item, bot: action.bot } : item)),
      };
    case "bot_removed": {
      const bots = state.bots.filter((item) => item.bot.id !== action.botId);
      return {
        ...state,
        bots,
        selectedBotId: state.selectedBotId === action.botId ? (bots[0]?.bot.id ?? null) : state.selectedBotId,
      };
    }
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
        bots: state.bots.map((item) => (item.groupId === groupId ? { ...item, lastMessage: action.message } : item)),
      };
    }
    case "message_delta": {
      const owner = state.bots.find((item) => item.groupId === action.groupId);
      // 群里一个 Bot 都没有，这段字就没人能署名。与其造一条不知道谁说的消息，不如丢掉。
      if (owner === undefined) return state;
      const known = state.messages[action.groupId];
      const grown = streamedInto(
        known?.find((m) => m.id === action.messageId),
        owner.bot.id,
        action,
      );
      return {
        ...state,
        messages: known === undefined ? state.messages : { ...state.messages, [action.groupId]: upsert(known, grown) },
        bots: state.bots.map((item) => (item.groupId === action.groupId ? { ...item, lastMessage: grown } : item)),
      };
    }
    case "settings_set":
      return { ...state, settings: action.settings };
    default:
      return state;
  }
};

export type AppActions = {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectBot: (botId: BotId) => void;
  createBot: () => Promise<void>;
  updateBot: (botId: BotId, draft: BotDraft) => Promise<void>;
  loadMessages: (groupId: GroupId) => Promise<void>;
  sendMessage: (groupId: GroupId, text: string) => Promise<void>;
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
      const [bots, settings] = await Promise.all([api.bots(), api.settings()]);
      dispatch({ type: "ready", user, bots: bots.items, settings });
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
      selectBot: (botId) => dispatch({ type: "bot_selected", botId }),
      createBot: signedIn(async () => {
        const { bot, group } = await api.createBot({});
        dispatch({ type: "bot_created", item: { bot, groupId: group.id, lastMessage: null, pendingApprovals: 0 } });
      }),
      updateBot: signedIn(async (botId: BotId, draft: BotDraft) => {
        dispatch({ type: "bot_updated", bot: await api.updateBot(botId, draft) });
      }),
      loadMessages: signedIn(async (groupId: GroupId) => {
        const { messages } = await api.messages(groupId);
        dispatch({ type: "messages_set", groupId, messages });
      }),
      sendMessage: signedIn(async (groupId: GroupId, text: string) => {
        const { message } = await api.sendMessage(groupId, text);
        dispatch({ type: "message_upserted", message });
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
        Promise.all([api.bots(), api.settings()]).then(([bots, settings]) => ({ user, bots, settings })),
      )
      .then(({ user, bots, settings }) => {
        if (live) dispatch({ type: "ready", user, bots: bots.items, settings });
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
