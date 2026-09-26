import {
  ServerPush,
  type Account,
  type AccountId,
  type Approval,
  type ApprovalId,
  type Bot,
  type BotId,
  type Computer,
  type ComputerId,
  type ContentPlan,
  type ContentPlanId,
  type Draft,
  type DraftId,
  type Group,
  type GroupId,
  type Grant,
  type GrantId,
  type Handoff,
  type HandoffId,
  type Message,
  type MessageId,
  type Publication,
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

// 草稿卡、计划卡和账号页共用的几张表。群历史、首页快照、接口响应和推送都往这里写，卡片只从这里读，
// 首页展开的卡和群里的同一张卡因此不会各说各的。发布只从推送来，所以原帖链接只有卡片开着时发出的那条才有。
export type ContentBook = {
  drafts: Record<DraftId, Draft>;
  plans: Record<ContentPlanId, ContentPlan>;
  accounts: Record<AccountId, Account>;
  computers: Record<ComputerId, Computer>;
  publications: Record<DraftId, Publication>;
};

// 首页快照可能在推送之前生成、之后才到，平时只补表里还没有的条目。断线期间漏掉的推送没人补，
// 所以重连后发出的第一次快照可以盖掉已有的。
export type SnapshotMerge = "fill" | "resync";

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
      content: ContentBook;
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
  | { type: "content_loaded"; drafts: Draft[]; plans: ContentPlan[] }
  | { type: "today_snapshot_loaded"; drafts: Draft[]; plans: ContentPlan[]; merge: SnapshotMerge }
  | { type: "accounts_loaded"; accounts: Account[]; computers: Computer[] }
  | { type: "account_upserted"; account: Account }
  | { type: "account_removed"; accountId: AccountId }
  | { type: "computer_upserted"; computer: Computer }
  | { type: "publications_loaded"; publications: Publication[] }
  | { type: "today_version_bumped" };

export type ReadyState = Extract<AppState, { status: "ready" }>;
