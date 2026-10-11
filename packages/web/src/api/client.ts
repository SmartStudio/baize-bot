import type { z } from "zod";
import {
  AccountListResponse,
  AccountResponse,
  LoginAccountResponse,
  type LoginAccountRequest,
  type LoginAttemptId,
  ApiError,
  ApprovePlanResponse,
  ComputerListResponse,
  ComputerTokenResponse,
  DecideDraftResponse,
  ReturnPlanResponse,
  BotResponse,
  BotListResponse,
  BotProfileResponse,
  BotTemplate,
  BrandResponse,
  CreateBotResponse,
  ToolListResponse,
  ToolResponse,
  DecideApprovalResponse,
  DecideProjectOfferResponse,
  DecideRoutineOfferResponse,
  DecideSkillOfferResponse,
  DecideTeamOfferResponse,
  GroupListResponse,
  GrantListResponse,
  LoginResponse,
  MeResponse,
  MessageListResponse,
  PokerTableResponse,
  PreferenceListResponse,
  PreferenceResponse,
  MessageResponse,
  RegisterResponse,
  RoutineListResponse,
  RoutineResponse,
  SendMessageResponse,
  Settings,
  SkillListResponse,
  SkillResponse,
  ProjectResponse,
  TodayResponse,
  UpdateBotResponse,
  UpdateTaskResponse,
  UsageResponse,
  type AccountId,
  type ApprovePlanRequest,
  type DecideDraftRequest,
  type UpdateAccountRequest,
  type CreateAccountRequest,
  type ApprovalId,
  type ContentPlanId,
  type DraftId,
  type Bot,
  type BotHue,
  type BotId,
  type BrandBook,
  type ExportTemplateRequest,
  type ChecklistItem,
  type ProjectGoal,
  type CreateRoutineRequest,
  type CreateToolRequest,
  type CreateSkillRequest,
  type DeleteAccountRequest,
  type DecideApprovalRequest,
  type DecideProjectOfferRequest,
  type DecideRoutineOfferRequest,
  type DecideSkillOfferRequest,
  type DecideTeamOfferRequest,
  type GroupId,
  type GrantId,
  type MessageId,
  type OAuthPlatform,
  type CreatePokerTableRequest,
  type HintRequest,
  type PokerActRequest,
  type PokerHandId,
  type PokerSeatNo,
  type PokerTableView,
  type RetryReviewRequest,
  type SwapSeatRequest,
  type Preference,
  type PreferenceId,
  type Routine,
  type RoutineId,
  type Skill,
  type SkillId,
  type TaskId,
  type ToolConnection,
  type ToolConnectionId,
  type TopicTask,
  type UpdateToolRequest,
  type UpdateBrandRequest,
  type UpdateRoutineRequest,
  type UpdateSkillRequest,
} from "@baize/shared";

// 授权要整页跳去平台再跳回来，fetch 跟不了，给的是地址，界面拿它当链接。
export const oauthStartUrl = (platform: OAuthPlatform): string => `/api/oauth/${encodeURIComponent(platform)}/start`;

// 导出是一个带 content-disposition 的附件，交给浏览器自己下载，界面拿它当链接。
export const exportDataUrl = "/api/export";

export class RequestFailed extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestFailed";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const messageFor = async (res: Response): Promise<string> => {
  const body: unknown = await res.json().catch(() => null);
  const parsed = ApiError.safeParse(body);
  return parsed.success ? parsed.data.error : `请求失败（${res.status}）`;
};

const sendWith = async (
  signal: AbortSignal | undefined,
  method: Method,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (signal !== undefined) init.signal = signal;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) throw new RequestFailed(res.status, await messageFor(res));
  return res;
};

const json = async <S extends z.ZodTypeAny>(schema: S, res: Response): Promise<z.output<S>> => {
  const parsed: unknown = schema.parse(await res.json());
  return parsed as z.output<S>;
};

export type BotDraft = {
  name?: string;
  tags?: string[];
  description?: string;
  hue?: BotHue;
  notify?: boolean;
};

