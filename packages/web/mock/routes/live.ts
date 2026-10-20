import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  BotId,
  ComputerId,
  GroupId,
  LiveFromViewer,
  LiveId,
  LiveSession,
  LiveViewerClose,
  OpenTerminalResponse,
  RunId,
  decodeLive,
  encodeLive,
  type Account,
  BrowserPlatform,
  type LiveUserEnd,
  type MessageBody,
  type MessageId,
} from "@baize/shared";
import { z } from "zod";
import { LIVE_FRAME_JPEG } from "../state/live-frame.js";
import { computersOf } from "../state/content.js";
import { appendMessage, rewriteMessage } from "../state/messages.js";
import { readBody, send, type Push, type Route } from "./http.js";

// 画面面：照控制面中继的行为造。会话本来住在电脑内存里，这里住在 mock 内存里；一台电脑同一时刻只有一个观看者，
// 后来的把先来的以 4101 顶掉；观看者发 end 就当电脑收起了这一页，推 live_closed，再以 4100 关。

type Received = { liveId: LiveId; message: LiveFromViewer };

const sessions = new Map<LiveId, LiveSession>();
const viewers = new Map<ComputerId, { liveId: LiveId; socket: WebSocket }>();
// 测试端点读它对坐标和文字。只在 mock 里记，真中继不留用户按键。
const received: Received[] = [];
// 默认关：老的登录用例点了登录只等结果，不该凭空多出一块面板。
let screenOn = false;
type ToolCall = Extract<MessageBody, { kind: "tool_call" }>;
// 接手会话对应的那张工具调用卡。真栈上卡的终态由运行器回报，这里由 mock 在收到 end 时替它改。
// hold 的卡收到 end 只关画面，用户怎么结的记在 held 里，等测试点 settle 再改卡，好看清两步之间卡上写什么。
const takeoverCards = new Map<LiveId, { groupId: GroupId; messageId: MessageId; body: ToolCall; hold: boolean }>();
const held = new Map<LiveId, LiveUserEnd>();
// 假终端：每个会话一份回滚缓冲，收到的字原样回显进去，观看者每次连上整份补发，和电脑代理的终端一个样。
const terminals = new Map<LiveId, string>();
const textEncoder = new TextEncoder();
// 下一次开终端电脑拒开：不报会话，直接 closed，控制面替它推 live_closed。
let refuseTerminal = false;

export const resetLive = (): void => {
  for (const { socket } of viewers.values()) socket.close(LiveViewerClose.gone);
  viewers.clear();
  sessions.clear();
  takeoverCards.clear();
  held.clear();
  terminals.clear();
  received.length = 0;
  screenOn = false;
  refuseTerminal = false;
};

const closeSession = (liveId: LiveId, push: Push): boolean => {
  const session = sessions.get(liveId);
  if (session === undefined) return false;
  sessions.delete(liveId);
  terminals.delete(liveId);
  push({ type: "live_closed", liveId });
  const viewer = viewers.get(session.computerId);
  if (viewer?.liveId === liveId) {
    viewers.delete(session.computerId);
    viewer.socket.close(LiveViewerClose.gone);
  }
  return true;
};

// 照电脑代理 login.ts 的站点表，画面上方显示的是登录页的源。
const LOGIN_ORIGIN: Record<BrowserPlatform, string> = {
  xiaohongshu: "https://www.xiaohongshu.com",
  x: "https://x.com",
};

// 账号页点登录：画面面开着时，电脑那头「建好了登录页」，按这次的尝试号登记一个 login 会话推出去。
export const announceLogin = (account: Account, attempt: string, push: Push): void => {
  const platform = BrowserPlatform.safeParse(account.platform);
  if (!screenOn || account.via !== "computer" || !platform.success) return;
  const session = LiveSession.parse({
    liveId: randomUUID(),
    purpose: { kind: "login", accountId: account.id, platform: platform.data, attempt },
    origin: LOGIN_ORIGIN[platform.data],
    computerId: account.computerId,
  });
  sessions.set(session.liveId, session);
  push({ type: "live_session", session });
};

