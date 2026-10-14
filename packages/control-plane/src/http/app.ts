import {
  AccountId,
  AccountListResponse,
  AccountResponse,
  ApprovalId,
  BrowserPlatform,
  ApprovePlanRequest,
  ApprovePlanResponse,
  BotId,
  BotListResponse,
  BotResponse,
  CreateAccountRequest,
  ComputerListResponse,
  ComputerTokenResponse,
  ContentPlanId,
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
  DecideDraftRequest,
  DecideDraftResponse,
  DecidePreferenceOfferRequest,
  DecidePreferenceOfferResponse,
  DecideProjectOfferRequest,
  DecideProjectOfferResponse,
  DecideSkillOfferRequest,
  DecideSkillOfferResponse,
  DraftId,
  GrantId,
  GrantListResponse,
  GroupId,
  GroupListResponse,
  GroupResponse,
  LoginAccountRequest,
  LoginAccountResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  MessageId,
  MessageListResponse,
  MessageResponse,
  PairLocalComputerRequest,
  PairLocalConflictResponse,
  ProjectResponse,
  RegisterRequest,
  RegisterResponse,
  ReturnPlanResponse,
  RoutineId,
  RoutineListResponse,
  RoutineResponse,
  SendMessageRequest,
  SendMessageResponse,
  SkillId,
  SkillListResponse,
  SkillResponse,
  TaskId,
  TodayResponse,
  ToolConnectionId,
  ToolListResponse,
  type ToolOperation,
  ToolResponse,
  UpdateAccountRequest,
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
  type UserId,
} from "@baize/shared";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { dispatchUserMessage, settleApproval, settleByReply } from "../agent/dispatch.js";
import type { AgentHub } from "../agent/hub.js";
import { enqueueDownlink } from "../agent/envelope.js";
import type { GroupTurns } from "../agent/group-turn.js";
import { parseMentions } from "../agent/routing.js";
import type { Db } from "../db/client.js";
import type { ToolCrypto } from "../crypto.js";
import { DiscoveryError, discoverTools } from "../mcp/discover.js";
import { assertNotTable, TableGroupError } from "../poker/store.js";
import { createPlaceholder, findAccount, listAccounts, setAccountTier } from "../repo/accounts.js";
import { findApprovalId, listApprovals } from "../repo/approvals.js";
import { approvePlan, decideDraft, listDraftsForPage, listPlansForPage, returnPlan } from "../repo/drafts.js";
import { listHandoffs } from "../repo/handoffs.js";
import { createBot, deleteBot, ensureAssistant, findBot, listBots, setRunState, updateBot } from "../repo/bots.js";
import { TABLE_ROLES } from "../repo/poker-presets.js";
import { ensureComputer, listComputers, resetComputerToken } from "../repo/computers.js";
import { deleteGrant, listGrants } from "../repo/grants.js";
import { createGroup, findGroup, listGroups } from "../repo/groups.js";
import { findLiveGroupId } from "../repo/live-groups.js";
import { appendMessage, findOwnedMessage, listGroupBots, listMessages } from "../repo/messages.js";
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, deleteSession, userForSession } from "../repo/sessions.js";
import {
  createRoutine,
  deleteRoutine,
  findOwnedRoutine,
  findRoutineByWebhookToken,
  listOwnerRoutines,
  listRoutines,
  loadRoutine,
  updateRoutine,
  type OwnedRoutine,
} from "../repo/routines.js";
import { isValidCron } from "../routines/cron.js";
import { pushRoutineUpdated, runRoutine } from "../routines/run.js";
import { decidePreferenceOffer, findOwnedPreferenceOffer } from "../repo/preferences.js";
import { decideProjectOffer, findOwnedProjectOffer } from "../repo/projects.js";
import { listPublicationsForPage } from "../repo/publications.js";
import { getSettings, updateSettings } from "../repo/settings.js";
import { getToday } from "../repo/today.js";
import { getProject } from "../repo/project-page.js";
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
import {
  createTool,
  deleteTool,
  findOwnedTool,
  listToolsByOwner,
  updateTool,
  type Reauthorized,
} from "../repo/tools.js";
import { authenticate, createUser, isEmailTaken } from "../repo/users.js";
import { getUsage } from "../repo/usage.js";
import type { NoticePublisher } from "../notifications.js";
import type { PushHub } from "../ws/hub.js";
import type { AccountTokens, CredentialCrypto } from "../credentials.js";
import type { OAuthEndpoints } from "../oauth-providers.js";
import { ACCOUNTS_PROXY_PATH, createAccountsProxy } from "./accounts-proxy.js";
import { GATEWAY_PATH, createGateway, type GatewayDeps } from "./gateway.js";
import { MCP_PROXY_PATH, createMcpProxy } from "./mcp-proxy.js";
import { McpClients } from "../mcp/call.js";
import { OAUTH_PATH, createOAuthRoutes } from "./oauth.js";
import { announceBrand, createBrandRoutes } from "./routes/brand.js";
import { createGoalRoutes } from "./routes/goals.js";
import { createPokerHandRoutes } from "./routes/poker-hands.js";
import { createPokerHintRoutes } from "./routes/poker-hint.js";
import { createPokerReviewRoutes } from "./routes/poker-review.js";
import { createPokerTableRoutes } from "./routes/poker-tables.js";
import { createPreferenceRoutes } from "./routes/preferences.js";
import { createPrivacyRoutes } from "./routes/privacy.js";
import { createRoutineOfferRoutes } from "./routes/routine-offers.js";
import { createSeenRoutes } from "./routes/seen.js";
import { createTemplateRoutes } from "./routes/templates.js";
import { createTeamOfferRoutes } from "./routes/team-offers.js";

