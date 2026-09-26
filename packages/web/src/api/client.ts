import type { z } from "zod";
import {
  ApiError,
  BotResponse,
  BotListResponse,
  CreateBotResponse,
  CreateGroupResponse,
  ToolListResponse,
  ToolResponse,
  DecideApprovalResponse,
  DecideSkillOfferResponse,
  GroupListResponse,
  GrantListResponse,
  LoginResponse,
  MeResponse,
  MessageListResponse,
  RegisterResponse,
  RoutineListResponse,
  RoutineResponse,
  SendMessageResponse,
  Settings,
  SkillListResponse,
  SkillResponse,
  TodayResponse,
  UpdateBotResponse,
  UpdateTaskResponse,
  UsageResponse,
  type ApprovalId,
  type Bot,
  type BotHue,
  type BotId,
  type ChecklistItem,
  type CreateRoutineRequest,
  type CreateToolRequest,
  type CreateSkillRequest,
  type DecideApprovalRequest,
  type DecideSkillOfferRequest,
  type GroupId,
  type GrantId,
  type MessageId,
  type Routine,
  type RoutineId,
  type Skill,
  type SkillId,
  type TaskId,
  type ToolConnection,
  type ToolConnectionId,
  type TopicTask,
  type UpdateToolRequest,
  type UpdateRoutineRequest,
  type UpdateSkillRequest,
} from "@baize/shared";

export class RequestFailed extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestFailed";
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

const messageFor = async (res: Response): Promise<string> => {
  const body: unknown = await res.json().catch(() => null);
  const parsed = ApiError.safeParse(body);
  return parsed.success ? parsed.data.error : `请求失败（${res.status}）`;
};

const send = async (method: Method, path: string, body?: unknown): Promise<Response> => {
  const init: RequestInit = { method, credentials: "same-origin" };
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
  tag?: string;
  description?: string;
  hue?: BotHue;
  notify?: boolean;
};

// 建群表单交出来的那一份。截止可空，而「没填」和「填了空」在这里是同一件事，所以只有 null 没有 undefined。
export type GroupDraft = { title: string; botIds: BotId[]; summary: string; dueAt: string | null };

export const api = {
  login: async (email: string, password: string) =>
    json(LoginResponse, await send("POST", "/auth/login", { email, password })),
  register: async (email: string, password: string, name: string) =>
    json(RegisterResponse, await send("POST", "/register", { email, password, name })),
  logout: async () => {
    await send("POST", "/auth/logout");
  },
  me: async () => json(MeResponse, await send("GET", "/me")),
  today: async () => json(TodayResponse, await send("GET", "/today")),
  usage: async () => json(UsageResponse, await send("GET", "/usage")),
  bots: async () => json(BotListResponse, await send("GET", "/bots")),
  createBot: async (draft: Omit<BotDraft, "notify">) => json(CreateBotResponse, await send("POST", "/bots", draft)),
  updateBot: async (id: BotId, draft: BotDraft): Promise<Bot> =>
    (await json(UpdateBotResponse, await send("PATCH", `/bots/${encodeURIComponent(id)}`, draft))).bot,
  groups: async () => json(GroupListResponse, await send("GET", "/groups")),
  createGroup: async (draft: GroupDraft) => json(CreateGroupResponse, await send("POST", "/groups", draft)),
  tools: async () => json(ToolListResponse, await send("GET", "/tools")),
  createTool: async (draft: CreateToolRequest): Promise<ToolConnection> =>
    (await json(ToolResponse, await send("POST", "/tools", draft))).tool,
  updateTool: async (id: ToolConnectionId, patch: UpdateToolRequest): Promise<ToolConnection> =>
    (await json(ToolResponse, await send("PATCH", `/tools/${encodeURIComponent(id)}`, patch))).tool,
  deleteTool: async (id: ToolConnectionId): Promise<void> => {
    await send("DELETE", `/tools/${encodeURIComponent(id)}`);
  },
  updateTask: async (id: TaskId, patch: { checklist: ChecklistItem[] }): Promise<TopicTask> =>
    (await json(UpdateTaskResponse, await send("PATCH", `/tasks/${encodeURIComponent(id)}`, patch))).task,
  messages: async (groupId: GroupId) =>
    json(MessageListResponse, await send("GET", `/groups/${encodeURIComponent(groupId)}/messages`)),
  sendMessage: async (groupId: GroupId, text: string) =>
    json(SendMessageResponse, await send("POST", `/groups/${encodeURIComponent(groupId)}/messages`, { text })),
  decideApproval: async (id: ApprovalId, request: DecideApprovalRequest) =>
    json(DecideApprovalResponse, await send("POST", `/approvals/${encodeURIComponent(id)}`, request)),
  grants: async () => json(GrantListResponse, await send("GET", "/grants")),
  deleteGrant: async (id: GrantId): Promise<void> => {
    await send("DELETE", `/grants/${encodeURIComponent(id)}`);
  },
  pauseBot: async (id: BotId): Promise<Bot> =>
    (await json(BotResponse, await send("POST", `/bots/${encodeURIComponent(id)}/pause`))).bot,
  resumeBot: async (id: BotId): Promise<Bot> =>
    (await json(BotResponse, await send("POST", `/bots/${encodeURIComponent(id)}/resume`))).bot,
  routines: async (botId: BotId) =>
    json(RoutineListResponse, await send("GET", `/bots/${encodeURIComponent(botId)}/routines`)),
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
  settings: async () => json(Settings, await send("GET", "/settings")),
  updateSettings: async (patch: Partial<Settings>) => json(Settings, await send("PATCH", "/settings", patch)),
};
