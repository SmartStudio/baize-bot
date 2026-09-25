import {
  ApprovalId,
  BotId,
  BotListResponse,
  Computer,
  CopySkillRequest,
  CreateBotRequest,
  CreateBotResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  CreateRoutineRequest,
  CreateSkillRequest,
  CreateToolRequest,
  DecideApprovalRequest,
  DecideApprovalResponse,
  DecideSkillOfferRequest,
  DecideSkillOfferResponse,
  GroupId,
  GroupListResponse,
  GroupResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  MessageId,
  MessageListResponse,
  LocalComputerResponse,
  OvernightResponse,
  RegisterRequest,
  RegisterResponse,
  RoutineId,
  RoutineListResponse,
  RoutineResponse,
  SendMessageRequest,
  SendMessageResponse,
  SkillId,
  SkillListResponse,
  SkillResponse,
  TaskId,
  ToolConnectionId,
  ToolListResponse,
  type ToolOperation,
  ToolResponse,
  UpdateBotRequest,
  UpdateBotResponse,
  UpdateRoutineRequest,
  UpdateSettingsRequest,
  UpdateSkillRequest,
  UpdateTaskRequest,
  UpdateTaskResponse,
  UpdateToolRequest,
  UsageResponse,
  type Settings,
  type TriggerInput,
  type User,
} from "@baize/shared";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { dispatchUserMessage, settleApproval, settleByReply } from "../agent/dispatch.js";
import type { AgentHub } from "../agent/hub.js";
import type { GroupTurns } from "../agent/group-turn.js";
import { parseMentions } from "../agent/routing.js";
import type { Db } from "../db/client.js";
import type { ToolCrypto } from "../crypto.js";
import { discoverTools } from "../mcp/discover.js";
import { findApprovalId, listApprovals } from "../repo/approvals.js";
import { listHandoffs } from "../repo/handoffs.js";
import { createBot, deleteBot, findBot, listBots, updateBot } from "../repo/bots.js";
import { ensureComputer, findComputerByOwner, resetComputerToken } from "../repo/computers.js";
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
import {
  bumpSkillUses,
  copySkill,
  createSkill,
  decideSkillOffer,
  deleteSkill,
  findOwnedSkill,
  findOwnedSkillOfferMessage,
  listSkills,
  updateSkill,
  type SkillRow,
} from "../repo/skills.js";
import { updateTask } from "../repo/tasks.js";
import { createTool, deleteTool, findOwnedTool, listToolsByOwner, updateTool } from "../repo/tools.js";
import { authenticate, createUser, isEmailTaken } from "../repo/users.js";
import { getOvernight, getUsage } from "../repo/usage.js";
import type { PushHub } from "../ws/hub.js";
import { GATEWAY_PATH, createGateway, type GatewayDeps } from "./gateway.js";

export type AppDeps = {
  readonly db: Db;
  readonly hub: PushHub;
  readonly agents: AgentHub;
  readonly toolCrypto: ToolCrypto;
  readonly groupTurns: GroupTurns;
  readonly secureCookie: boolean;
  readonly gateway: Omit<GatewayDeps, "db">;
};

type Env = { Variables: { user: User } };

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/api/register"]);
/** webhook 的 token 本身就是凭据，打这条的人手上没有会话。只豁免这一条路由，多一段路径都不算。 */
const PUBLIC_HOOK = /^\/api\/hooks\/[^/]+$/;

const NOT_FOUND = { error: "没有这个对象" } as const;
const UNAUTHORIZED = { error: "请先登录" } as const;
/** 建、改名、复制、点存四条路撞的是同一个唯一索引，所以回的也是同一句话。 */
const NAME_TAKEN = { error: "这个 Bot 已经有同名的活了" } as const;

