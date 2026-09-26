import { randomUUID } from "node:crypto";
import { type IncomingMessage } from "node:http";
import { LoginRequest, RegisterRequest, RegisterResponse, User } from "@baize/shared";
import { MOCK_EMAIL, MOCK_PASSWORD, user } from "../state.js";
import { readBody, send, type Route } from "./http.js";

const SESSION_COOKIE = "baize_session";
const sessions = new Set<string>();
const registeredEmails = new Set<string>([MOCK_EMAIL]);

const readCookie = (req: IncomingMessage, name: string): string | null => {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
};

export const authed = (req: IncomingMessage): boolean => {
  const token = readCookie(req, SESSION_COOKIE);
  return token !== null && sessions.has(token);
};

export const expireSessions = (): void => {
  sessions.clear();
};

export const resetRegisteredEmails = (): void => {
  registeredEmails.clear();
  registeredEmails.add(MOCK_EMAIL);
};

export const authRoutes: Route = async ({ req, res, path, method }) => {
  if (method === "POST" && path === "/api/auth/login") {
    const parsed = LoginRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "邮箱或密码格式不对" });
    else if (parsed.data.email !== MOCK_EMAIL || parsed.data.password !== MOCK_PASSWORD) {
      send(res, 401, { error: "邮箱或密码不对" });
    } else {
      const token = randomUUID();
      sessions.add(token);
      res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`);
      send(res, 200, { user });
    }
    return true;
  }

  if (method === "POST" && path === "/api/register") {
    const parsed = RegisterRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "注册信息格式不对" });
    else if (registeredEmails.has(parsed.data.email)) send(res, 409, { error: "这个邮箱已经注册过了" });
    else {
      registeredEmails.add(parsed.data.email);
      const registeredUser = User.parse({
        id: `usr_${randomUUID()}`,
        name: parsed.data.name,
        email: parsed.data.email,
        createdAt: new Date().toISOString(),
      });
      const token = randomUUID();
      sessions.add(token);
      res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`);
      send(res, 201, RegisterResponse.parse({ user: registeredUser }));
    }
    return true;
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) sessions.delete(token);
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    send(res, 204);
    return true;
  }

  return false;
};