const settleTakeover = (liveId: LiveId, action: LiveUserEnd, push: Push): void => {
  const card = takeoverCards.get(liveId);
  if (card === undefined) return;
  takeoverCards.delete(liveId);
  const status = action === "finish" ? "ok" : "failed";
  push({ type: "message", message: rewriteMessage(card.groupId, card.messageId, { ...card.body, status }) });
};

export const attachLiveViewer = (socket: WebSocket, rawId: string, push: Push): void => {
  const parsedId = LiveId.safeParse(rawId);
  const session = parsedId.success ? sessions.get(parsedId.data) : undefined;
  if (session === undefined) {
    socket.close(LiveViewerClose.notFound);
    return;
  }
  const liveId = session.liveId;
  const previous = viewers.get(session.computerId);
  if (previous !== undefined) previous.socket.close(LiveViewerClose.replaced);
  viewers.set(session.computerId, { liveId, socket });
  socket.send(encodeLive({ t: "session", session }));
  const scrollback = terminals.get(liveId);
  if (scrollback === undefined) socket.send(encodeLive({ t: "frame", liveId }, LIVE_FRAME_JPEG));
  else socket.send(encodeLive({ t: "term", liveId, replay: true }, textEncoder.encode(scrollback)));
  socket.on("message", (data, isBinary) => {
    if (!isBinary || !(data instanceof Buffer)) return;
    const decoded = decodeLive(LiveFromViewer, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (decoded === null) return;
    received.push({ liveId, message: decoded.header });
    const header = decoded.header;
    if (header.t === "input" && header.input.kind === "term" && terminals.has(liveId)) {
      // 回车回成换行，屏上才一行一行地走。
      const echo = header.input.data.replace(/\r/g, "\r\n");
      terminals.set(liveId, (terminals.get(liveId) ?? "") + echo);
      socket.send(encodeLive({ t: "term", liveId }, textEncoder.encode(echo)));
    }
    if (header.t !== "end") return;
    // 先推 live_closed 再改卡：真栈上画面由电脑的屏收起，卡的终态要等工具结果经运行器回来，一般晚一步。
    closeSession(liveId, push);
    if (takeoverCards.get(liveId)?.hold === true) held.set(liveId, header.action);
    else settleTakeover(liveId, header.action, push);
  });
  socket.on("close", () => {
    if (viewers.get(session.computerId)?.socket === socket) viewers.delete(session.computerId);
  });
};

const TERMINAL_PATH = /^\/api\/computers\/([^/]+)\/terminal$/;
const TERMINAL_GREETING = "baize@cloud:~$ ";

// 照控制面：回 202 只给号，「电脑」稍后才报上会话，网页得等 live_session 推到再摆面板。
const openTerminal = (computerId: string, res: Parameters<Route>[0]["res"], push: Push): void => {
  const computer = computersOf().computers.find((row) => row.id === computerId);
  if (computer === undefined) return send(res, 404, { error: "没有这台电脑" });
  if (computer.kind !== "remote") return send(res, 400, { error: "只有云电脑能开终端" });
  if (computer.status !== "online") return send(res, 409, { error: "云电脑不在线，等它连上白泽后再开终端" });
  const liveId = LiveId.parse(randomUUID());
  send(res, 202, OpenTerminalResponse.parse({ liveId }));
  if (refuseTerminal) {
    refuseTerminal = false;
    setTimeout(() => push({ type: "live_closed", liveId }), 50);
    return;
  }
  setTimeout(() => {
    const session = LiveSession.parse({ liveId, purpose: { kind: "terminal" }, origin: null, computerId: computer.id });
    sessions.set(liveId, session);
    terminals.set(liveId, TERMINAL_GREETING);
    push({ type: "live_session", session });
  }, 50);
};

export const liveRoutes: Route = async ({ res, path, method, push }) => {
  const terminal = method === "POST" ? TERMINAL_PATH.exec(path) : null;
  if (terminal !== null) {
    openTerminal(decodeURIComponent(terminal[1] ?? ""), res, push);
    return true;
  }
  if (method !== "GET" || path !== "/api/live") return false;
  send(res, 200, { sessions: [...sessions.values()] });
  return true;
};

const ScreenRequest = z.object({ on: z.boolean() }).strict();
const TakeoverRequest = z
  .object({
    computerId: ComputerId,
    botId: BotId,
    groupId: GroupId,
    reason: z.string().min(1).max(200),
    hold: z.boolean().optional(),
  })
  .strict();

// Bot 在群里请人接手：写一张 running 的工具调用卡，同时登记会话推出去，卡和会话用同一个 liveId。
// 不看画面面开关：开关只是让老的登录用例别多出面板，接手只有这个端点造得出来。
const announceTakeover = (request: z.infer<typeof TakeoverRequest>, push: Push) => {
  const liveId = LiveId.parse(randomUUID());
  const body: ToolCall = {
    kind: "tool_call",
    runId: RunId.parse(`run_takeover_${liveId.slice(0, 8)}`),
    botId: request.botId,
    tool: "browser_ask_user",
    view: { kind: "takeover", liveId, reason: request.reason },
    status: "running",
    durationMs: null,
  };
  const message = appendMessage(request.groupId, body);
  takeoverCards.set(liveId, { groupId: request.groupId, messageId: message.id, body, hold: request.hold === true });
  push({ type: "message", message });
  const session = LiveSession.parse({
    liveId,
    purpose: { kind: "takeover", botId: request.botId, groupId: request.groupId, reason: request.reason },
    origin: "https://www.zhihu.com",
    computerId: request.computerId,
  });
  sessions.set(liveId, session);
  push({ type: "live_session", session });
  return { liveId, messageId: message.id };
};

// Playwright 造场景用：开关画面面、读收到的输入、直接登记一个会话、造一次 Bot 请人接手、从电脑那头收起
// （只关会话不改卡）、被别处顶掉、断网（drop：不带关闭码直接掐掉，网页按网络断处理去重连）、
// 电脑断线进了宽限（restart：观看者以 1012 关，会话留着）、替运行器把 hold 住的接手卡改成终态（settle）、
// 让下一次开终端被电脑拒开（refuse-terminal）。
export const liveTestRoutes: Route = async ({ req, res, path, method, push }) => {
  if (!path.startsWith("/api/test/live")) return false;
  if (method === "POST" && path === "/api/test/live/screen") {
    const parsed = ScreenRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "要 on" });
    else {
      screenOn = parsed.data.on;
      send(res, 204);
    }
    return true;
  }
  if (method === "GET" && path === "/api/test/live/received") {
    send(res, 200, { received });
    return true;
  }
  if (method === "POST" && path === "/api/test/live/takeover") {
    const parsed = TakeoverRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "要 computerId、botId、groupId、reason" });
    else send(res, 200, announceTakeover(parsed.data, push));
    return true;
  }
  if (method === "POST" && path === "/api/test/live/sessions") {
    const parsed = LiveSession.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "会话不对" });
    else {
      sessions.set(parsed.data.liveId, parsed.data);
      push({ type: "live_session", session: parsed.data });
      send(res, 200, { session: parsed.data });
    }
    return true;
  }
  if (method === "POST" && path === "/api/test/live/refuse-terminal") {
    refuseTerminal = true;
    send(res, 204);
    return true;
  }
  const match = /^\/api\/test\/live\/([^/]+)\/(close|replace|drop|restart|settle)$/.exec(path);
  if (method !== "POST" || match === null) return false;
  const liveId = LiveId.safeParse(match[1]);
  if (!liveId.success) {
    send(res, 404, { error: "没有这个画面" });
    return true;
  }
  if (match[2] === "close") {
    send(res, closeSession(liveId.data, push) ? 204 : 404);
    return true;
  }
  if (match[2] === "settle") {
    const action = held.get(liveId.data);
    if (action === undefined) send(res, 404, { error: "这张卡没有等着改的结论" });
    else {
      held.delete(liveId.data);
      settleTakeover(liveId.data, action, push);
      send(res, 204);
    }
    return true;
  }
  const session = sessions.get(liveId.data);
  const viewer = session === undefined ? undefined : viewers.get(session.computerId);
  if (session === undefined || viewer?.liveId !== liveId.data) send(res, 404, { error: "这个画面没人在看" });
  else {
    viewers.delete(session.computerId);
    if (match[2] === "drop") viewer.socket.terminate();
    else if (match[2] === "restart") viewer.socket.close(1012);
    else viewer.socket.close(LiveViewerClose.replaced);
    send(res, 204);
  }
  return true;
};
