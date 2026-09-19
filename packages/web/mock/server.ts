import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  Bot,
  CreateBotRequest,
  CreateGroupRequest,
  CopySkillRequest,
  CreateRoutineRequest,
  CreateSkillRequest,
  DecideApprovalRequest,
  DecideSkillOfferRequest,
  LoginRequest,
  SendMessageRequest,
  Settings,
  UpdateBotRequest,
  UpdateRoutineRequest,
  UpdateSettingsRequest,
  UpdateSkillRequest,
  UpdateTaskRequest,
  type Routine,
  type ServerPush,
} from "@baize/shared";
import {
  MOCK_EMAIL,
  MOCK_PASSWORD,
  appendMessage,
  approvals,
  approvalsIn,
  assignTask,
  bots,
  createBot,
  confirmNextHandoff,
  copySkillTo,
  createGroup,
  createRoutine,
  createSkill,
  findMessage,
  groupIdByBotId,
  groups,
  handoffsIn,
  holdHandoffAccept,
  isTeamGroup,
  lastMessageOf,
  mentionsIn,
  overnightOf,
  pendingApprovalsOf,
  pendingHandoffsOf,
  reseed,
  seedUnseenHandoff,
  responderOf,
  routineByToken,
  messagesByGroupId,
  routines,
  routinesOf,
  runRoutine,
  settleApproval,
  settleLatestPending,
  settleUnseenHandoff,
  settings,
  skillNameTaken,
  skills,
  skillsOf,
  streamBotReply,
  tasks,
  user,
  usageOf,
  writeMessageBody,
  writeRoutine,
  writeSkill,
  writeTask,
  type ApprovalDecision,
} from "./state.js";

// 群里回一句话和点按钮是同一件事。词表用表装着，加一个说法不用多一条分支。
const DECISION_WORDS = new Map<string, ApprovalDecision>([
  ["批准", "approved"],
  ["同意", "approved"],
  ["拒绝", "rejected"],
  ["不行", "rejected"],
]);

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

// 一次运行不看是谁按的：群里落 system 加 user 两条，运行记录多一条 running，整条例行任务推回去。
const fireRoutine = (routineId: string): Routine | null => {
  const ran = runRoutine(routineId);
  if (ran === null) return null;
  push({ type: "routine_updated", routine: ran.routine });
  for (const message of ran.messages) push({ type: "message", message });
  return ran.routine;
};

const botListItems = () =>
  [...bots.values()].map((bot) => {
    const groupId = groupIdByBotId.get(bot.id);
    if (groupId === undefined) throw new Error(`Bot ${bot.id} 没有群，mock 状态坏了`);
    return {
      bot,
      groupId,
      lastMessage: lastMessageOf(groupId),
      pendingApprovals: pendingApprovalsOf(groupId),
      pendingHandoffs: pendingHandoffsOf(groupId),
    };
  });

