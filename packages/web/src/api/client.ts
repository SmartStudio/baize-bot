import type { z } from "zod";
import {
  ApiError,
  BotListResponse,
  CreateBotResponse,
  DecideApprovalResponse,
  LoginResponse,
  MeResponse,
  MessageListResponse,
  SendMessageResponse,
  Settings,
  UpdateBotResponse,
  type Approval,
  type ApprovalId,
  type Bot,
  type BotHue,
  type BotId,
  type DecideApprovalRequest,
  type GroupId,
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

export const api = {
  login: async (email: string, password: string) =>
    json(LoginResponse, await send("POST", "/auth/login", { email, password })),
  logout: async () => {
    await send("POST", "/auth/logout");
  },
  me: async () => json(MeResponse, await send("GET", "/me")),
  bots: async () => json(BotListResponse, await send("GET", "/bots")),
  createBot: async (draft: Omit<BotDraft, "notify">) => json(CreateBotResponse, await send("POST", "/bots", draft)),
  updateBot: async (id: BotId, draft: BotDraft): Promise<Bot> =>
    (await json(UpdateBotResponse, await send("PATCH", `/bots/${encodeURIComponent(id)}`, draft))).bot,
  messages: async (groupId: GroupId) =>
    json(MessageListResponse, await send("GET", `/groups/${encodeURIComponent(groupId)}/messages`)),
  sendMessage: async (groupId: GroupId, text: string) =>
    json(SendMessageResponse, await send("POST", `/groups/${encodeURIComponent(groupId)}/messages`, { text })),
  decideApproval: async (id: ApprovalId, decision: DecideApprovalRequest["decision"]): Promise<Approval> =>
    (await json(DecideApprovalResponse, await send("POST", `/approvals/${encodeURIComponent(id)}`, { decision })))
      .approval,
  settings: async () => json(Settings, await send("GET", "/settings")),
  updateSettings: async (patch: Partial<Settings>) => json(Settings, await send("PATCH", "/settings", patch)),
};
