import {
  ApprovalId,
  BotId,
  BotListResponse,
  Computer,
  CreateBotRequest,
  CreateBotResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  CreateRoutineRequest,
  DecideApprovalRequest,
  DecideApprovalResponse,
  GroupId,
  GroupListResponse,
  GroupResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  MessageId,
  MessageListResponse,
  RoutineId,
  RoutineListResponse,
  RoutineResponse,
  SendMessageRequest,
  SendMessageResponse,
  TaskId,
  UpdateBotRequest,
  UpdateBotResponse,
  UpdateRoutineRequest,
  UpdateSettingsRequest,
  UpdateTaskRequest,
  UpdateTaskResponse,
  type Settings,
  type TriggerInput,
  type User,
} from "@baize/shared";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { dispatchUserMessage, settleApproval, settleByReply } from "../agent/dispatch.js";
import type { AgentHub } from "../agent/hub.js";
import type { MentionLoopGuard } from "../agent/mention-loop.js";
import { parseMentions } from "../agent/routing.js";
import type { Db } from "../db/client.js";
import { findApprovalId, listApprovals } from "../repo/approvals.js";
import { listHandoffs } from "../repo/handoffs.js";
import { createBot, deleteBot, findBot, listBots, updateBot } from "../repo/bots.js";
import { ensureComputer, findComputerByOwner } from "../repo/computers.js";
import { createGroup, findGroup, listGroups } from "../repo/groups.js";
import { appendMessage, findGroupId, listGroupBots, listMessages } from "../repo/messages.js";
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, deleteSession, userForSession } from "../repo/sessions.js";
import {
  createRoutine,
  deleteRoutine,
  findOwnedRoutine,
  findRoutineByWebhookToken,
  listRoutines,
  updateRoutine,
  type OwnedRoutine,
} from "../repo/routines.js";
import { isValidCron } from "../routines/cron.js";
import { runRoutine } from "../routines/run.js";
import { getSettings, updateSettings } from "../repo/settings.js";
import { updateTask } from "../repo/tasks.js";
import { authenticate } from "../repo/users.js";
import type { PushHub } from "../ws/hub.js";
import { GATEWAY_PATH, createGateway, type GatewayDeps } from "./gateway.js";

export type AppDeps = {
  readonly db: Db;
  readonly hub: PushHub;
  readonly agents: AgentHub;
  readonly mentionLoop: MentionLoopGuard;
  readonly secureCookie: boolean;
  readonly gateway: Omit<GatewayDeps, "db">;
};

type Env = { Variables: { user: User } };

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);
/** webhook 的 token 本身就是凭据，打这条的人手上没有会话。只豁免这一条路由，多一段路径都不算。 */
const PUBLIC_HOOK = /^\/api\/hooks\/[^/]+$/;

const NOT_FOUND = { error: "没有这个对象" } as const;
const UNAUTHORIZED = { error: "请先登录" } as const;