const groupListItems = () =>
  [...groups.values()].filter(isTeamGroup).map((group) => {
    const task = tasks.get(group.taskId);
    if (task === undefined) throw new Error(`群 ${group.id} 没有主题任务，mock 状态坏了`);
    return {
      group,
      task,
      lastMessage: lastMessageOf(group.id),
      pendingApprovals: pendingApprovalsOf(group.id),
      pendingHandoffs: pendingHandoffsOf(group.id),
    };
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

  if (method === "POST" && path === "/api/test/handoff/pending") {
    return send(res, 201, { handoff: seedUnseenHandoff() });
  }

  if (method === "POST" && path === "/api/test/handoff/hold") {
    holdHandoffAccept();
    return send(res, 204);
  }

  if (method === "POST" && path === "/api/test/handoff/accept") {
    if (confirmNextHandoff()) return send(res, 204);
    const accepted = settleUnseenHandoff();
    if (accepted === null) return send(res, 404, { error: "没有待确认的交接" });
    push({ type: "handoff_updated", handoff: accepted });
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

  // webhook 是外面的系统打进来的，它没有会话，所以这条排在登录检查前面。
  const hookMatch = /^\/api\/hooks\/([^/]+)$/.exec(path);
  if (hookMatch && method === "POST") {
    const [, rawToken] = hookMatch;
    const routine = routineByToken(rawToken === undefined ? "" : decodeURIComponent(rawToken));
    if (routine === null) return send(res, 404, { error: "没有这个 webhook" });
    if (!routine.enabled) return send(res, 409, { error: "这条例行任务停用了" });
    return send(res, fireRoutine(routine.id) === null ? 404 : 202);
  }

  if (!authed(req)) return send(res, 401, { error: "没登录" });

  if (method === "GET" && path === "/api/me") return send(res, 200, { user });
  if (method === "GET" && path === "/api/usage") return send(res, 200, usageOf());
  if (method === "GET" && path === "/api/overnight") return send(res, 200, overnightOf());

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

  const botRoutinesMatch = /^\/api\/bots\/([^/]+)\/routines$/.exec(path);
  if (botRoutinesMatch) {
    const [, rawBotId] = botRoutinesMatch;
    const botId = rawBotId === undefined ? "" : decodeURIComponent(rawBotId);
    if (!bots.has(botId)) return send(res, 404, { error: "没有这个 Bot" });
    if (method === "GET") return send(res, 200, { items: routinesOf(botId) });
    if (method === "POST") {
      const parsed = CreateRoutineRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "例行任务字段不对" });
      const routine = createRoutine(botId, parsed.data);
      push({ type: "routine_updated", routine });
      return send(res, 201, { routine });
    }
  }

  const routineRunMatch = /^\/api\/routines\/([^/]+)\/run$/.exec(path);
  if (routineRunMatch && method === "POST") {
    const [, rawRoutineId] = routineRunMatch;
    const ran = fireRoutine(rawRoutineId === undefined ? "" : decodeURIComponent(rawRoutineId));
    if (ran === null) return send(res, 404, { error: "没有这条例行任务" });
    return send(res, 202, { routine: ran });
  }

  const routineMatch = /^\/api\/routines\/([^/]+)$/.exec(path);
  if (routineMatch) {
    const [, rawRoutineId] = routineMatch;
    const routineId = rawRoutineId === undefined ? "" : decodeURIComponent(rawRoutineId);
    const routine = routines.get(routineId);
    if (routine === undefined) return send(res, 404, { error: "没有这条例行任务" });
    if (method === "PATCH") {
      const parsed = UpdateRoutineRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "例行任务字段不对" });
      const next = writeRoutine(routineId, defined(parsed.data));
      if (next === null) return send(res, 404, { error: "没有这条例行任务" });
      push({ type: "routine_updated", routine: next });
      return send(res, 200, { routine: next });
    }
    if (method === "DELETE") {
      routines.delete(routineId);
      push({ type: "routine_deleted", routineId: routine.id, botId: routine.botId });
      return send(res, 204);
    }
  }

  const botSkillsMatch = /^\/api\/bots\/([^/]+)\/skills$/.exec(path);
  if (botSkillsMatch) {
    const [, rawBotId] = botSkillsMatch;
    const botId = rawBotId === undefined ? "" : decodeURIComponent(rawBotId);
    if (!bots.has(botId)) return send(res, 404, { error: "没有这个 Bot" });
    if (method === "GET") return send(res, 200, { items: skillsOf(botId) });
    if (method === "POST") {
      const parsed = CreateSkillRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "skill 字段不对" });
      if (skillNameTaken(botId, parsed.data.name)) {
        return send(res, 409, { error: "这个 Bot 已经有同名的 skill 了" });
      }
      const skill = createSkill(botId, parsed.data, "taught");
      push({ type: "skill_updated", skill });
      return send(res, 201, { skill });
    }
  }

  const skillCopyMatch = /^\/api\/skills\/([^/]+)\/copy$/.exec(path);
  if (skillCopyMatch && method === "POST") {
    const [, rawSkillId] = skillCopyMatch;
    const skillId = rawSkillId === undefined ? "" : decodeURIComponent(rawSkillId);
    // body 先读完，查到和写之间不留一个能让别的请求插进来的 await。
    const parsed = CopySkillRequest.safeParse(await readBody(req));
    const skill = skills.get(skillId);
    if (skill === undefined) return send(res, 404, { error: "没有这条 skill" });
    if (!parsed.success) return send(res, 400, { error: "skill 字段不对" });
    if (!bots.has(parsed.data.botId)) return send(res, 404, { error: "没有这个 Bot" });
    if (skillNameTaken(parsed.data.botId, skill.name)) {
      return send(res, 409, { error: "这个 Bot 已经有同名的 skill 了" });
    }
    const copy = copySkillTo(skillId, parsed.data.botId);
    if (copy === null) return send(res, 404, { error: "没有这条 skill" });
    push({ type: "skill_updated", skill: copy });
    return send(res, 201, { skill: copy });
  }

  const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(path);
  if (skillMatch) {
    const [, rawSkillId] = skillMatch;
    const skillId = rawSkillId === undefined ? "" : decodeURIComponent(rawSkillId);
    const skill = skills.get(skillId);
    if (skill === undefined) return send(res, 404, { error: "没有这条 skill" });
    if (method === "PATCH") {
      const parsed = UpdateSkillRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "skill 字段不对" });
      const patch = defined(parsed.data);
      if (patch.name !== undefined && skillNameTaken(skill.botId, patch.name, skill.id)) {
        return send(res, 409, { error: "这个 Bot 已经有同名的 skill 了" });
      }
      const next = writeSkill(skillId, patch);
      if (next === null) return send(res, 404, { error: "没有这条 skill" });
      push({ type: "skill_updated", skill: next });
      return send(res, 200, { skill: next });
    }
    if (method === "DELETE") {
      skills.delete(skillId);
      push({ type: "skill_deleted", skillId: skill.id, botId: skill.botId });
      return send(res, 204);
    }
  }

  const skillOfferMatch = /^\/api\/messages\/([^/]+)\/skill-offer$/.exec(path);
  if (skillOfferMatch && method === "POST") {
    const [, rawMessageId] = skillOfferMatch;
    const messageId = rawMessageId === undefined ? "" : decodeURIComponent(rawMessageId);
    // body 先读完，查到和写之间不留一个能让别的请求插进来的 await。
    const parsed = DecideSkillOfferRequest.safeParse(await readBody(req));
    const card = findMessage(messageId);
    const body = card?.body;
    if (body === undefined || body.kind !== "skill_offer") {
      return send(res, 404, { error: "这条消息不是一张存 skill 的卡" });
    }
    if (!parsed.success) return send(res, 400, { error: "结论只能是存或不存" });
    if (body.status !== "offered") return send(res, 409, { error: "这张卡已经有结论了" });
    const saving = parsed.data.decision === "save";
    // 名字撞了就把卡留在 offered，用户改个名还能再点一次；改成 saved 的话这张卡就废了。
    if (saving && skillNameTaken(body.botId, body.name)) {
      return send(res, 409, { error: "这个 Bot 已经有同名的 skill 了" });
    }
    const skill = saving ? createSkill(body.botId, { name: body.name, steps: body.steps }, "chat") : null;
    const message = writeMessageBody(
      messageId,
      skill === null ? { ...body, status: "dismissed" } : { ...body, status: "saved", skillId: skill.id },
    );
    if (message === null) return send(res, 404, { error: "这条消息不是一张存 skill 的卡" });
    push({ type: "message", message });
    if (skill !== null) push({ type: "skill_updated", skill });
    return send(res, 200, { message, skill });
  }

  if (path === "/api/groups") {
    if (method === "GET") return send(res, 200, { items: groupListItems() });
    if (method === "POST") {
      const parsed = CreateGroupRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "建群字段不对" });
      const created = createGroup(parsed.data);
      push({ type: "group_created", group: created.group, task: created.task });
      return send(res, 200, created);
    }
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch && method === "PATCH") {
    const [, rawTaskId] = taskMatch;
    const taskId = rawTaskId === undefined ? "" : decodeURIComponent(rawTaskId);
    const parsed = UpdateTaskRequest.safeParse(await readBody(req));
    if (!tasks.has(taskId)) return send(res, 404, { error: "没有这个任务" });
    if (!parsed.success) return send(res, 400, { error: "任务字段不对" });
    const next = writeTask(taskId, defined(parsed.data));
    if (next === null) return send(res, 404, { error: "没有这个任务" });
    push({ type: "task_updated", task: next });
    return send(res, 200, { task: next });
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
      const page = all.slice(start, end < 0 ? all.length : end);
      return send(res, 200, {
        messages: page,
        hasMore: start > 0,
        approvals: approvalsIn(page),
        handoffs: handoffsIn(page),
      });
    }
    if (method === "POST") {
      const parsed = SendMessageRequest.safeParse(await readBody(req));
      if (!parsed.success) return send(res, 400, { error: "消息不能为空" });
      const text = parsed.data.text;
      // 「@小销」这几个字是用户打的，谁被 @ 到由服务端认，前端不用也不该自己数一遍。
      const mentions = mentionsIn(groupId, text);
      const message = appendMessage(
        groupId,
        mentions.length > 0 ? { kind: "user", text, mentions } : { kind: "user", text },
      );
      const decision = DECISION_WORDS.get(text.trim());
      const settled = decision === undefined ? null : settleLatestPending(groupId, decision);
      // 这句话就是结论，不再另起一次运行：正等着这条审批的那次运行收到结论会自己接着往下走。
      // 没有在等结论的审批时 settled 是 null，「批准」就只是一句普通的话，照常跑一次运行。
      if (settled !== null) {
        push({ type: "approval_updated", approval: settled });
        return send(res, 200, { message });
      }
      const responder = responderOf(groupId, mentions);
      if (responder === null) {
        // 多 Bot 群里谁都没被 @ 到，也还没人接手。群里补一句，而不是让这句话没人应。
        const note = appendMessage(groupId, { kind: "system", text: "没人接这句话。@ 一个 Bot 派活。" });
        push({ type: "message", message: note });
        return send(res, 200, { message });
      }
      const assigned = assignTask(groupId, responder);
      if (assigned !== null) push({ type: "task_updated", task: assigned });
      // 一次运行要跑上秒级，POST 只回用户那条，Bot 那边的工具卡、流式正文和花费卡全走推送。
      streamBotReply(groupId, responder, text, push).catch((cause: unknown) => {
        process.stderr.write(`mock 回复跑挂了：${String(cause)}\n`);
      });
      return send(res, 200, { message });
    }
  }

  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(path);
  if (approvalMatch && method === "POST") {
    const [, rawApprovalId] = approvalMatch;
    const id = rawApprovalId === undefined ? "" : decodeURIComponent(rawApprovalId);
    // body 先读完。查到和写结论之间只要还有一个 await，群里回的那句话就能从这个缝里插进来先写一遍。
    const parsed = DecideApprovalRequest.safeParse(await readBody(req));
    if (!approvals.has(id)) return send(res, 404, { error: "没有这条审批" });
    if (!parsed.success) return send(res, 400, { error: "结论只能是批准或拒绝" });
    const next = settleApproval(id, parsed.data.decision);
    if (next === null) return send(res, 409, { error: "这条审批已经有结论了" });
    push({ type: "approval_updated", approval: next });
    return send(res, 200, { approval: next });
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
