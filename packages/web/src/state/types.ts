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
import type { Seq, Shelf, Stamps } from "./stamped.js";

// 一次登录就绪算一个会话，每次就绪换一个号。会话里发起的异步动作都带着发起时的号，号对不上就丢，见 reducer.ts。
export type SessionId = number & { readonly __session: unique symbol };

// 群历史、例行、会做的活三种按桶拉的列表各自的拉取状态。没有记录就是 idle。
export type LoadStatus = "idle" | "loading" | "failed";
export type LoadKey = `messages:${GroupId}` | `routines:${BotId}` | `skills:${BotId}`;

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
// 首页展开的卡和群里的同一张卡因此不会各说各的。草稿和计划的先后按 stamps 排，见 stamped.ts。
export type ContentBook = {
  drafts: Record<DraftId, Draft>;
  plans: Record<ContentPlanId, ContentPlan>;
  accounts: Record<AccountId, Account>;
  computers: Record<ComputerId, Computer>;
  publications: Record<DraftId, Publication>;
  stamps: Stamps;
};

export type GroupTurn = Extract<ServerPush, { type: "group_turn" }>;

export type AppState =
  | { status: "loading" }
  | { status: "anonymous"; login: LoginPhase; register: LoginPhase }
  | {
      status: "ready";
      session: SessionId;
      user: User;
      bots: Record<BotId, Bot>;
      conversations: Conversation[];
      groupTurns: Record<GroupId, GroupTurn>;
      turnEpochs: Record<GroupId, number>;
      messages: Shelf<GroupId, Message>;
      approvals: Record<ApprovalId, Approval>;
      handoffs: Record<HandoffId, Handoff>;
      routines: Shelf<BotId, Routine>;
      skills: Shelf<BotId, Skill>;
      tools: ToolConnection[];
      settings: Settings;
      grants: Grant[];
      revokedGrantIds: GrantId[];
      usage: UsageResponse;
      content: ContentBook;
      todayVersion: number;
      // 推送最近一次重连时取的号，messagesLoadedAt 是每个群的历史请求发出时取的号。比重连早的历史可能漏了断线时的推送。
      reconnectedAt: Seq;
      messagesLoadedAt: Record<GroupId, Seq>;
      loads: Partial<Record<LoadKey, LoadStatus>>;
    };

export type Delta = { groupId: GroupId; messageId: MessageId; delta: string; done: boolean };

export type Action =
  | { type: "anonymous"; login: LoginPhase }
  | { type: "register_phase"; register: LoginPhase }
  | {
      type: "ready";
      session: SessionId;
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
  | { type: "messages_set"; groupId: GroupId; messages: Message[]; seq: Seq }
  | { type: "message_upserted"; message: Message; seq: Seq }
  | ({ type: "message_delta"; seq: Seq } & Delta)
  | { type: "approvals_loaded"; approvals: Approval[] }
  | { type: "approval_pushed"; approval: Approval }
  | { type: "grants_loaded"; grants: Grant[] }
  | { type: "grant_upserted"; grant: Grant }
  | { type: "grant_deleted"; grantId: GrantId }
  | { type: "handoffs_loaded"; handoffs: Handoff[] }
  | { type: "handoff_pushed"; handoff: Handoff }
  | { type: "pending_counts_loaded"; bots: BotListItem[]; groups: GroupListItem[] }
  | { type: "routines_loaded"; botId: BotId; routines: Routine[]; seq: Seq }
  | { type: "routine_upserted"; routine: Routine; seq: Seq }
  | { type: "routine_removed"; botId: BotId; routineId: RoutineId; seq: Seq }
  | { type: "skills_loaded"; botId: BotId; skills: Skill[]; seq: Seq }
  | { type: "skill_upserted"; skill: Skill; seq: Seq }
  | { type: "skill_removed"; botId: BotId; skillId: SkillId; seq: Seq }
  | { type: "tool_upserted"; tool: ToolConnection }
  | { type: "tool_removed"; toolId: ToolConnectionId }
  | { type: "settings_set"; settings: Settings }
  | { type: "usage_loaded"; usage: UsageResponse }
  | { type: "content_loaded"; drafts: Draft[]; plans: ContentPlan[]; seq: Seq }
  | { type: "accounts_loaded"; accounts: Account[]; computers: Computer[] }
  | { type: "account_upserted"; account: Account }
  | { type: "account_removed"; accountId: AccountId }
  | { type: "computer_upserted"; computer: Computer }
  | { type: "publications_loaded"; publications: Publication[] }
  | { type: "today_version_bumped" }
  | { type: "push_reconnected"; seq: Seq }
  | { type: "load_status"; key: LoadKey; status: LoadStatus }
  | { type: "from_session"; session: SessionId; action: Action };

export type ReadyState = Extract<AppState, { status: "ready" }>;
