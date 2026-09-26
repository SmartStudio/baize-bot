import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import {
  ServerPush,
  type AccountId,
  type AccountTier,
  type ApprovalId,
  type ApprovePlanRequest,
  type ContentPlanId,
  type DecideDraftRequest,
  type DraftId,
  type TodayResponse,
  type BotId,
  type ChecklistItem,
  type DecideApprovalRequest,
  type GrantId,
  type GroupId,
  type MessageId,
  type CreateRoutineRequest,
  type CreateSkillRequest,
  type CreateToolRequest,
  type DecideSkillOfferRequest,
  type Routine,
  type RoutineId,
  type Settings,
  type Skill,
  type SkillId,
  type ToolConnectionId,
  type UpdateRoutineRequest,
  type UpdateSkillRequest,
  type UpdateToolRequest,
  type TopicTask,
  type User,
} from "@baize/shared";
import { RequestFailed, api, type BotDraft, type DecideProjectOfferRequest } from "../api/client.js";
import { applyTheme } from "./theme.js";
import { createPushHandlers, dispatchServerPush } from "./push.js";
import { reduce } from "./reducer.js";
import type { Action, AppState, SnapshotMerge } from "./types.js";

export { memberIdsOf } from "./types.js";
export type { AppState, Conversation, GroupTurn, LoginPhase } from "./types.js";
import type { LoginPhase } from "./types.js";

export type AppActions = {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  // 建完返回新群，由调用方跳过去。登录过期时是 undefined。
  createBot: () => Promise<GroupId | undefined>;
  updateBot: (botId: BotId, draft: BotDraft) => Promise<void>;
  setChecklist: (task: TopicTask, checklist: ChecklistItem[]) => Promise<void>;
  loadMessages: (groupId: GroupId) => Promise<void>;
  sendMessage: (groupId: GroupId, text: string) => Promise<void>;
  decideApproval: (approvalId: ApprovalId, request: DecideApprovalRequest) => Promise<void>;
  decideDraft: (draftId: DraftId, request: DecideDraftRequest) => Promise<void>;
  approvePlan: (planId: ContentPlanId, request: ApprovePlanRequest) => Promise<void>;
  returnPlan: (planId: ContentPlanId) => Promise<void>;
  // 首页快照里带着草稿和计划，顺手补进同一张表，首页展开的卡和群里的卡读的是同一份。
  loadToday: () => Promise<TodayResponse>;
  loadAccounts: () => Promise<void>;
  updateAccountTier: (accountId: AccountId, tier: AccountTier) => Promise<void>;
  loadGrants: () => Promise<void>;
  deleteGrant: (grantId: GrantId) => Promise<void>;
  pauseBot: (botId: BotId) => Promise<void>;
  resumeBot: (botId: BotId) => Promise<void>;
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
  // 开始了就返回项目群，由调用方跳过去；不要或登录过期时是 undefined。
  decideProjectOffer: (messageId: MessageId, request: DecideProjectOfferRequest) => Promise<GroupId | undefined>;
  createTool: (draft: CreateToolRequest) => Promise<void>;
  updateTool: (toolId: ToolConnectionId, patch: UpdateToolRequest) => Promise<void>;
  deleteTool: (toolId: ToolConnectionId) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  loadUsage: () => Promise<void>;
};

const AppContext = createContext<{ state: AppState; actions: AppActions } | null>(null);

export const useApp = () => {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp 必须在 AppProvider 里用");
  return value;
};

const isUnauthorized = (cause: unknown): boolean => cause instanceof RequestFailed && cause.status === 401;