export function createApp(deps: AppDeps): Hono<Env> {
  const { agents, db, hub } = deps;
  const routineDeps = { db, push: hub, agents };
  const app = new Hono<Env>();

  app.route(GATEWAY_PATH, createGateway({ db, ...deps.gateway }));

  app.use("/api/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path) || PUBLIC_HOOK.test(c.req.path)) return next();
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
    // 首次登录时给他建云电脑。规格里的「首次登录时后台创建云电脑」，状态先是创建中。
    await ensureComputer(db, user.id);
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

  app.get("/api/computer", async (c) => {
    const computer = await findComputerByOwner(db, c.get("user").id);
    if (computer === null) return c.json(NOT_FOUND, 404);
    return c.json(Computer.parse(computer));
  });

  app.get("/api/bots", async (c) => {
    const items = await listBots(db, c.get("user").id);
    return c.json(BotListResponse.parse({ items }));
  });

  app.post("/api/bots", async (c) => {
    const body = await readJson(c.req.raw, CreateBotRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const created = await createBot(db, c.get("user").id, body.value);
    await agents.sendConfig(c.get("user").id);
    return c.json(CreateBotResponse.parse(created), 201);
  });

  app.patch("/api/bots/:id", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, UpdateBotRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const bot = await updateBot(db, c.get("user").id, botId.data, body.value);
    if (bot === null) return c.json(NOT_FOUND, 404);
    await agents.sendConfig(c.get("user").id);
    hub.push(c.get("user").id, { type: "bot_updated", bot });
    return c.json(UpdateBotResponse.parse({ bot }));
  });

  app.delete("/api/bots/:id", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    const deleted = await deleteBot(db, c.get("user").id, botId.data);
    if (!deleted) return c.json(NOT_FOUND, 404);
    await agents.sendConfig(c.get("user").id);
    hub.push(c.get("user").id, { type: "bot_deleted", botId: botId.data });
    return c.body(null, 204);
  });

  app.get("/api/bots/:id/routines", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    // 别人的 Bot 在这里就挡住了，下面按 bot_id 查就不用再管归属。
    if ((await findBot(db, c.get("user").id, botId.data)) === null) return c.json(NOT_FOUND, 404);
    const items = await listRoutines(db, botId.data);
    return c.json(RoutineListResponse.parse({ items }));
  });

  app.post("/api/bots/:id/routines", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    if ((await findBot(db, c.get("user").id, botId.data)) === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, CreateRoutineRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const bad = badCron(body.value.triggers);
    if (bad !== null) return c.json({ error: bad }, 400);
    const routine = await createRoutine(db, botId.data, body.value);
    hub.push(c.get("user").id, { type: "routine_updated", routine });
    return c.json(RoutineResponse.parse({ routine }), 201);
  });

  app.patch("/api/routines/:id", async (c) => {
    const owned = await ownedRoutine(db, c);
    if (owned === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, UpdateRoutineRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const bad = badCron(body.value.triggers ?? []);
    if (bad !== null) return c.json({ error: bad }, 400);
    const routine = await updateRoutine(db, RoutineId.parse(owned.row.id), body.value);
    if (routine === null) return c.json(NOT_FOUND, 404);
    hub.push(c.get("user").id, { type: "routine_updated", routine });
    return c.json(RoutineResponse.parse({ routine }));
  });

  app.delete("/api/routines/:id", async (c) => {
    const owned = await ownedRoutine(db, c);
    if (owned === null) return c.json(NOT_FOUND, 404);
    if (!(await deleteRoutine(db, RoutineId.parse(owned.row.id)))) return c.json(NOT_FOUND, 404);
    hub.push(c.get("user").id, {
      type: "routine_deleted",
      routineId: RoutineId.parse(owned.row.id),
      botId: BotId.parse(owned.row.botId),
    });
    return c.body(null, 204);
  });

  app.post("/api/routines/:id/run", async (c) => {
    const owned = await ownedRoutine(db, c);
    if (owned === null) return c.json(NOT_FOUND, 404);
    // 停用只挡自动触发，试跑照跑。
    const routine = await runRoutine(routineDeps, owned.ownerId, owned.row, new Date());
    if (routine === null) return c.json(NOT_FOUND, 404);
    return c.json(RoutineResponse.parse({ routine }), 202);
  });

  app.post("/api/hooks/:token", async (c) => {
    const owned = await findRoutineByWebhookToken(db, c.req.param("token"));
    if (owned === null) return c.json(NOT_FOUND, 404);
    if (!owned.row.enabled) return c.json({ error: "这条例行任务已停用" }, 409);
    if ((await runRoutine(routineDeps, owned.ownerId, owned.row, new Date())) === null) return c.json(NOT_FOUND, 404);
    return c.body(null, 202);
  });

  app.post("/api/groups", async (c) => {
    const body = await readJson(c.req.raw, CreateGroupRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const created = await createGroup(db, c.get("user").id, body.value);
    // 别人的 Bot 和不存在的 Bot 一样是 404，不泄露有没有这个 Bot。
    if (created.kind === "unknown_bot") return c.json(NOT_FOUND, 404);
    if (created.kind === "duplicate_bot") return c.json({ error: "同一个 Bot 不能重复拉进群" }, 400);
    // 不发 config：config 里只有 Bot 列表，建群没有改它。
    hub.push(c.get("user").id, { type: "group_created", group: created.group, task: created.task });
    return c.json(CreateGroupResponse.parse({ group: created.group, task: created.task }), 201);
  });

  app.get("/api/groups", async (c) => {
    const items = await listGroups(db, c.get("user").id);
    return c.json(GroupListResponse.parse({ items }));
  });

  app.get("/api/groups/:id", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("id"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const detail = await findGroup(db, c.get("user").id, groupId.data);
    if (detail === null) return c.json(NOT_FOUND, 404);
    return c.json(GroupResponse.parse(detail));
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

    const approvalIds = result.page.messages.flatMap((m) => (m.body.kind === "approval" ? [m.body.approvalId] : []));
    const approvals = await listApprovals(db, approvalIds);
    const handoffIds = result.page.messages.flatMap((m) => (m.body.kind === "handoff" ? [m.body.handoffId] : []));
    const handoffs = await listHandoffs(db, handoffIds);
    return c.json(MessageListResponse.parse({ ...result.page, approvals, handoffs }));
  });

  app.post("/api/groups/:id/messages", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("id"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const owned = await findGroupId(db, c.get("user").id, groupId.data);
    if (owned === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, SendMessageRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);

    // @名 在写入前解析一次就存进正文，派活只看 mentions，不重新解析正文。单 Bot 群 parseMentions 自己返回空。
    const mentions = parseMentions(body.value.text, await listGroupBots(db, owned));
    // 没 @ 人就不带这个字段：MessageBody 里它可省，恒带一个空数组等于说「@ 了一批空的人」。
    const sent =
      mentions.length === 0
        ? ({ kind: "user", text: body.value.text } as const)
        : ({ kind: "user", text: body.value.text, mentions } as const);
    // 防循环的限额是「两条用户消息之间」，所以用户一说话就归零。
    deps.mentionLoop.reset(owned);

    const message = await appendMessage(db, owned, sent);
    hub.push(c.get("user").id, { type: "message", message });
    const settled = await settleByReply({ db, push: hub, agents }, c.get("user").id, owned, body.value.text);
    if (!settled) await dispatchUserMessage({ db, push: hub, agents }, c.get("user").id, groupId.data, message);
    return c.json(SendMessageResponse.parse({ message }), 201);
  });

  app.post("/api/approvals/:id", async (c) => {
    const approvalId = ApprovalId.safeParse(c.req.param("id"));
    if (!approvalId.success) return c.json(NOT_FOUND, 404);
    // 别人的审批查不到，和不存在一样是 404，不泄露有没有这条。
    const owned = await findApprovalId(db, c.get("user").id, approvalId.data);
    if (owned === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, DecideApprovalRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);

    const settled = await settleApproval({ db, push: hub, agents }, c.get("user").id, owned, body.value.decision);
    if (settled.kind === "already_decided") return c.json({ error: "这条审批已经有结论了" }, 409);
    return c.json(DecideApprovalResponse.parse({ approval: settled.approval }));
  });

  app.patch("/api/tasks/:id", async (c) => {
    const taskId = TaskId.safeParse(c.req.param("id"));
    if (!taskId.success) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, UpdateTaskRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const task = await updateTask(db, c.get("user").id, taskId.data, body.value);
    if (task === null) return c.json(NOT_FOUND, 404);
    hub.push(c.get("user").id, { type: "task_updated", task });
    return c.json(UpdateTaskResponse.parse({ task }));
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

/** 例行任务按归属人查，别人的和不存在的一样是 404。 */
function ownedRoutine(db: Db, c: Context<Env>): Promise<OwnedRoutine | null> {
  const routineId = RoutineId.safeParse(c.req.param("id"));
  if (!routineId.success) return Promise.resolve(null);
  return findOwnedRoutine(db, c.get("user").id, routineId.data);
}

/** cron 在收下的时候就解一遍，不合法的表达式不该进库等调度器每 30 秒失败一次。 */
function badCron(triggers: readonly TriggerInput[]): string | null {
  for (const trigger of triggers) {
    if (trigger.kind === "cron" && !isValidCron(trigger.expr)) return `cron 表达式不合法：${trigger.expr}`;
  }
  return null;
}

const MessageQuery = z.object({
  before: MessageId.optional(),
  limit: z.coerce.number().int().positive().optional(),
});

type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

// 泛型收在 schema 上而不是 z.ZodType<T>：后者的输入类型会把 BotId 这类品牌化 ID 磨回 string。
async function readJson<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<ReadResult<z.infer<S>>> {
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
