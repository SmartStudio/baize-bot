import {
  ServerPush,
  type Account,
  type AccountId,
  type Approval,
  type ApprovalId,
  type Bot,
  type BotId,
  type BrandBook,
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
  type LoginAttemptId,
  type LoginFailure,
  type Message,
  type MessageId,
  type Preference,
  type PreferenceId,
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
import type { MY_ROUTINES } from "./routines.js";
import type { Seq, Shelf, Stamps } from "./stamped.js";

// 一次登录就绪算一个会话，每次就绪换一个号。会话里发起的异步动作都带着发起时的号，号对不上就丢，见 reducer.ts。
export type SessionId = number & { readonly __session: unique symbol };

// 群历史、例行、会做的活三种按桶拉的列表各自的拉取状态。没有记录就是 idle。
export type LoadStatus = "idle" | "loading" | "failed";
export type LoadKey =
  | `messages:${GroupId}`
  | `message:${MessageId}`
  | "routines"
  | "groups"
  | "counts"
  | `skills:${BotId}`
  | `preferences:${BotId}`;

// 某条消息的流式 delta 漏了版本：手上这份到 revision 为止都不可信，要单独把这一条拉回来，见 groups.ts 的 message_delta。
// seq 是最近一次发现漏档时取的号，比它早发出的那趟拉取不算数。attempts 是单拉连着失败了几次，
// 到 MESSAGE_GAP_ATTEMPTS 就不再自己拉，等重连或这个群重拉历史再给一轮机会。
export type MessageGap = { groupId: GroupId; revision: number; seq: Seq; attempts: number };
export const MESSAGE_GAP_ATTEMPTS = 3;

export type LoginPhase = { kind: "idle" } | { kind: "submitting" } | { kind: "failed"; message: string };

export type PendingCounts = { pendingApprovals: number; pendingHandoffs: number };

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

// 点了「打开登录窗口」之后这个号的登录走到哪一步。没有记录就是没点过；点过的号登上了，卡片才说「已登录」而不是消失。
// opening 记着这次点击取的号和为它取的尝试号：结算只落在同一次点击上，别的点击、别的尝试的结果碰不到它。
// offline 是控制面回 409 或电脑中途离线，refused 是别的错；failed 是电脑报回来的登录没成，账号本身的 login 不变；
// lapsed 是等到超时或重连都没等到结果。signed_in 是等到了 login 为 valid 的账号，之后再过期，卡片从头要你登录。
export type LoginFlow =
  | { status: "opening"; startedAt: Seq; attempt: LoginAttemptId }
  | { status: "signed_in" }
  | { status: "offline" }
  | { status: "refused"; message: string }
  | { status: "failed"; reason: LoginFailure }
  | { status: "lapsed" };

// 草稿卡、计划卡和账号页共用的几张表。群历史、首页快照、接口响应和推送都往这里写，卡片只从这里读，
// 首页展开的卡和群里的同一张卡因此不会各说各的。草稿、计划和账号的先后按 stamps 排，见 stamped.ts。
export type ContentBook = {
  drafts: Record<DraftId, Draft>;
  plans: Record<ContentPlanId, ContentPlan>;
  accounts: Record<AccountId, Account>;
  computers: Record<ComputerId, Computer>;
  publications: Record<DraftId, Publication>;
  logins: Partial<Record<AccountId, LoginFlow>>;
  stamps: Stamps;
};

export type GroupTurn = Extract<ServerPush, { type: "group_turn" }>;

export type TeamOfferOutcome = "confirmed" | "dismissed";

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
      // 团队名单最后一次写入的号。操作回包带请求发出时的号，比它晚到的队伍推送写过的名单不会被旧回包盖回去。
      groupStamps: Stamps;
      // 名单可能落后于服务端时加一：群写入被序号挡掉、推送重连。每加一次补拉一趟 /api/groups。
      groupsVersion: number;
      // 待办角标只认 groups_loaded 和 pending_counts_loaded 两份绝对快照，按群记最后写入的那趟请求发出时的号。
      // 更早发出的请求回包不写；推送不改数，只换来一趟补拉。
      countStamps: Stamps;
      // 群还没入列时就写进来的计数。名单和建群推送各走各的路，计数可能先到；群入列时用这里的数，不用入列那份里更早的。
      // 不入列的记录由更晚的完整计数回收：里面没有这个群就删，并盖号挡住更早发出的计数晚到。会话重建时整表清空。
      unlistedCounts: Record<GroupId, PendingCounts>;
      // 建队卡点完拿到的终态。首页、项目页读的清单正文可能是旧快照，三个入口的卡都先认这里。
      offerOutcomes: Record<MessageId, TeamOfferOutcome>;
      // 建队卡点下去还没回包的。卡折叠重开、换页都是新实例，读这里才知道该锁着。
      offersInFlight: Record<MessageId, true>;
      messages: Shelf<GroupId, Message>;
      approvals: Record<ApprovalId, Approval>;
      handoffs: Record<HandoffId, Handoff>;
      routines: Shelf<typeof MY_ROUTINES, Routine>;
      skills: Shelf<BotId, Skill>;
      preferences: Shelf<BotId, Preference>;
      // 本地已确认删掉的偏好 id。id 不复用，所以删除是终态：之后到的该 id 的更新一律丢，不看序号。
      deletedPreferences: Record<PreferenceId, true>;
      // 没写过是 null。
      brand: BrandBook | null;
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
      messageGaps: Record<MessageId, MessageGap>;
      // 本会话收到过删除推送的 Bot。Bot 表和群表是入口分两次取的，表里没有的成员可能只是建得比 Bot 表晚，不算删了。
      deletedBotIds: BotId[];
      loads: Partial<Record<LoadKey, LoadStatus>>;
    };

