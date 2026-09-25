import {
  ServerPush,
  type Approval,
  type ApprovalId,
  type Bot,
  type BotId,
  type Group,
  type GroupId,
  type Grant,
  type GrantId,
  type Handoff,
  type HandoffId,
  type Message,
  type MessageId,
  type Routine,
  type RoutineId,
  type Settings,
  type Skill,
  type SkillId,
  type ToolConnection,
  type ToolConnectionId,
  type TopicTask,
  type User,
  type UsageResponse,
} from "@baize/shared";
import type { BotListItem, GroupListItem } from "@baize/shared";

export type LoginPhase = { kind: "idle" } | { kind: "submitting" } | { kind: "failed"; message: string };

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
      chiefBotId: BotId | null;
      task: TopicTask;
      lastMessage: Message | null;
      pendingApprovals: number;
      pendingHandoffs: number;
    };

export const memberIdsOf = (conversation: Conversation): BotId[] =>
  conversation.kind === "solo" ? [conversation.botId] : conversation.botIds;

export type GroupTurn = Extract<ServerPush, { type: "group_turn" }>;

export type AppState =
  | { status: "loading" }
  | { status: "anonymous"; login: LoginPhase; register: LoginPhase }
  | {
      status: "ready";
      user: User;
      bots: Record<BotId, Bot>;
      conversations: Conversation[];
      groupTurns: Record<GroupId, GroupTurn>;
      turnEpochs: Record<GroupId, number>;
      selectedGroupId: GroupId | null;
      messages: Record<GroupId, Message[]>;
      approvals: Record<ApprovalId, Approval>;
      handoffs: Record<HandoffId, Handoff>;
      routines: Record<BotId, Routine[]>;
      skills: Record<BotId, Skill[]>;
      tools: ToolConnection[];
      settings: Settings;
      grants: Grant[];
      revokedGrantIds: GrantId[];
      usage: UsageResponse;
      todayVersion: number;
    };

export type Delta = { groupId: GroupId; messageId: MessageId; delta: string; done: boolean };

export type Action =
  | { type: "anonymous"; login: LoginPhase }
  | { type: "register_phase"; register: LoginPhase }
  | {
      type: "ready";
      user: User;
      bots: BotListItem[];
      groups: GroupListItem[];
      tools: ToolConnection[];
      settings: Settings;
      usage: UsageResponse;
    }
  | { type: "group_selected"; groupId: GroupId | null }
  | { type: "bot_created"; bot: Bot; groupId: GroupId }
  | { type: "bot_updated"; bot: Bot }
  | { type: "bot_removed"; botId: BotId }
  | { type: "group_created"; group: Group; task: TopicTask }
  | { type: "group_updated"; group: Group }
  | { type: "group_turn"; turn: GroupTurn }
  | { type: "turns_cleared" }
  | { type: "task_updated"; task: TopicTask }
  | { type: "messages_set"; groupId: GroupId; messages: Message[] }
  | { type: "message_upserted"; message: Message }
  | ({ type: "message_delta" } & Delta)
  | { type: "approvals_loaded"; approvals: Approval[] }
  | { type: "approval_pushed"; approval: Approval }
  | { type: "grants_loaded"; grants: Grant[] }
  | { type: "grant_upserted"; grant: Grant }
  | { type: "grant_deleted"; grantId: GrantId }
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
  | { type: "today_version_bumped" };

export type ReadyState = Extract<AppState, { status: "ready" }>;
