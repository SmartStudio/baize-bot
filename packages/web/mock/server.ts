import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { type ServerPush } from "@baize/shared";
import { accountRoutes } from "./routes/account.js";
import { authRoutes, authed } from "./routes/auth.js";
import { botRoutes } from "./routes/bots.js";
import { groupRoutes } from "./routes/groups.js";
import { send, type Push, type Route, type RouteContext } from "./routes/http.js";
import { hookRoutes, routineRoutes } from "./routes/routines.js";
import { skillRoutes } from "./routes/skills.js";
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

const publicRoutes: Route[] = [testRoutes, authRoutes, hookRoutes];
const protectedRoutes: Route[] = [
  accountRoutes,
  botRoutes,
  toolRoutes,
  routineRoutes,
  skillRoutes,
  todayRoutes,
  groupRoutes,
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

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/ws" || !authed(req)) {
    socket.destroy();
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