export function createApp(deps: AppDeps): Hono<Env> {
  const { agents, db, hub } = deps;
  const routineDeps = { db, push: hub, agents, groupTurns: deps.groupTurns };
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

  app.post("/api/register", async (c) => {
    const body = await readJson(c.req.raw, RegisterRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    let user: User;
    try {
      user = await createUser(db, body.value);
    } catch (error) {
      if (isEmailTaken(error)) return c.json({ error: "这个邮箱已经注册过了" }, 409);
      throw error;
    }
    const token = await createSession(db, user.id);
    await ensureComputer(db, user.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: deps.secureCookie,
    });
    return c.json(RegisterResponse.parse({ user }), 201);
  });

  app.post("/api/auth/login", async (c) => {
    const body = await readJson(c.req.raw, LoginRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const user = await authenticate(db, body.value.email, body.value.password);
    if (user === null) return c.json({ error: "邮箱或密码不对" }, 401);
    const token = await createSession(db, user.id);
    // 首次登录时给他登记一台电脑，状态先是创建中，代理第一次握手才转在线。
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

  app.get("/api/tools", async (c) =>
    c.json(ToolListResponse.parse({ items: await listToolsByOwner(db, c.get("user").id) })),
  );

  app.post("/api/tools", async (c) => {
    const body = await readJson(c.req.raw, CreateToolRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    let operations: ToolOperation[];
    try {
      operations = await discoverTools(body.value);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "连不上 MCP" }, 400);
    }
    const tool = await createTool(db, c.get("user").id, body.value, operations, deps.toolCrypto);
    if (tool === null) return c.json({ error: "已有同名工具连接" }, 409);
    await agents.sendConfig(c.get("user").id);
    return c.json(ToolResponse.parse({ tool }), 201);
  });

  app.patch("/api/tools/:id", async (c) => {
    const id = ToolConnectionId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NOT_FOUND, 404);
    const current = await findOwnedTool(db, c.get("user").id, id.data);
    if (current === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, UpdateToolRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const result = await updateTool(db, c.get("user").id, current, body.value);
    if (result.kind === "gone") return c.json(NOT_FOUND, 404);
    if (result.kind === "name_taken") return c.json({ error: "已有同名工具连接" }, 409);
    if (result.kind === "invalid_operation") return c.json({ error: "操作名不在这条工具连接上" }, 400);
    if (result.kind === "invalid_bot") return c.json({ error: "只能分配给自己的 Bot" }, 400);
    await agents.sendConfig(c.get("user").id);
    return c.json(ToolResponse.parse({ tool: result.tool }));
  });

  app.delete("/api/tools/:id", async (c) => {
    const id = ToolConnectionId.safeParse(c.req.param("id"));
    if (!id.success || !(await deleteTool(db, c.get("user").id, id.data))) return c.json(NOT_FOUND, 404);
    await agents.sendConfig(c.get("user").id);
    return c.body(null, 204);
  });

  app.get("/api/usage", async (c) => c.json(UsageResponse.parse(await getUsage(db, c.get("user").id))));

  app.get("/api/overnight", async (c) => c.json(OvernightResponse.parse(await getOvernight(db, c.get("user").id))));

  app.get("/api/computer", async (c) => {
    const computer = await findComputerByOwner(db, c.get("user").id);
    if (computer === null) return c.json(NOT_FOUND, 404);
    return c.json(Computer.parse(computer));
  });

  app.post("/api/computers/local", async (c) => {
    const ownerId = c.get("user").id;
    await ensureComputer(db, ownerId);
    const local = await resetComputerToken(db, ownerId);
    if (local === null) throw new Error(`用户 ${ownerId} 的本机电脑既没建成也无法重置 token`);
    return c.json(LocalComputerResponse.parse(local));
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

  app.get("/api/bots/:id/skills", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    if ((await findBot(db, c.get("user").id, botId.data)) === null) return c.json(NOT_FOUND, 404);
    const items = await listSkills(db, botId.data);
    return c.json(SkillListResponse.parse({ items }));
  });

  app.post("/api/bots/:id/skills", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    if ((await findBot(db, c.get("user").id, botId.data)) === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, CreateSkillRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    // 用户在 Web 上「教它一个」，来源恒为 taught。
    const skill = await createSkill(db, botId.data, { ...body.value, source: "taught" });
    if (skill === null) return c.json(NAME_TAKEN, 409);
    await agents.sendConfig(c.get("user").id);
    hub.push(c.get("user").id, { type: "skill_updated", skill });
    return c.json(SkillResponse.parse({ skill }), 201);
  });

  app.patch("/api/skills/:id", async (c) => {
    const owned = await ownedSkill(db, c);
    if (owned === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, UpdateSkillRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const updated = await updateSkill(db, SkillId.parse(owned.id), body.value);
    if (updated.kind === "gone") return c.json(NOT_FOUND, 404);
    if (updated.kind === "name_taken") return c.json(NAME_TAKEN, 409);
    await agents.sendConfig(c.get("user").id);
    hub.push(c.get("user").id, { type: "skill_updated", skill: updated.skill });
    return c.json(SkillResponse.parse({ skill: updated.skill }));
  });

  app.delete("/api/skills/:id", async (c) => {
    const owned = await ownedSkill(db, c);
    if (owned === null) return c.json(NOT_FOUND, 404);
    if (!(await deleteSkill(db, SkillId.parse(owned.id)))) return c.json(NOT_FOUND, 404);
    await agents.sendConfig(c.get("user").id);
    hub.push(c.get("user").id, {
      type: "skill_deleted",
      skillId: SkillId.parse(owned.id),
      botId: BotId.parse(owned.botId),
    });
    return c.body(null, 204);
  });

  app.post("/api/skills/:id/copy", async (c) => {
    const owned = await ownedSkill(db, c);
    if (owned === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, CopySkillRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    // 目标 Bot 也要是自己的，别人的和不存在的一样 404：复制是往目标里写东西，源的归属管不了目标。
    if ((await findBot(db, c.get("user").id, body.value.botId)) === null) return c.json(NOT_FOUND, 404);
    const skill = await copySkill(db, owned, body.value.botId);
    if (skill === null) return c.json(NAME_TAKEN, 409);
    await agents.sendConfig(c.get("user").id);
    hub.push(c.get("user").id, { type: "skill_updated", skill });
    return c.json(SkillResponse.parse({ skill }), 201);
  });

  app.post("/api/messages/:id/skill-offer", async (c) => {
    const messageId = MessageId.safeParse(c.req.param("id"));
    if (!messageId.success) return c.json(NOT_FOUND, 404);
    // 别人的消息、不存在的消息、正文不是这张卡的消息，在这里都是 null，一律 404。
    const offer = await findOwnedSkillOfferMessage(db, c.get("user").id, messageId.data);
    if (offer === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, DecideSkillOfferRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);

    const decided = await decideSkillOffer(db, c.get("user").id, offer, body.value.decision);
    // 卡上那个 Bot 已经删了，那条 skill 无处可落，和卡本身不在一样 404。
    if (decided.kind === "bot_gone") return c.json(NOT_FOUND, 404);
    if (decided.kind === "already_decided") return c.json({ error: "这条卡已经有结论了" }, 409);
    if (decided.kind === "name_taken") return c.json(NAME_TAKEN, 409);

    // 卡的状态住在正文里，所以点完要重推那条 message，客户端按 id 覆盖它。
    hub.push(c.get("user").id, { type: "message", message: decided.message });
    if (decided.skill !== null) {
      hub.push(c.get("user").id, { type: "skill_updated", skill: decided.skill });
      // 不存什么都没变，`config.skills` 也就不用重发。
      await agents.sendConfig(c.get("user").id);
    }
    return c.json(DecideSkillOfferResponse.parse({ message: decided.message, skill: decided.skill }));
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
    deps.groupTurns.cancel(groupId.data);

    const message = await appendMessage(db, owned, sent);
    hub.push(c.get("user").id, { type: "message", message });

    // `/名` 只加一次用量，正文一个字都不改：运行器收到的和用户手打的一模一样，Pi 自己按名字找那份 SKILL.md。
    // 不重发 config：变的只有 use_count，它不进 SKILL.md。
    for (const skill of await bumpSkillUses(db, owned, body.value.text)) {
      hub.push(c.get("user").id, { type: "skill_updated", skill });
    }

    const settled = await settleByReply({ db, push: hub, agents }, c.get("user").id, owned, body.value.text);
    if (!settled)
      await dispatchUserMessage(
        { db, push: hub, agents, groupTurns: deps.groupTurns },
        c.get("user").id,
        groupId.data,
        message,
      );
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

/** skill 按归属人查，别人的和不存在的一样是 404。 */
function ownedSkill(db: Db, c: Context<Env>): Promise<SkillRow | null> {
  const skillId = SkillId.safeParse(c.req.param("id"));
  if (!skillId.success) return Promise.resolve(null);
  return findOwnedSkill(db, c.get("user").id, skillId.data);
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
