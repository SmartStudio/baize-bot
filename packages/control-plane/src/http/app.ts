import {
  BotId,
  BotListResponse,
  CreateBotRequest,
  CreateBotResponse,
  GroupId,
  LoginRequest,
  LoginResponse,
  MeResponse,
  MessageId,
  MessageListResponse,
  SendMessageRequest,
  SendMessageResponse,
  UpdateBotRequest,
  UpdateBotResponse,
  UpdateSettingsRequest,
  type Settings,
  type User,
} from "@baize/shared";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { createBot, deleteBot, listBots, updateBot } from "../repo/bots.js";
import {
  DEFAULT_MESSAGE_LIMIT,
  appendUserMessage,
  findGroupId,
  listMessages,
} from "../repo/messages.js";
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, deleteSession, userForSession } from "../repo/sessions.js";
import { getSettings, updateSettings } from "../repo/settings.js";
import { authenticate } from "../repo/users.js";
import type { PushHub } from "../ws/hub.js";

export type AppDeps = { readonly db: Db; readonly hub: PushHub; readonly secureCookie: boolean };

type Env = { Variables: { user: User } };

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);

const NOT_FOUND = { error: "没有这个对象" } as const;
const UNAUTHORIZED = { error: "请先登录" } as const;

export function createApp(deps: AppDeps): Hono<Env> {
  const { db, hub } = deps;
  const app = new Hono<Env>();

  app.use("/api/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const token = getCookie(c, SESSION_COOKIE);
    const user = token === undefined ? null : await userForSession(db, token);
    if (user === null) return c.json(UNAUTHORIZED, 401);
    c.set("user", user);
    await next();
  });

  app.post("/api/auth/login", async (c) => {
    const body = await readJson(c.req.raw, LoginRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const user = await authenticate(db, body.value.email, body.value.password);
    if (user === null) return c.json({ error: "邮箱或密码不对" }, 401);
    const token = await createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: deps.secureCookie,
    });
    return c.json(LoginResponse.parse({ user }));
  });

  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) await deleteSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.get("/api/me", (c) => c.json(MeResponse.parse({ user: c.get("user") })));

  app.get("/api/bots", async (c) => {
    const items = await listBots(db, c.get("user").id);
    return c.json(BotListResponse.parse({ items }));
  });

  app.post("/api/bots", async (c) => {
    const body = await readJson(c.req.raw, CreateBotRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const created = await createBot(db, c.get("user").id, body.value);
    return c.json(CreateBotResponse.parse(created), 201);
  });

  app.patch("/api/bots/:id", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, UpdateBotRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const bot = await updateBot(db, c.get("user").id, botId.data, body.value);
    if (bot === null) return c.json(NOT_FOUND, 404);
    hub.push(c.get("user").id, { type: "bot_updated", bot });
    return c.json(UpdateBotResponse.parse({ bot }));
  });

  app.delete("/api/bots/:id", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    const deleted = await deleteBot(db, c.get("user").id, botId.data);
    if (!deleted) return c.json(NOT_FOUND, 404);
    hub.push(c.get("user").id, { type: "bot_deleted", botId: botId.data });
    return c.body(null, 204);
  });

  app.get("/api/groups/:id/messages", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("id"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const owned = await findGroupId(db, c.get("user").id, groupId.data);
    if (owned === null) return c.json(NOT_FOUND, 404);

    const query = MessageQuery.safeParse({
      before: c.req.query("before"),
      limit: c.req.query("limit"),
    });
    if (!query.success) return c.json({ error: "查询参数不合法" }, 400);

    const result = await listMessages(db, owned, {
      before: query.data.before,
      limit: query.data.limit,
    });
    if (result.kind === "unknown_cursor") return c.json(NOT_FOUND, 404);
    return c.json(MessageListResponse.parse(result.page));
  });

  app.post("/api/groups/:id/messages", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("id"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const owned = await findGroupId(db, c.get("user").id, groupId.data);
    if (owned === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, SendMessageRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);

    const message = await appendUserMessage(db, owned, body.value.text);
    hub.push(c.get("user").id, { type: "message", message });
    return c.json(SendMessageResponse.parse({ message }), 201);
  });

  app.get("/api/settings", async (c) => {
    const settings = await getSettings(db, c.get("user").id);
    return c.json(settings satisfies Settings);
  });

  app.patch("/api/settings", async (c) => {
    const body = await readJson(c.req.raw, UpdateSettingsRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const settings = await updateSettings(db, c.get("user").id, body.value);
    return c.json(settings satisfies Settings);
  });

  app.notFound((c) => c.json(NOT_FOUND, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "服务端出错" }, 500);
  });

  return app;
}

const MessageQuery = z.object({
  before: MessageId.optional(),
  limit: z.coerce.number().int().positive().optional(),
});

type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<ReadResult<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "请求体不是合法 JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "请求体不合法" };
  return { ok: true, value: parsed.data };
}