// 带 signal 的一份给一次登录会话用，登出时整批取消。
export const createApi = (signal?: AbortSignal) => {
  const send = (method: Method, path: string, body?: unknown) => sendWith(signal, method, path, body);
  return {
    login: async (email: string, password: string) =>
      json(LoginResponse, await send("POST", "/auth/login", { email, password })),
    register: async (email: string, password: string, name: string) =>
      json(RegisterResponse, await send("POST", "/register", { email, password, name })),
    logout: async () => {
      await send("POST", "/auth/logout");
    },
    me: async () => json(MeResponse, await send("GET", "/me")),
    today: async () => json(TodayResponse, await send("GET", "/today")),
    project: async (groupId: GroupId) =>
      json(ProjectResponse, await send("GET", `/projects/${encodeURIComponent(groupId)}`)),
    usage: async () => json(UsageResponse, await send("GET", "/usage")),
    bots: async () => json(BotListResponse, await send("GET", "/bots")),
    createBot: async (draft: Omit<BotDraft, "notify">) => json(CreateBotResponse, await send("POST", "/bots", draft)),
    updateBot: async (id: BotId, draft: BotDraft): Promise<Bot> =>
      (await json(UpdateBotResponse, await send("PATCH", `/bots/${encodeURIComponent(id)}`, draft))).bot,
    // 任务卡补读带 for=task，服务端不看它，只让名单快照、补计数、补读三类请求在网络层分得开。
    groups: async (purpose?: "task") =>
      json(GroupListResponse, await send("GET", purpose === undefined ? "/groups" : `/groups?for=${purpose}`)),
    tools: async () => json(ToolListResponse, await send("GET", "/tools")),
    createTool: async (draft: CreateToolRequest): Promise<ToolConnection> =>
      (await json(ToolResponse, await send("POST", "/tools", draft))).tool,
    updateTool: async (id: ToolConnectionId, patch: UpdateToolRequest): Promise<ToolConnection> =>
      (await json(ToolResponse, await send("PATCH", `/tools/${encodeURIComponent(id)}`, patch))).tool,
    deleteTool: async (id: ToolConnectionId): Promise<void> => {
      await send("DELETE", `/tools/${encodeURIComponent(id)}`);
    },
    updateTask: async (
      id: TaskId,
      patch: { checklist: ChecklistItem[] } | { goal: ProjectGoal | null },
    ): Promise<TopicTask> =>
      (await json(UpdateTaskResponse, await send("PATCH", `/tasks/${encodeURIComponent(id)}`, patch))).task,
    messages: async (groupId: GroupId) =>
      json(MessageListResponse, await send("GET", `/groups/${encodeURIComponent(groupId)}/messages`)),
    message: async (id: MessageId) =>
      (await json(MessageResponse, await send("GET", `/messages/${encodeURIComponent(id)}`))).message,
    sendMessage: async (groupId: GroupId, text: string) =>
      json(SendMessageResponse, await send("POST", `/groups/${encodeURIComponent(groupId)}/messages`, { text })),
    decideApproval: async (id: ApprovalId, request: DecideApprovalRequest) =>
      json(DecideApprovalResponse, await send("POST", `/approvals/${encodeURIComponent(id)}`, request)),
    decideDraft: async (id: DraftId, request: DecideDraftRequest) =>
      json(DecideDraftResponse, await send("POST", `/drafts/${encodeURIComponent(id)}`, request)),
    approvePlan: async (id: ContentPlanId, request: ApprovePlanRequest) =>
      json(ApprovePlanResponse, await send("POST", `/plans/${encodeURIComponent(id)}/approve`, request)),
    returnPlan: async (id: ContentPlanId) =>
      json(ReturnPlanResponse, await send("POST", `/plans/${encodeURIComponent(id)}/return`)),
    accounts: async () => json(AccountListResponse, await send("GET", "/accounts")),
    updateAccount: async (id: AccountId, request: UpdateAccountRequest) =>
      json(AccountResponse, await send("PATCH", `/accounts/${encodeURIComponent(id)}`, request)),
    createAccount: async (request: CreateAccountRequest) =>
      json(AccountResponse, await send("POST", "/accounts", request)),
    loginAccount: async (id: AccountId, attempt: LoginAttemptId) => {
      const body: LoginAccountRequest = { attempt };
      return json(LoginAccountResponse, await send("POST", `/accounts/${encodeURIComponent(id)}/login`, body));
    },
    computers: async () => json(ComputerListResponse, await send("GET", "/computers")),
    createRemoteComputer: async () => json(ComputerTokenResponse, await send("POST", "/computers/remote")),
    deleteAccount: async (email: string) => {
      const body: DeleteAccountRequest = { email };
      await send("DELETE", "/me", body);
    },
    grants: async () => json(GrantListResponse, await send("GET", "/grants")),
    deleteGrant: async (id: GrantId): Promise<void> => {
      await send("DELETE", `/grants/${encodeURIComponent(id)}`);
    },
    pauseBot: async (id: BotId): Promise<Bot> =>
      (await json(BotResponse, await send("POST", `/bots/${encodeURIComponent(id)}/pause`))).bot,
    resumeBot: async (id: BotId): Promise<Bot> =>
      (await json(BotResponse, await send("POST", `/bots/${encodeURIComponent(id)}/resume`))).bot,
    routines: async () => json(RoutineListResponse, await send("GET", "/routines")),
    createRoutine: async (botId: BotId, body: CreateRoutineRequest): Promise<Routine> =>
      (await json(RoutineResponse, await send("POST", `/bots/${encodeURIComponent(botId)}/routines`, body))).routine,
    updateRoutine: async (id: RoutineId, patch: UpdateRoutineRequest): Promise<Routine> =>
      (await json(RoutineResponse, await send("PATCH", `/routines/${encodeURIComponent(id)}`, patch))).routine,
    deleteRoutine: async (id: RoutineId) => {
      await send("DELETE", `/routines/${encodeURIComponent(id)}`);
    },
    runRoutine: async (id: RoutineId): Promise<Routine> =>
      (await json(RoutineResponse, await send("POST", `/routines/${encodeURIComponent(id)}/run`))).routine,
    skills: async (botId: BotId) =>
      json(SkillListResponse, await send("GET", `/bots/${encodeURIComponent(botId)}/skills`)),
    createSkill: async (botId: BotId, body: CreateSkillRequest): Promise<Skill> =>
      (await json(SkillResponse, await send("POST", `/bots/${encodeURIComponent(botId)}/skills`, body))).skill,
    updateSkill: async (id: SkillId, patch: UpdateSkillRequest): Promise<Skill> =>
      (await json(SkillResponse, await send("PATCH", `/skills/${encodeURIComponent(id)}`, patch))).skill,
    deleteSkill: async (id: SkillId) => {
      await send("DELETE", `/skills/${encodeURIComponent(id)}`);
    },
    copySkill: async (id: SkillId, botId: BotId): Promise<Skill> =>
      (await json(SkillResponse, await send("POST", `/skills/${encodeURIComponent(id)}/copy`, { botId }))).skill,
    decideSkillOffer: async (messageId: MessageId, decision: DecideSkillOfferRequest["decision"]) =>
      json(
        DecideSkillOfferResponse,
        await send("POST", `/messages/${encodeURIComponent(messageId)}/skill-offer`, { decision }),
      ),
    decideProjectOffer: async (messageId: MessageId, request: DecideProjectOfferRequest) =>
      json(
        DecideProjectOfferResponse,
        await send("POST", `/messages/${encodeURIComponent(messageId)}/project-offer`, request),
      ),
    decideTeamOffer: async (messageId: MessageId, request: DecideTeamOfferRequest) =>
      json(
        DecideTeamOfferResponse,
        await send("POST", `/messages/${encodeURIComponent(messageId)}/team-offer`, request),
      ),
    decideRoutineOffer: async (messageId: MessageId, decision: DecideRoutineOfferRequest["decision"]) =>
      json(
        DecideRoutineOfferResponse,
        await send("POST", `/messages/${encodeURIComponent(messageId)}/routine-offer`, { decision }),
      ),
    reportMetric: async (groupId: GroupId, value: number): Promise<TopicTask> =>
      (await json(UpdateTaskResponse, await send("POST", `/projects/${encodeURIComponent(groupId)}/metric`, { value })))
        .task,
    markSeen: async (groupId: GroupId) => {
      await send("POST", `/groups/${encodeURIComponent(groupId)}/seen`);
    },
    preferences: async (botId: BotId): Promise<Preference[]> =>
      (await json(PreferenceListResponse, await send("GET", `/bots/${encodeURIComponent(botId)}/preferences`))).items,
    updatePreference: async (id: PreferenceId, isPrivate: boolean): Promise<Preference> =>
      (
        await json(
          PreferenceResponse,
          await send("PATCH", `/preferences/${encodeURIComponent(id)}`, { private: isPrivate }),
        )
      ).preference,
    deletePreference: async (id: PreferenceId) => {
      await send("DELETE", `/preferences/${encodeURIComponent(id)}`);
    },
    botProfile: async (botId: BotId) =>
      json(BotProfileResponse, await send("GET", `/bots/${encodeURIComponent(botId)}/profile`)),
    exportTemplate: async (botId: BotId, choice: ExportTemplateRequest): Promise<BotTemplate> =>
      json(BotTemplate, await send("POST", `/bots/${encodeURIComponent(botId)}/template`, choice)),
    importTemplate: async (template: BotTemplate) =>
      json(CreateBotResponse, await send("POST", "/bots/import", { template })),
    brand: async (): Promise<BrandBook | null> => (await json(BrandResponse, await send("GET", "/brand"))).brand,
    updateBrand: async (body: UpdateBrandRequest): Promise<BrandBook | null> =>
      (await json(BrandResponse, await send("PUT", "/brand", body))).brand,
    // 牌局接口按 shared/poker.ts 的契约，每个都回整份牌桌视图。S3 里控制面和 mock 都还回 501。
    createPokerTable: async (request: CreatePokerTableRequest): Promise<PokerTableView> =>
      (await json(PokerTableResponse, await send("POST", "/poker/tables", request))).table,
    pokerTable: async (groupId: GroupId): Promise<PokerTableView> =>
      (await json(PokerTableResponse, await send("GET", `/poker/tables/${encodeURIComponent(groupId)}`))).table,
    startHand: async (groupId: GroupId): Promise<PokerTableView> =>
      (await json(PokerTableResponse, await send("POST", `/poker/tables/${encodeURIComponent(groupId)}/hands`, {})))
        .table,
    pokerAct: async (handId: PokerHandId, request: PokerActRequest): Promise<PokerTableView> =>
      (await json(PokerTableResponse, await send("POST", `/poker/hands/${encodeURIComponent(handId)}/act`, request)))
        .table,
    askHint: async (handId: PokerHandId, request: HintRequest): Promise<PokerTableView> =>
      (await json(PokerTableResponse, await send("POST", `/poker/hands/${encodeURIComponent(handId)}/hint`, request)))
        .table,
    swapSeat: async (groupId: GroupId, seat: PokerSeatNo, request: SwapSeatRequest): Promise<PokerTableView> =>
      (
        await json(
          PokerTableResponse,
          await send("POST", `/poker/tables/${encodeURIComponent(groupId)}/seats/${seat}`, request),
        )
      ).table,
    leaveTable: async (groupId: GroupId): Promise<PokerTableView> =>
      (await json(PokerTableResponse, await send("POST", `/poker/tables/${encodeURIComponent(groupId)}/leave`, {})))
        .table,
    retryPokerReview: async (groupId: GroupId, request: RetryReviewRequest): Promise<PokerTableView> =>
      (
        await json(
          PokerTableResponse,
          await send("POST", `/poker/tables/${encodeURIComponent(groupId)}/review`, request),
        )
      ).table,
    settings: async () => json(Settings, await send("GET", "/settings")),
    updateSettings: async (patch: Partial<Settings>) => json(Settings, await send("PATCH", "/settings", patch)),
  };
};

export type Api = ReturnType<typeof createApi>;

export const api = createApi();