const loadEntry = async (user: User): Promise<Extract<Action, { type: "ready" }>> => {
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

const RECONNECT_DELAY_MS = 1000;

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(reduce, { status: "loading" } satisfies AppState);
  // 推送重连时置上，下一次发出的首页快照拿去 resync，发出去就收回。
  const resyncPending = useRef(false);

  const actions = useMemo<AppActions>(() => {
    // 会话过期后每个请求都会 401。不接住的话界面停在 ready 上，发消息、存设置全都静悄悄地不生效。
    const signedIn = <A extends unknown[], R>(run: (...args: A) => Promise<R>) => {
      return async (...args: A): Promise<R | undefined> => {
        try {
          return await run(...args);
        } catch (cause) {
          if (!isUnauthorized(cause)) throw cause;
          dispatch({ type: "anonymous", login: { kind: "failed", message: "登录已过期，请重新登录" } });
          return undefined;
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
      register: async (email, password, name) => {
        dispatch({ type: "register_phase", register: { kind: "submitting" } });
        try {
          const { user } = await api.register(email, password, name);
          dispatch(await loadEntry(user));
        } catch (cause) {
          const message = cause instanceof RequestFailed ? cause.message : "注册失败，再试一次";
          dispatch({ type: "register_phase", register: { kind: "failed", message } });
        }
      },
      logout: async () => {
        await api.logout();
        dispatch({ type: "anonymous", login: { kind: "idle" } });
      },
      createBot: signedIn(async () => {
        const { bot, group } = await api.createBot({});
        dispatch({ type: "bot_created", bot, groupId: group.id });
        return group.id;
      }),
      updateBot: signedIn(async (botId: BotId, draft: BotDraft) => {
        dispatch({ type: "bot_updated", bot: await api.updateBot(botId, draft) });
      }),
      setChecklist: signedIn(async (task: TopicTask, checklist: ChecklistItem[]) => {
        dispatch({ type: "task_updated", task: await api.updateTask(task.id, { checklist }) });
      }),
      loadMessages: signedIn(async (groupId: GroupId) => {
        const { messages, approvals, handoffs, drafts, plans, publications } = await api.messages(groupId);
        dispatch({ type: "content_loaded", drafts, plans });
        dispatch({ type: "publications_loaded", publications });
        dispatch({ type: "messages_set", groupId, messages });
        dispatch({ type: "approvals_loaded", approvals });
        dispatch({ type: "handoffs_loaded", handoffs });
      }),
      sendMessage: signedIn(async (groupId: GroupId, text: string) => {
        const { message } = await api.sendMessage(groupId, text);
        dispatch({ type: "message_upserted", message });
      }),
      decideApproval: signedIn(async (approvalId: ApprovalId, request: DecideApprovalRequest) => {
        const result = await api.decideApproval(approvalId, request);
        dispatch({ type: "approval_pushed", approval: result.approval });
        if (result.grant !== null) dispatch({ type: "grant_upserted", grant: result.grant });
      }),
      decideDraft: signedIn(async (draftId: DraftId, request: DecideDraftRequest) => {
        const { draft } = await api.decideDraft(draftId, request);
        dispatch({ type: "content_loaded", drafts: [draft], plans: [] });
      }),
      approvePlan: signedIn(async (planId: ContentPlanId, request: ApprovePlanRequest) => {
        const { plan, drafts } = await api.approvePlan(planId, request);
        dispatch({ type: "content_loaded", drafts, plans: [plan] });
      }),
      returnPlan: signedIn(async (planId: ContentPlanId) => {
        const { plan } = await api.returnPlan(planId);
        dispatch({ type: "content_loaded", drafts: [], plans: [plan] });
      }),
      loadToday: async () => {
        const merge: SnapshotMerge = resyncPending.current ? "resync" : "fill";
        resyncPending.current = false;
        const today = await api.today().catch((cause: unknown) => {
          if (merge === "resync") resyncPending.current = true;
          throw cause;
        });
        const plans = today.pending.flatMap((item) => (item.kind === "plan" ? [item.plan] : []));
        const drafts = [
          ...today.pending.flatMap((item) =>
            item.kind === "plan" ? item.drafts : item.kind === "draft" ? [item.draft] : [],
          ),
          ...today.next.flatMap((item) => (item.kind === "draft" ? [item.draft] : [])),
        ];
        dispatch({ type: "today_snapshot_loaded", drafts, plans, merge });
        return today;
      },
      loadAccounts: signedIn(async () => {
        const [{ accounts }, { computers }] = await Promise.all([api.accounts(), api.computers()]);
        dispatch({ type: "accounts_loaded", accounts, computers });
      }),
      updateAccountTier: signedIn(async (accountId: AccountId, tier: AccountTier) => {
        dispatch({ type: "account_upserted", account: (await api.updateAccount(accountId, { tier })).account });
      }),
      loadGrants: signedIn(async () => {
        dispatch({ type: "grants_loaded", grants: (await api.grants()).grants });
      }),
      deleteGrant: signedIn(async (grantId: GrantId) => {
        await api.deleteGrant(grantId);
        dispatch({ type: "grant_deleted", grantId });
      }),
      pauseBot: signedIn(async (botId: BotId) => {
        dispatch({ type: "bot_updated", bot: await api.pauseBot(botId) });
      }),
      resumeBot: signedIn(async (botId: BotId) => {
        dispatch({ type: "bot_updated", bot: await api.resumeBot(botId) });
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
      decideProjectOffer: signedIn(async (messageId: MessageId, request: DecideProjectOfferRequest) => {
        const { message, group } = await api.decideProjectOffer(messageId, request);
        dispatch({ type: "message_upserted", message });
        if (group === null) return undefined;
        // 推送里的 group_created 可能还在路上，侧栏没这个群时跳过去会被弹回首页。回包没带任务卡，从列表补一份。
        const joined = (await api.groups()).items.find((item) => item.group.id === group.id);
        if (joined !== undefined) dispatch({ type: "group_created", group: joined.group, task: joined.task });
        return group.id;
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

  const settings = state.status === "ready" ? state.settings : null;
  const settingsRef = useRef<Settings | null>(null);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const connected = state.status === "ready";
  // 卡片上的「从哪台电脑发」和账号页都读这两张表。拉不到只是少写一句电脑名，不该拖住整个入口。
  useEffect(() => {
    if (connected) actions.loadAccounts().catch(() => undefined);
  }, [connected, actions]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let hasConnected = false;
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
    const pushHandlers = createPushHandlers({
      dispatch,
      stateRef,
      settingsRef,
      refreshPendingCounts,
    });
    const open = () => {
      dispatch({ type: "turns_cleared" });
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${window.location.host}/api/ws`);
      socket.addEventListener("open", () => {
        if (hasConnected) {
          resyncPending.current = true;
          dispatch({ type: "today_version_bumped" });
        }
        hasConnected = true;
      });
      socket.addEventListener("message", (event) => {
        const parsed = ServerPush.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) return;
        const push = parsed.data;
        dispatchServerPush(pushHandlers, push);
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