export type Delta = { groupId: GroupId; messageId: MessageId; delta: string; done: boolean; revision: number };

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
  | { type: "group_created"; group: Group; task: TopicTask; seq: Seq }
  | { type: "group_updated"; group: Group; seq: Seq }
  | { type: "group_turn"; turn: GroupTurn }
  | { type: "turns_cleared" }
  | { type: "task_updated"; task: TopicTask }
  | { type: "messages_set"; groupId: GroupId; messages: Message[]; seq: Seq }
  | { type: "message_upserted"; message: Message; seq: Seq }
  | ({ type: "message_delta"; seq: Seq } & Delta)
  // 单拉漏档的那条失败了（不含 404）。
  | { type: "message_gap_failed"; messageId: MessageId }
  // 单拉回 404：消息已删或所在群已没有 Bot，这条漏档不会再补齐。
  | { type: "message_gone"; messageId: MessageId }
  | { type: "approvals_loaded"; approvals: Approval[] }
  | { type: "approval_pushed"; approval: Approval }
  | { type: "grants_loaded"; grants: Grant[] }
  | { type: "grant_upserted"; grant: Grant }
  | { type: "grant_deleted"; grantId: GrantId }
  | { type: "handoffs_loaded"; handoffs: Handoff[] }
  | { type: "handoff_pushed"; handoff: Handoff }
  | { type: "pending_counts_loaded"; bots: BotListItem[]; groups: GroupListItem[]; seq: Seq }
  | { type: "team_offer_sending"; messageId: MessageId }
  | { type: "team_offer_sent"; messageId: MessageId }
  | { type: "groups_loaded"; groups: GroupListItem[]; seq: Seq }
  | { type: "routines_loaded"; routines: Routine[]; seq: Seq }
  | { type: "routine_upserted"; routine: Routine; seq: Seq }
  | { type: "routine_removed"; routineId: RoutineId; seq: Seq }
  | { type: "skills_loaded"; botId: BotId; skills: Skill[]; seq: Seq }
  | { type: "skill_upserted"; skill: Skill; seq: Seq }
  | { type: "skill_removed"; botId: BotId; skillId: SkillId; seq: Seq }
  | { type: "preferences_loaded"; botId: BotId; preferences: Preference[]; seq: Seq }
  | { type: "preference_upserted"; preference: Preference; seq: Seq }
  | { type: "preference_removed"; botId: BotId; preferenceId: PreferenceId; seq: Seq }
  | { type: "brand_set"; brand: BrandBook | null }
  | { type: "tool_upserted"; tool: ToolConnection }
  | { type: "tool_removed"; toolId: ToolConnectionId }
  | { type: "settings_set"; settings: Settings }
  | { type: "usage_loaded"; usage: UsageResponse }
  | { type: "content_loaded"; drafts: Draft[]; plans: ContentPlan[]; seq: Seq }
  | { type: "accounts_loaded"; accounts: Account[]; computers: Computer[]; seq: Seq }
  | { type: "account_upserted"; account: Account; seq: Seq }
  | { type: "account_removed"; accountId: AccountId; seq: Seq }
  | { type: "login_opened"; accountId: AccountId; startedAt: Seq; attempt: LoginAttemptId }
  | { type: "login_flow"; accountId: AccountId; startedAt: Seq; flow: LoginFlow }
  | { type: "login_failed"; accountId: AccountId; attempt: LoginAttemptId; reason: LoginFailure }
  | {
      type: "logins_settled";
      before: Seq;
      computerId: ComputerId | null;
      flow: Extract<LoginFlow, { status: "offline" | "lapsed" }>;
    }
  | { type: "computers_loaded"; computers: Computer[]; seq: Seq }
  | { type: "computer_upserted"; computer: Computer; seq: Seq }
  | { type: "publications_loaded"; publications: Publication[] }
  | { type: "today_version_bumped" }
  | { type: "push_reconnected"; seq: Seq }
  | { type: "load_status"; key: LoadKey; status: LoadStatus }
  | { type: "from_session"; session: SessionId; action: Action };

export type ReadyState = Extract<AppState, { status: "ready" }>;
