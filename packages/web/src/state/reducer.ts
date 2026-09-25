import type { Bot, BotId } from "@baize/shared";
import { reduceApprovals } from "./approvals.js";
import { reduceGroups } from "./groups.js";
import { reduceRoutines } from "./routines.js";
import { reduceSettings } from "./settings.js";
import { reduceSkills } from "./skills.js";
import type { Action, AppState, Conversation, ReadyState } from "./types.js";

const enteredState = (action: Extract<Action, { type: "ready" }>): ReadyState => {
  const { user, bots, groups, tools, settings, usage } = action;
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
    user,
    bots: registry,
    conversations,
    groupTurns: {},
    turnEpochs: {},
    selectedGroupId: null,
    messages: {},
    approvals: {},
    handoffs: {},
    grants: [],
    revokedGrantIds: [],
    routines: {},
    skills: {},
    tools,
    settings,
    usage,
    todayVersion: 0,
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
    default:
      break;
  }
  if (state.status !== "ready") return state;
  if (action.type === "today_version_bumped") return { ...state, todayVersion: state.todayVersion + 1 };
  const groups = reduceGroups(state, action);
  const approvals = reduceApprovals(groups, action);
  const routines = reduceRoutines(approvals, action);
  const skills = reduceSkills(routines, action);
  return reduceSettings(skills, action);
};
