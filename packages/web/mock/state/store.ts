import {
  Approval,
  Bot,
  Group,
  Handoff,
  Message,
  Routine,
  Settings,
  Skill,
  ToolConnection,
  TopicTask,
  User,
  type BotHue,
} from "@baize/shared";

export type ApprovalDecision = "approved" | "rejected";

export const MOCK_EMAIL = "chen@baize.dev";
export const MOCK_PASSWORD = "baize-dev";

const T0 = Date.parse("2026-09-18T01:00:00.000Z");
export const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

export const ranAt = (daysAgo: number): string => {
  const day = new Date();
  day.setDate(day.getDate() - daysAgo);
  day.setHours(9, 0, 0, 0);
  return new Date(Math.min(day.getTime(), Date.now() - 60_000)).toISOString();
};

let counter = 0;
export const nextSuffix = () => `${(counter += 1)}`;
export const resetSuffix = (): void => {
  counter = 0;
};

export const user: User = User.parse({
  id: "usr_chen",
  name: "陈默",
  email: MOCK_EMAIL,
  createdAt: at(0),
});

export const bots = new Map<string, Bot>();
export const groups = new Map<string, Group>();
export const tasks = new Map<string, TopicTask>();
export const groupIdByBotId = new Map<string, string>();
export const messagesByGroupId = new Map<string, Message[]>();
export const approvals = new Map<string, Approval>();
export const handoffs = new Map<string, Handoff>();
export const routines = new Map<string, Routine>();
export const skills = new Map<string, Skill>();
export const tools = new Map<string, ToolConnection>();

export const settings: { current: Settings } = {
  current: Settings.parse({ theme: "system", notify: true, dndFrom: "22:00", dndTo: "08:00" }),
};

export const isTeamGroup = (group: Group): boolean => group.botIds.length > 1;

const FIRST_TASK_NUMBER = 2481;
let lastTaskNumber = FIRST_TASK_NUMBER;
export const nextTaskNumber = (): string => {
  lastTaskNumber += 1;
  return `T-${lastTaskNumber}`;
};
export const resetTaskNumber = (): void => {
  lastTaskNumber = FIRST_TASK_NUMBER;
};

export const TEAM_GROUP_ID = "grp_order";
export const TEAM_TASK_ID = "tsk_order";
export const TEAM_BOT_IDS = ["bot_service", "bot_sales", "bot_buy"];
export const TEAM_CHECKLIST = [
  "查 X3 库存与排产，确认 200 台的交付节奏",
  "出 200 台 X3 的报价单",
  "跟 Lisa 确认交期和付款方式",
  "报价发出去之前找陈默点头",
  "订单录进 ERP，交期同步给客户",
];

export const taskNumber = (): string => `T-${FIRST_TASK_NUMBER}`;

let generation = 0;
export const currentGeneration = (): number => generation;
export const advanceGeneration = (): void => {
  generation += 1;
};

export const waiters = new Map<string, (decision: ApprovalDecision) => void>();
export const handoffWaiters = new Map<string, () => void>();
export const handoffAcceptance: { automatic: boolean } = { automatic: true };

export const HUES: BotHue[] = ["coral", "tangerine", "lime", "mint", "sky", "violet", "pink"];
