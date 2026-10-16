import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { type ServerPush } from "@baize/shared";
import { accountRoutes } from "./routes/account.js";
import { authRoutes, authed, expireSessions } from "./routes/auth.js";
import { botRoutes } from "./routes/bots.js";
import { brandRoutes } from "./routes/brand.js";
import { computerChoiceRoutes } from "./routes/computer-choices.js";
import { contentRoutes } from "./routes/content.js";
import { goalRoutes } from "./routes/goals.js";
import { groupRoutes } from "./routes/groups.js";
import { grantRoutes } from "./routes/grants.js";
import { attachLiveViewer, liveRoutes, liveTestRoutes } from "./routes/live.js";
import { pokerRoutes } from "./routes/poker.js";
import { preferenceRoutes } from "./routes/preferences.js";
import { routineOfferRoutes } from "./routes/routine-offers.js";
import { send, type Push, type Route, type RouteContext } from "./routes/http.js";
import { projectRoutes } from "./routes/projects.js";
import { hookRoutes, routineRoutes } from "./routes/routines.js";
import { skillRoutes } from "./routes/skills.js";
import { teamOfferRoutes } from "./routes/team-offers.js";
import { templateRoutes } from "./routes/templates.js";
import { currentTurns, testRoutes } from "./routes/test.js";
import { todayRoutes } from "./routes/today.js";
import { toolRoutes } from "./routes/tools.js";

const PORT = Number(process.env["API_PORT"] ?? 3001);
const sockets = new Set<WebSocket>();

const push: Push = (event: ServerPush) => {
  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
};

// 断线和登录过期只能从服务端这头造：一个把现有推送连接全掐掉，一个先让全部登录作废再掐。
const socketRoutes: Route = async ({ res, path, method }) => {
  if (method !== "POST") return false;
  if (path === "/api/test/sessions/expire") expireSessions();
  else if (path !== "/api/test/sockets/drop") return false;
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  send(res, 204);
  return true;
};

const publicRoutes: Route[] = [socketRoutes, liveTestRoutes, testRoutes, authRoutes, hookRoutes];
const protectedRoutes: Route[] = [
  // 第 2 期的接缝路由排在前面，免得被同前缀的老路由先截住。第 3 期的牌局路由同理。
  pokerRoutes,
  computerChoiceRoutes,
  goalRoutes,
  preferenceRoutes,
  brandRoutes,
  teamOfferRoutes,
  routineOfferRoutes,
  templateRoutes,
  accountRoutes,
  botRoutes,
  toolRoutes,
  routineRoutes,
  skillRoutes,
  projectRoutes,
  todayRoutes,
  contentRoutes,
  groupRoutes,
  grantRoutes,
  liveRoutes,
];

const handle = async (context: RouteContext): Promise<void> => {
  for (const route of publicRoutes) {
    if (await route(context)) return;
  }
  if (!authed(context.req)) return send(context.res, 401, { error: "没登录" });
  for (const route of protectedRoutes) {
    if (await route(context)) return;
  }
  send(context.res, 404, { error: `没有这个接口 ${context.method} ${context.path}` });
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  handle({ req, res, url, path: url.pathname, method: req.method ?? "GET", push }).catch((cause: unknown) => {
    if (!res.headersSent) send(res, 500, { error: String(cause) });
  });
});

const wss = new WebSocketServer({ noServer: true });

// 看画面的 socket 和推送一样靠 cookie 认人，路径上带 liveId。
const LIVE_PATH = /^\/api\/live\/([^/]+)$/;

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const live = LIVE_PATH.exec(url.pathname);
  if ((url.pathname !== "/api/ws" && live === null) || !authed(req)) {
    socket.destroy();
    return;
  }
  if (live !== null) {
    wss.handleUpgrade(req, socket, head, (ws) => attachLiveViewer(ws, live[1] ?? "", push));
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    for (const turn of currentTurns()) ws.send(JSON.stringify(turn));
    ws.on("close", () => sockets.delete(ws));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`mock control plane on http://127.0.0.1:${PORT}\n`);
});
