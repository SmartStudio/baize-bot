import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { ServerPush, type Bot, type BotId, type GroupId, type Message, type Settings, type User } from "@baize/shared";
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
  | { type: "message_added"; message: Message }
  | { type: "settings_set"; settings: Settings };

const withMessage = (list: Message[], message: Message): Message[] =>
  list.some((m) => m.id === message.id) ? list : [...list, message];

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
      // 拉取在飞的时候推回来的消息已经在本地了，用它们兜住返回的历史，别让整份替换把它们吞掉。
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.groupId]: (state.messages[action.groupId] ?? []).reduce(withMessage, action.messages),
        },
      };
    case "message_added": {
      const groupId = action.message.groupId;
      const known = state.messages[groupId];
      return {
        ...state,
        // messages 里有没有这个键就是「这组历史拉过没有」，所以没拉过的组只更侧栏摘要，不能凭一条推送造出一份假历史。
        messages:
          known === undefined ? state.messages : { ...state.messages, [groupId]: withMessage(known, action.message) },
        bots: state.bots.map((item) => (item.groupId === groupId ? { ...item, lastMessage: action.message } : item)),
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
        dispatch({ type: "message_added", message });
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
        if (push.type === "message") dispatch({ type: "message_added", message: push.message });
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