export type AppDeps = {
  readonly db: Db;
  readonly hub: PushHub;
  readonly agents: AgentHub;
  readonly toolCrypto: ToolCrypto;
  readonly groupTurns: GroupTurns;
  readonly notifications: NoticePublisher;
  readonly secureCookie: boolean;
  readonly pokerSeed?: () => string;
  readonly gateway: Omit<GatewayDeps, "db">;
  readonly platformAccounts: {
    readonly crypto: CredentialCrypto;
    readonly tokens: AccountTokens;
    readonly endpoints: OAuthEndpoints;
    readonly webBaseUrl: () => string;
  };
};

export type Env = { Variables: { user: User } };

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/api/register"]);
/** webhook 的 token 本身就是凭据，打这条的人手上没有会话。只豁免这一条路由，多一段路径都不算。 */
const PUBLIC_HOOK = /^\/api\/hooks\/[^/]+$/;

const NOT_FOUND = { error: "没有这个对象" } as const;
const UNAUTHORIZED = { error: "请先登录" } as const;
// 和 Web mock 的 404 文案一致，卡片上直接显示它。
const NO_ACCOUNT = { error: "没有这个账号" } as const;
const NO_DRAFT = { error: "没有这条草稿" } as const;
const NO_PLAN = { error: "没有这份计划" } as const;
/** 建、改名、复制、点存四条路撞的是同一个唯一索引，所以回的也是同一句话。 */
const NAME_TAKEN = { error: "这个 Bot 已经有同名的活了" } as const;

