import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  Bot,
  CreateBotRequest,
  LoginRequest,
  SendMessageRequest,
  Settings,
  UpdateBotRequest,
  UpdateSettingsRequest,
  type ServerPush,
} from "@baize/shared";
import {
  MOCK_EMAIL,
  MOCK_PASSWORD,
  appendMessage,
  botReplyFor,
  bots,
  botReplyDelayMs,
  createBot,
  groupIdByBotId,
  groups,
  lastMessageOf,
  reseed,
  messagesByGroupId,
  settings,
  user,
} from "./state.js";

const PORT = Number(process.env["API_PORT"] ?? 3001);
const SESSION_COOKIE = "baize_session";
const sessions = new Set<string>();
const sockets = new Set<WebSocket>();

// zod 的 .optional() 推出 `k?: T | undefined`，和 exactOptionalPropertyTypes 下的目标类型不兼容，展开前先去掉 undefined 的键。
const defined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

const readCookie = (req: IncomingMessage, name: string): string | null => {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
};

const authed = (req: IncomingMessage) => {
  const token = readCookie(req, SESSION_COOKIE);
  return token !== null && sessions.has(token);
};

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // 返回一个谁的 schema 都过不了的值，坏 JSON 就走各接口自己的 400，不用再多一条错误路径。
    return MALFORMED;
  }
};

const MALFORMED = Symbol("malformed json");

const push = (event: ServerPush) => {
  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
};

const botListItems = () =>
  [...bots.values()].map((bot) => {
    const groupId = groupIdByBotId.get(bot.id);
    if (groupId === undefined) throw new Error(`Bot ${bot.id} 没有群，mock 状态坏了`);
    return { bot, groupId, lastMessage: lastMessageOf(groupId), pendingApprovals: 0 };
  });

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/health") return send(res, 200, { ok: true });

  // 端到端每条用例开头把内存状态倒回预置的三个 Bot，用例之间就不会互相依赖跑的顺序。
  if (method === "POST" && path === "/api/test/reset") {
    reseed();
    return send(res, 204);
  }

  if (method === "POST" && path === "/api/auth/login") {
    const parsed = LoginRequest.safeParse(await readBody(req));
    if (!parsed.success) return send(res, 400, { error: "邮箱或密码格式不对" });
    if (parsed.data.email !== MOCK_EMAIL || parsed.data.password !== MOCK_PASSWORD) {
      return send(res, 401, { error: "邮箱或密码不对" });
    }
    const token = randomUUID();
    sessions.add(token);
    res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`);
    return send(res, 200, { user });
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) sessions.delete(token);
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return send(res, 204);
  }

  if (!authed(req)) return send(res, 401, { error: "没登录" });

  if (method === "GET" && path === "/api/me") return send(res, 200, { user });

  if (method === "GET" && path === "/api/bots") return send(res, 200, { items: botListItems() });

  if (method === "POST" && path === "/api/bots") {
    const parsed = CreateBotRequest.safeParse(await readBody(req));
    if (!parsed.success) return send(res, 400, { error: "Bot 字段不对" });
    const created = createBot(parsed.data);
    return send(res, 200, created);
  }

  const botMatch = /^\/api\/bots\/([^/]+)$/.exec(path);
  if (botMatch) {
    const [, rawBotId] = botMatch;
    if (rawBotId === undefined) return send(res, 404, { error: "没有这个 Bot" });
    const botId = decodeURIComponent(rawBotId);
    const bot = bots.get(botId);
    if (!bot) return send(res, 404, { error: "没有这个 Bot" });
    if (method === "PATCH") {
      const parsed = UpdateBotRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "Bot 字段不对" });
      const next = Bot.parse({ ...bot, ...defined(parsed.data) });
      bots.set(botId, next);
      push({ type: "bot_updated", bot: next });
      return send(res, 200, { bot: next });
    }
    if (method === "DELETE") {
      bots.delete(botId);
      const groupId = groupIdByBotId.get(botId);
      if (groupId) {
        groups.delete(groupId);
        messagesByGroupId.delete(groupId);
        groupIdByBotId.delete(botId);
      }
      push({ type: "bot_deleted", botId: bot.id });
      return send(res, 204);
    }
  }

  const messagesMatch = /^\/api\/groups\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch) {
    const [, rawGroupId] = messagesMatch;
    if (rawGroupId === undefined) return send(res, 404, { error: "没有这个群" });
    const groupId = decodeURIComponent(rawGroupId);
    if (!groups.has(groupId)) return send(res, 404, { error: "没有这个群" });
    if (method === "GET") {
      const all = messagesByGroupId.get(groupId) ?? [];
      const before = url.searchParams.get("before");
      const end = before === null ? all.length : all.findIndex((m) => m.id === before);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const start = Math.max(0, (end < 0 ? all.length : end) - limit);
      return send(res, 200, { messages: all.slice(start, end < 0 ? all.length : end), hasMore: start > 0 });
    }
    if (method === "POST") {
      const parsed = SendMessageRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "消息不能为空" });
      const message = appendMessage(groupId, { kind: "user", text: parsed.data.text });
      const botId = groups.get(groupId)?.botIds[0];
      if (botId) {
        setTimeout(() => {
          for (const body of botReplyFor(botId, parsed.data.text)) {
            push({ type: "message", message: appendMessage(groupId, body) });
          }
        }, botReplyDelayMs);
      }
      return send(res, 200, { message });
    }
  }

  if (path === "/api/settings") {
    if (method === "GET") return send(res, 200, settings.current);
    if (method === "PATCH") {
      const parsed = UpdateSettingsRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "设置字段不对" });
      settings.current = Settings.parse({ ...settings.current, ...defined(parsed.data) });
      return send(res, 200, settings.current);
    }
  }

  return send(res, 404, { error: `没有这个接口 ${method} ${path}` });
};

const server = createServer((req, res) => {
  handle(req, res).catch((cause: unknown) => {
    if (!res.headersSent) send(res, 500, { error: String(cause) });
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/ws" || !authed(req)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`mock control plane on http://127.0.0.1:${PORT}\n`);
});
