import type { Bot, BotId } from "@baize/shared";
import { reduceApprovals } from "./approvals.js";
import { reduceBrand } from "./brand.js";
import { EMPTY_CONTENT, reduceContent } from "./content.js";
import { rearmGaps, reduceGroups } from "./groups.js";
import { reducePreferences } from "./preferences.js";
import { reduceRoutines } from "./routines.js";
import { reduceSettings } from "./settings.js";
import { reduceSkills } from "./skills.js";
import { emptyShelf, type Seq } from "./stamped.js";
import type { Action, AppState, Conversation, ReadyState } from "./types.js";

const enteredState = (action: Extract<Action, { type: "ready" }>): ReadyState => {
  const { session, user, bots, groups, tools, settings, usage } = action;
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
      chiefBotId: item.group.chiefBotId,
      task: item.task,
      lastMessage: item.lastMessage,
      pendingApprovals: item.pendingApprovals,
      pendingHandoffs: item.pendingHandoffs,
    })),
  ];
  return {
    status: "ready",
    session,
    user,
    bots: registry,
    conversations,
    groupTurns: {},
    turnEpochs: {},
    messages: emptyShelf(),
    approvals: {},
    handoffs: {},
    grants: [],
    revokedGrantIds: [],
    routines: emptyShelf(),
    skills: emptyShelf(),
    preferences: emptyShelf(),
    deletedPreferences: {},
    brand: null,
    tools,
    settings,
    usage,
    content: EMPTY_CONTENT,
    todayVersion: 0,
    reconnectedAt: 0 as Seq,
    messagesLoadedAt: {},
    messageGaps: {},
    deletedBotIds: [],
    loads: {},
  };
};

export const reduce = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case "anonymous":
      return { status: "anonymous", login: action.login, register: { kind: "idle" } };
    case "register_phase":
      return state.status === "anonymous" ? { ...state, register: action.register } : state;
    case "ready":
      return enteredState(action);
    // 旧会话在途的回包和推送可能在登出、重新登录之后才落地，不能写进新会话。
    case "from_session":
      return state.status === "ready" && state.session === action.session ? reduce(state, action.action) : state;
    default:
      break;
  }
  if (state.status !== "ready") return state;
  if (action.type === "today_version_bumped") return { ...state, todayVersion: state.todayVersion + 1 };
  if (action.type === "push_reconnected")
    return {
      ...state,
      todayVersion: state.todayVersion + 1,
      reconnectedAt: action.seq,
      messageGaps: rearmGaps(state.messageGaps),
    };
  if (action.type === "load_status") return { ...state, loads: { ...state.loads, [action.key]: action.status } };
  const groups = reduceGroups(state, action);
  const approvals = reduceApprovals(groups, action);
  const routines = reduceRoutines(approvals, action);
  const skills = reduceSkills(routines, action);
  const preferences = reducePreferences(skills, action);
  const brand = reduceBrand(preferences, action);
  return reduceContent(reduceSettings(brand, action), action);
};