export function createApp(deps: AppDeps): Hono<Env> & { closeMcpClients(): Promise<void> } {
  const { agents, db, hub } = deps;
  const routineDeps = { db, push: hub, agents, groupTurns: deps.groupTurns, notifications: deps.notifications };
  const brandDeps = { db, push: hub, agents };
  const mcpClients = new McpClients();
  const app = Object.assign(new Hono<Env>(), { closeMcpClients: () => mcpClients.close() });

  const pushRoutines = async (ownerId: UserId, routineIds: readonly string[]): Promise<void> => {
    for (const routineId of routineIds) {
      const loaded = await loadRoutine(db, RoutineId.parse(routineId));
      if (loaded !== null) hub.push(ownerId, { type: "routine_updated", routine: loaded.routine });
    }
  };

  app.route(GATEWAY_PATH, createGateway({ db, ...deps.gateway }));
  app.route(MCP_PROXY_PATH, createMcpProxy({ db, crypto: deps.toolCrypto, clients: mcpClients }));
  const { platformAccounts } = deps;
  app.route(
    ACCOUNTS_PROXY_PATH,
    createAccountsProxy({
      db,
      push: hub,
      notifications: deps.notifications,
      agents,
      tokens: platformAccounts.tokens,
      endpoints: platformAccounts.endpoints,
    }),
  );

  app.use("/api/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path) || PUBLIC_HOOK.test(c.req.path)) return next();
    const token = getCookie(c, SESSION_COOKIE);
    const user = token === undefined ? null : await userForSession(db, token);
    if (user === null) return c.json(UNAUTHORIZED, 401);
    c.set("user", user);
    await next();
  });

  // 第 2 期的路由，都在登录中间件之后。
  app.route("/api", createGoalRoutes({ db, push: hub }));
  app.route("/api", createPreferenceRoutes({ db, push: hub, agents }));
  app.route("/api", createBrandRoutes(brandDeps));
  app.route("/api", createTeamOfferRoutes({ db, hub, agents }));
  app.route("/api", createRoutineOfferRoutes({ db, push: hub }));
  app.route("/api", createSeenRoutes({ db, push: hub }));
  app.route("/api", createPrivacyRoutes({ db, agents }));
  app.route("/api", createTemplateRoutes({ db, agents }));
  // 第 3 期牌桌的路由，同样在登录中间件之后。
  app.route("/api", createPokerTableRoutes({ db, push: hub, agents }));
  app.route(
    "/api",
    createPokerHandRoutes({ db, push: hub, agents, ...(deps.pokerSeed === undefined ? {} : { seed: deps.pokerSeed }) }),
  );
  app.route("/api", createPokerHintRoutes({ db, push: hub, agents }));
  app.route("/api", createPokerReviewRoutes({ db, push: hub, agents }));

  app.route(
    OAUTH_PATH,
    createOAuthRoutes({
      db,
      push: hub,
      agents,
      crypto: platformAccounts.crypto,
      endpoints: platformAccounts.endpoints,
      webBaseUrl: platformAccounts.webBaseUrl,
    }),
  );

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
    // 主助理之前注册的老用户在这里补上。他的电脑可能正在线，新 Bot 要进 config 才跑得起来。
    if ((await db.transaction((tx) => ensureAssistant(tx, user.id))) !== null) await agents.sendConfig(user.id);
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
      operations =
        body.value.localOnly === true
          ? await agents.discoverLocalTools(c.get("user").id, body.value)
          : await discoverTools(body.value);
    } catch (error) {
      if (!(error instanceof DiscoveryError)) throw error;
      return c.json({ error: error.message }, error.status);
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
    const { authorization } = body.value;
    let reauthorized: Reauthorized | undefined;
    if (authorization !== undefined) {
      // 换凭据当场重新探测一次：连不上就什么都不改，旧凭据和操作表照旧。null 是不带凭据探测。
      try {
        const input = {
          name: current.name,
          url: current.url,
          ...(authorization === null ? {} : { authorization }),
        };
        const discovered =
          (body.value.localOnly ?? current.localOnly)
            ? await agents.discoverLocalTools(c.get("user").id, input)
            : await discoverTools(input);
        reauthorized = {
          authorizationEnc: authorization === null ? null : deps.toolCrypto.encrypt(authorization),
          discovered,
        };
      } catch (error) {
        if (!(error instanceof DiscoveryError)) throw error;
        return c.json({ error: error.message }, error.status);
      }
    }
    const result = await updateTool(db, c.get("user").id, current, body.value, reauthorized);
    if (result.kind === "gone") return c.json(NOT_FOUND, 404);
    if (result.kind === "name_taken") return c.json({ error: "已有同名工具连接" }, 409);
    if (result.kind === "invalid_operation") return c.json({ error: "操作名不在这条工具连接上" }, 400);
    if (result.kind === "invalid_bot") return c.json({ error: "只能分配给自己的 Bot" }, 400);
    mcpClients.invalidate(current.id);
    await agents.sendConfig(c.get("user").id);
    return c.json(ToolResponse.parse({ tool: result.tool }));
  });

  app.delete("/api/tools/:id", async (c) => {
    const id = ToolConnectionId.safeParse(c.req.param("id"));
    if (!id.success || !(await deleteTool(db, c.get("user").id, id.data))) return c.json(NOT_FOUND, 404);
    mcpClients.invalidate(id.data);
    await agents.sendConfig(c.get("user").id);
    return c.body(null, 204);
  });

  app.get("/api/usage", async (c) =>
    c.json(UsageResponse.parse(await getUsage(db, c.get("user").id, { kind: "user" }))),
  );

  app.get("/api/today", async (c) =>
    c.json(TodayResponse.parse(await getToday(db, c.get("user").id, { kind: "user" }))),
  );

  app.get("/api/projects/:groupId", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("groupId"));
    const project = groupId.success ? await getProject(db, c.get("user").id, groupId.data, { kind: "user" }) : null;
    return project === null ? c.json(NOT_FOUND, 404) : c.json(ProjectResponse.parse(project));
  });

  app.get("/api/accounts", async (c) =>
    c.json(AccountListResponse.parse({ accounts: await listAccounts(db, c.get("user").id) })),
  );

  app.post("/api/accounts", async (c) => {
    const body = await readJson(c.req.raw, CreateAccountRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const ownerId = c.get("user").id;
    const result = await createPlaceholder(db, ownerId, body.value);
    if (result.kind === "no_computer") return c.json({ error: "没有这台电脑" }, 404);
    if (result.kind === "remote_computer") {
      return c.json({ error: "小红书要扫码登录，只能挂在你自己的电脑上，远程电脑没有助理浏览器" }, 400);
    }
    hub.push(ownerId, { type: "account_updated", account: result.account });
    await agents.sendConfig(ownerId);
    return c.json(AccountResponse.parse({ account: result.account }), result.kind === "created" ? 201 : 200);
  });

  app.post("/api/accounts/:id/login", async (c) => {
    const id = AccountId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NO_ACCOUNT, 404);
    const account = await findAccount(db, c.get("user").id, id.data);
    if (account === null) return c.json(NO_ACCOUNT, 404);
    const platform = BrowserPlatform.safeParse(account.platform);
    if (!platform.success) return c.json({ error: "这个平台不用登录窗口，走授权页登录" }, 400);
    const body = await readJson(c.req.raw, LoginAccountRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const { attempt } = body.value;
    if (!agents.canDeliver(account.computerId))
      return c.json({ error: "账号所在的电脑不在线，打开电脑上的白泽后再点登录" }, 409);
    const queued = await db.transaction((tx) =>
      enqueueDownlink(tx, account.computerId, {
        type: "browser_login",
        accountId: account.id,
        platform: platform.data,
        attempt,
      }),
    );
    if (!queued) return c.json({ error: "账号所在的电脑不在线，打开电脑上的白泽后再点登录" }, 409);
    await agents.flushOutbox(account.computerId);
    return c.json(LoginAccountResponse.parse({ account, attempt }), 202);
  });

  app.patch("/api/accounts/:id", async (c) => {
    const id = AccountId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NO_ACCOUNT, 404);
    const body = await readJson(c.req.raw, UpdateAccountRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const ownerId = c.get("user").id;
    const result = await setAccountTier(db, ownerId, id.data, body.value.tier);
    if (result.kind === "not_found") return c.json(NO_ACCOUNT, 404);
    if (result.kind === "not_allowed") return c.json({ error: "小红书账号不能设成可直接发布" }, 400);
    hub.push(ownerId, { type: "account_updated", account: result.account });
    // 档位随 config.accounts 下发，运行器按它决定 Bot 能不能起草、能不能直接发。
    await agents.sendConfig(ownerId);
    return c.json(AccountResponse.parse({ account: result.account }));
  });

  app.post("/api/drafts/:id", async (c) => {
    const id = DraftId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NO_DRAFT, 404);
    const body = await readJson(c.req.raw, DecideDraftRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const ownerId = c.get("user").id;
    const decided = await decideDraft(db, ownerId, id.data, body.value);
    if (decided.kind === "not_found") return c.json(NO_DRAFT, 404);
    if (decided.kind === "already_decided") return c.json({ error: "这条草稿已经有结论了" }, 409);
    if (decided.kind === "invalid") return c.json({ error: decided.error }, 400);
    const { draft, brand } = decided.value;
    hub.push(ownerId, { type: "draft_updated", draft });
    if (brand !== null) await announceBrand(brandDeps, ownerId, brand);
    return c.json(DecideDraftResponse.parse({ draft }));
  });

  app.post("/api/plans/:id/approve", async (c) => {
    const id = ContentPlanId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NO_PLAN, 404);
    const body = await readJson(c.req.raw, ApprovePlanRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const ownerId = c.get("user").id;
    const decided = await approvePlan(db, ownerId, id.data, body.value.edits);
    if (decided.kind === "not_found") return c.json(NO_PLAN, 404);
    if (decided.kind === "already_decided") return c.json({ error: "这份计划已经有结论了" }, 409);
    if (decided.kind === "invalid") return c.json({ error: decided.error }, 400);
    const { plan, drafts, brand } = decided.value;
    hub.push(ownerId, { type: "plan_updated", plan });
    for (const draft of drafts) hub.push(ownerId, { type: "draft_updated", draft });
    if (brand !== null) await announceBrand(brandDeps, ownerId, brand);
    return c.json(ApprovePlanResponse.parse({ plan, drafts }));
  });

  app.post("/api/plans/:id/return", async (c) => {
    const id = ContentPlanId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NO_PLAN, 404);
    const ownerId = c.get("user").id;
    const decided = await returnPlan(db, ownerId, id.data);
    if (decided.kind === "not_found") return c.json(NO_PLAN, 404);
    if (decided.kind === "already_decided") return c.json({ error: "这份计划已经有结论了" }, 409);
    if (decided.kind === "invalid") return c.json({ error: decided.error }, 400);
    hub.push(ownerId, { type: "plan_updated", plan: decided.value.plan });
    for (const draft of decided.value.drafts) hub.push(ownerId, { type: "draft_updated", draft });
    return c.json(ReturnPlanResponse.parse({ plan: decided.value.plan }));
  });

  app.get("/api/computers", async (c) =>
    c.json(ComputerListResponse.parse({ computers: await listComputers(db, c.get("user").id) })),
  );

  app.post("/api/computers/local", async (c) => {
    let raw: unknown;
    try {
      const text = await c.req.text();
      raw = text === "" ? {} : JSON.parse(text);
    } catch {
      return c.json({ error: "请求体不是合法 JSON" }, 400);
    }
    const body = PairLocalComputerRequest.partial().safeParse(raw);
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "请求体不合法" }, 400);
    const ownerId = c.get("user").id;
    const { computer } = await ensureComputer(db, ownerId);
    if ((computer.lastSeenAt !== null || agents.isOnline(computer.id)) && !body.data.confirmDisplace) {
      return c.json(
        PairLocalConflictResponse.parse({ error: "这个账号已经在另一台 Mac 上用过，继续会让那台退出", computer }),
        409,
      );
    }
    const local = await resetComputerToken(db, ownerId);
    if (local === null) throw new Error(`用户 ${ownerId} 的本机电脑既没建成也无法重置 token`);
    hub.push(ownerId, { type: "computer_updated", computer });
    await agents.displaceComputer(computer.id);
    return c.json(ComputerTokenResponse.parse(local));
  });

  app.post("/api/computers/remote", async (c) => {
    const ownerId = c.get("user").id;
    const { computer } = await ensureComputer(db, ownerId, "remote");
    const remote = await resetComputerToken(db, ownerId, "remote");
    if (remote === null) throw new Error(`用户 ${ownerId} 的远程电脑既没建成也无法重置 token`);
    hub.push(ownerId, { type: "computer_updated", computer });
    return c.json(ComputerTokenResponse.parse(remote));
  });

  app.get("/api/bots", async (c) => {
    // 牌友和老白只在牌桌里露面，不进队伍页；它们在 config 里照带，运行器靠那里找到自己。
    const items = (await listBots(db, c.get("user").id)).filter((item) => !TABLE_ROLES.includes(item.bot.role));
    return c.json(BotListResponse.parse({ items }));
  });

  app.post("/api/bots", async (c) => {
    const body = await readJson(c.req.raw, CreateBotRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const created = await createBot(db, c.get("user").id, body.value);
    if (created === null) return c.json(UNAUTHORIZED, 401);
    await agents.sendConfig(c.get("user").id);
    return c.json(CreateBotResponse.parse(created), 201);
  });

  app.patch("/api/bots/:id", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, UpdateBotRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const current = await findBot(db, c.get("user").id, botId.data);
    if (current !== null && TABLE_ROLES.includes(current.role)) {
      return c.json({ error: "牌桌里的牌友和老白不能改，要换人去牌桌里换座位" }, 409);
    }
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
    if (deleted.kind === "not_found") return c.json(NOT_FOUND, 404);
    if (deleted.kind === "assistant") return c.json({ error: "主助理不能删，你在首页说的话都由它来接" }, 409);
    await agents.sendConfig(c.get("user").id);
    // 多 Bot 群里那张卡还在，先把它推成终态，客户端才不会留一张点了没反应的卡。
    for (const approval of deleted.expired) hub.push(c.get("user").id, { type: "approval_updated", approval });
    hub.push(c.get("user").id, { type: "bot_deleted", botId: botId.data });
    // 转走的例行里刚被收成 failed 的记录也算一次没人看的收尾，和别的收尾一样过三次自停再推快照。
    for (const routineId of deleted.movedRoutineIds) await pushRoutineUpdated(routineDeps, routineId);
    // 补进主助理、卸了首席的项目群推整份快照，在线的项目页才换得掉成员名单。
    for (const groupId of deleted.changedGroupIds) {
      const detail = await findGroup(db, c.get("user").id, GroupId.parse(groupId));
      if (detail !== null) hub.push(c.get("user").id, { type: "group_updated", group: detail.group });
    }
    await deps.groupTurns.botDeleted(c.get("user").id, botId.data);
    return c.body(null, 204);
  });

  for (const [path, runState] of [
    ["pause", "paused"],
    ["resume", "running"],
  ] as const) {
    app.post(`/api/bots/:id/${path}`, async (c) => {
      const botId = BotId.safeParse(c.req.param("id"));
      if (!botId.success) return c.json(NOT_FOUND, 404);
      const bot = await setRunState(db, c.get("user").id, botId.data, runState);
      if (bot === null) return c.json(NOT_FOUND, 404);
      agents.sendToOwner(c.get("user").id, { type: path, botId: bot.id });
      hub.push(c.get("user").id, { type: "bot_updated", bot });
      return c.json(BotResponse.parse({ bot }));
    });
  }

  app.get("/api/routines", async (c) =>
    c.json(RoutineListResponse.parse({ items: await listOwnerRoutines(db, c.get("user").id) })),
  );

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
    const groupId = body.value.groupId ?? null;
    if (groupId !== null) {
      const target = await findGroup(db, c.get("user").id, groupId);
      if (target === null) return c.json(NOT_FOUND, 404);
      if (!target.group.botIds.includes(botId.data)) return c.json({ error: "这个 Bot 不在那个群里" }, 400);
    }
    const routine = await createRoutine(db, c.get("user").id, botId.data, body.value);
    // 预检之后 Bot 被删完了，和一开始就不存在一样回 404。
    if (routine === null) return c.json(NOT_FOUND, 404);
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
    const routine = await runRoutine(routineDeps, owned.ownerId, owned.row, new Date(), "trial");
    if (routine === null) return c.json(NOT_FOUND, 404);
    return c.json(RoutineResponse.parse({ routine }), 202);
  });

  app.post("/api/hooks/:token", async (c) => {
    const owned = await findRoutineByWebhookToken(db, c.req.param("token"));
    if (owned === null) return c.json(NOT_FOUND, 404);
    if (owned.row.state !== "on") return c.json({ error: "这条例行任务已停用" }, 409);
    if ((await runRoutine(routineDeps, owned.ownerId, owned.row, new Date(), "webhook")) === null) {
      return c.json(NOT_FOUND, 404);
    }
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

  app.get("/api/messages/:id", async (c) => {
    const messageId = MessageId.safeParse(c.req.param("id"));
    if (!messageId.success) return c.json(NOT_FOUND, 404);
    const message = await findOwnedMessage(db, c.get("user").id, messageId.data, { kind: "user" });
    if (message === null) return c.json(NOT_FOUND, 404);
    return c.json(MessageResponse.parse({ message }));
  });

  app.post("/api/messages/:id/skill-offer", async (c) => {
    const messageId = MessageId.safeParse(c.req.param("id"));
    if (!messageId.success) return c.json(NOT_FOUND, 404);
    // 别人的消息、不存在的消息、正文不是这张卡的消息，在这里都是 null，一律 404。
    const offer = await findOwnedSkillOfferMessage(db, c.get("user").id, messageId.data, { kind: "user" });
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

  app.post("/api/messages/:id/preference-offer", async (c) => {
    const messageId = MessageId.safeParse(c.req.param("id"));
    if (!messageId.success) return c.json(NOT_FOUND, 404);
    const ownerId = c.get("user").id;
    const offer = await findOwnedPreferenceOffer(db, ownerId, messageId.data, { kind: "user" });
    if (offer === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, DecidePreferenceOfferRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);

    const decided = await decidePreferenceOffer(db, ownerId, offer, body.value.decision);
    if (decided.kind === "bot_gone") return c.json(NOT_FOUND, 404);
    if (decided.kind === "already_decided") return c.json({ error: "这条卡已经有结论了" }, 409);

    hub.push(ownerId, { type: "message", message: decided.message });
    if (decided.preference !== null) {
      hub.push(ownerId, { type: "preference_updated", preference: decided.preference });
      await agents.sendConfig(ownerId);
    }
    return c.json(DecidePreferenceOfferResponse.parse({ message: decided.message, preference: decided.preference }));
  });

  app.post("/api/messages/:id/project-offer", async (c) => {
    const messageId = MessageId.safeParse(c.req.param("id"));
    if (!messageId.success) return c.json(NOT_FOUND, 404);
    const ownerId = c.get("user").id;
    const offer = await findOwnedProjectOffer(db, ownerId, messageId.data, { kind: "user" });
    if (offer === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, DecideProjectOfferRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);

    const decided = await decideProjectOffer(db, ownerId, offer, body.value);
    if (decided.kind === "gone") return c.json(NOT_FOUND, 404);
    // 已经有结论的卡回它现在的样子，不算错：点两次开始的人要的就是那个项目。
    if (decided.kind === "settled") {
      const { project } = decided;
      return c.json(
        DecideProjectOfferResponse.parse({
          message: decided.message,
          group: project?.group ?? null,
          task: project?.task ?? null,
        }),
      );
    }
    hub.push(ownerId, { type: "message", message: decided.message });
    if (decided.kind === "dismissed") {
      return c.json(DecideProjectOfferResponse.parse({ message: decided.message, group: null, task: null }));
    }
    // 队员先到，Web 画新群时才认得每个人，不会显示成「Bot」。同一事务建出的队员 createdAt 相同，按群里的顺序推。
    // bot_created 带单聊群 id，Web 不用再拉 Bot 列表才认得新队员的单聊。
    const owned = new Map((await listBots(db, ownerId)).map((entry) => [entry.bot.id, entry]));
    for (const botId of decided.group.botIds) {
      const entry = owned.get(botId);
      if (entry !== undefined && botId !== decided.group.chiefBotId) {
        hub.push(ownerId, { type: "bot_created", bot: entry.bot, groupId: entry.groupId });
      }
    }
    hub.push(ownerId, { type: "group_created", group: decided.group, task: decided.task });
    for (const routine of decided.routines) hub.push(ownerId, { type: "routine_updated", routine });
    // 新队员要进 config 才跑得起来。
    await agents.sendConfig(ownerId);
    return c.json(
      DecideProjectOfferResponse.parse({ message: decided.message, group: decided.group, task: decided.task }),
    );
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
    const owned = await findLiveGroupId(db, c.get("user").id, groupId.data);
    if (owned === null) return c.json(NOT_FOUND, 404);

    const query = MessageQuery.safeParse({
      before: c.req.query("before"),
      limit: c.req.query("limit"),
    });
    if (!query.success) return c.json({ error: "查询参数不合法" }, 400);

    const result = await listMessages(
      db,
      owned,
      { kind: "user" },
      {
        before: query.data.before,
        limit: query.data.limit,
      },
    );
    if (result.kind === "unknown_cursor") return c.json(NOT_FOUND, 404);

    const approvalIds = result.page.messages.flatMap((m) => (m.body.kind === "approval" ? [m.body.approvalId] : []));
    const approvals = await listApprovals(db, approvalIds);
    const handoffIds = result.page.messages.flatMap((m) => (m.body.kind === "handoff" ? [m.body.handoffId] : []));
    const handoffs = await listHandoffs(db, handoffIds);
    const ownerId = c.get("user").id;
    const draftIds = result.page.messages.flatMap((m) => (m.body.kind === "draft" ? [m.body.draftId] : []));
    const planIds = result.page.messages.flatMap((m) => (m.body.kind === "plan" ? [m.body.planId] : []));
    const [drafts, plans, publications] = await Promise.all([
      listDraftsForPage(db, ownerId, draftIds, planIds),
      listPlansForPage(db, ownerId, planIds),
      listPublicationsForPage(db, ownerId, draftIds, planIds),
    ]);
    return c.json(MessageListResponse.parse({ ...result.page, approvals, handoffs, drafts, plans, publications }));
  });

  app.post("/api/groups/:id/messages", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("id"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const owned = await findLiveGroupId(db, c.get("user").id, groupId.data);
    if (owned === null) return c.json(NOT_FOUND, 404);
    // 牌桌群里不能发普通消息，只能按按钮出牌。
    try {
      await assertNotTable(db, owned);
    } catch (error) {
      if (error instanceof TableGroupError) return c.json({ error: error.message }, 409);
      throw error;
    }
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
    const owned = await findApprovalId(db, c.get("user").id, approvalId.data, { kind: "user" });
    if (owned === null) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, DecideApprovalRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);

    const settled = await settleApproval({ db, push: hub, agents }, c.get("user").id, owned, body.value);
    if (settled.kind === "already_decided")
      return c.json({ error: "这条审批已经有结论了", approval: settled.approval }, 409);
    if (settled.kind === "scope_not_allowed") return c.json({ error: settled.error }, 400);
    return c.json(DecideApprovalResponse.parse({ approval: settled.approval, grant: settled.grant }));
  });

  app.get("/api/grants", async (c) => {
    return c.json(GrantListResponse.parse({ grants: await listGrants(db, c.get("user").id) }));
  });

  app.delete("/api/grants/:id", async (c) => {
    const grantId = GrantId.safeParse(c.req.param("id"));
    if (!grantId.success) return c.json(NOT_FOUND, 404);
    if (!(await deleteGrant(db, c.get("user").id, grantId.data))) return c.json(NOT_FOUND, 404);
    hub.push(c.get("user").id, { type: "grant_deleted", grantId: grantId.data });
    await agents.sendConfig(c.get("user").id);
    return c.body(null, 204);
  });

  app.patch("/api/tasks/:id", async (c) => {
    const taskId = TaskId.safeParse(c.req.param("id"));
    if (!taskId.success) return c.json(NOT_FOUND, 404);
    const body = await readJson(c.req.raw, UpdateTaskRequest);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const updated = await updateTask(db, c.get("user").id, taskId.data, body.value);
    if (updated === null) return c.json(NOT_FOUND, 404);
    hub.push(c.get("user").id, { type: "task_updated", task: updated.task });
    await pushRoutines(c.get("user").id, updated.pausedRoutineIds);
    return c.json(UpdateTaskResponse.parse({ task: updated.task }));
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
