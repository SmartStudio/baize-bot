import { randomUUID } from "node:crypto";
import {
  AccountId,
  AccountListResponse,
  AccountResponse,
  ComputerTokenResponse,
  CreateBotResponse,
  DraftId,
  LoginAccountResponse,
  LoginAttemptId,
  MessageListResponse,
  TodayResponse,
  type Account,
  type ComputerId,
  type ServerPush,
  type UserId,
} from "@baize/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { accounts } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;
const cleanups: (() => void)[] = [];

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly userId: UserId;
  readonly client: ApiClient;
  readonly local: TestComputer;
  readonly push: PushClient;
};

async function makeOwner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const local = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const push = await connectPush(server.server.port, client.cookie ?? "");
  cleanups.push(() => push.close());
  return { userId: user.id, client, local, push };
}

async function online(computer: TestComputer): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, computer.computerId, computer.token);
  cleanups.push(() => agent.close());
  return agent;
}

async function remoteOf(owner: Owner): Promise<TestComputer> {
  return ComputerTokenResponse.parse(await (await owner.client.post("/api/computers/remote")).json());
}

/** 电脑上下线的推送和这里要看的事无关，跳过。 */
async function nextPush<T extends ServerPush["type"]>(
  push: PushClient,
  type: T,
): Promise<Extract<ServerPush, { type: T }>> {
  for (;;) {
    const next = await push.next();
    if (next.type === "computer_updated") continue;
    if (next.type !== type) throw new Error(`本应推 ${type}，实际是 ${JSON.stringify(next)}`);
    return next as Extract<ServerPush, { type: T }>;
  }
}

/** 收推送直到 until 命中，连命中那条一起返回。电脑上下线的推送跳过。 */
async function pushesUntil(push: PushClient, until: (pushed: ServerPush) => boolean): Promise<ServerPush[]> {
  const seen: ServerPush[] = [];
  for (;;) {
    const next = await push.next();
    if (next.type === "computer_updated") continue;
    seen.push(next);
    if (until(next)) return seen;
  }
}

async function addXiaohongshu(owner: Owner, computerId: ComputerId = owner.local.computerId): Promise<Response> {
  return owner.client.post("/api/accounts", { platform: "xiaohongshu", computerId });
}

async function placeholder(owner: Owner): Promise<Account> {
  const response = await addXiaohongshu(owner);
  expect(response.status).toBe(201);
  const { account } = AccountResponse.parse(await response.json());
  expect(await nextPush(owner.push, "account_updated")).toEqual({ type: "account_updated", account });
  return account;
}

async function listed(owner: Owner): Promise<Account[]> {
  return AccountListResponse.parse(await (await owner.client.get("/api/accounts")).json()).accounts;
}

async function insertAccount(
  owner: Owner,
  input: { computerId: ComputerId; handle: string; createdAt?: Date },
): Promise<AccountId> {
  const accountId = AccountId.parse(newId());
  await database.db.insert(accounts).values({
    id: accountId,
    ownerId: owner.userId,
    computerId: input.computerId,
    platform: "xiaohongshu",
    handle: input.handle,
    login: "valid",
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt, loginChangedAt: input.createdAt }),
  });
  return accountId;
}

describe("加账号", () => {
  it("加小红书账号建出未登录占位，重复加回同一行", async () => {
    const owner = await makeOwner();
    const agent = await online(owner.local);

    const account = await placeholder(owner);
    expect(account, "未登录占位：没有名字，发布要确认").toMatchObject({
      platform: "xiaohongshu",
      computerId: owner.local.computerId,
      handle: null,
      login: "none",
      tier: "confirm_publish",
    });
    expect(account.loginChangedAt, "占位建出来那一刻就是登录状态的起点").toBe(account.createdAt);
    const config = await agent.expect("config");
    expect(config.accounts, "建完给电脑重发 config，带上这个占位").toEqual([
      { id: account.id, platform: "xiaohongshu", handle: null, tier: "confirm_publish", login: "none" },
    ]);

    const again = await addXiaohongshu(owner);
    expect(again.status, "已经有占位，回已有那行，不算新建").toBe(200);
    expect(AccountResponse.parse(await again.json()).account.id).toBe(account.id);
    expect(
      (await listed(owner)).map((one) => one.id),
      "一个人每个平台最多一个未登录占位",
    ).toEqual([account.id]);
  });

  it("小红书账号挂不到远程电脑", async () => {
    const owner = await makeOwner();
    const remote = await remoteOf(owner);

    const response = await addXiaohongshu(owner, remote.computerId);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("自己的电脑");
    expect(await listed(owner), "拒绝时不留占位").toEqual([]);

    const stranger = await makeOwner();
    expect((await addXiaohongshu(owner, stranger.local.computerId)).status, "别人的电脑不能挂").toBe(404);
  });
});

describe("打开登录窗口", () => {
  it("账号所在电脑收到 browser_login，别的电脑收不到", async () => {
    const owner = await makeOwner();
    const remote = await remoteOf(owner);
    const local = await online(owner.local);
    const other = await online(remote);
    const account = await placeholder(owner);
    await local.expect("config");
    await other.expect("config");

    const attempt = LoginAttemptId.parse(newId());
    const response = await owner.client.post(`/api/accounts/${account.id}/login`, { attempt });
    expect(response.status, "立刻回，登录结果随推送回来").toBe(202);
    const accepted = LoginAccountResponse.parse(await response.json());
    expect(accepted.account).toEqual(account);
    expect(accepted.attempt, "202 带回页面自己取的号").toBe(attempt);
    expect(await local.expect("browser_login"), "电脑拿到的尝试号就是页面取的那个，控制面不另发").toEqual({
      type: "browser_login",
      accountId: account.id,
      platform: "xiaohongshu",
      attempt,
    });

    // 改档会给两台电脑都重发 config：远程电脑下一条收到的是它，说明登录那条没发给它。
    expect((await owner.client.patch(`/api/accounts/${account.id}`, { tier: "draft" })).status).toBe(200);
    expect((await other.next()).type, "远程电脑没收到 browser_login").toBe("config");
  });

  it("请求体缺尝试号或格式不对回 400，电脑什么都收不到", async () => {
    const owner = await makeOwner();
    const local = await online(owner.local);
    const account = await placeholder(owner);
    await local.expect("config");

    expect((await owner.client.post(`/api/accounts/${account.id}/login`, {})).status, "缺 attempt").toBe(400);
    expect((await owner.client.post(`/api/accounts/${account.id}/login`, { attempt: "" })).status, "空串").toBe(400);
    expect(
      (await owner.client.post(`/api/accounts/${account.id}/login`, { attempt: "有 空格/斜杠" })).status,
      "不是安全的 id 字符",
    ).toBe(400);
    expect(
      (await owner.client.post(`/api/accounts/${account.id}/login`, { attempt: "a".repeat(65) })).status,
      "超长",
    ).toBe(400);

    // 改档会重发 config：电脑下一条收到的是它，说明前面几次都没发 browser_login。
    expect((await owner.client.patch(`/api/accounts/${account.id}`, { tier: "draft" })).status).toBe(200);
    expect((await local.next()).type).toBe("config");
  });

  it("电脑不在线回 409", async () => {
    const owner = await makeOwner();
    const account = await placeholder(owner);
    const attempt = LoginAttemptId.parse(newId());

    const offline = await owner.client.post(`/api/accounts/${account.id}/login`, { attempt });
    expect(offline.status).toBe(409);
    expect(((await offline.json()) as { error: string }).error).toContain("不在线");

    const agent = await online(owner.local);
    expect(
      (await owner.client.post(`/api/accounts/${account.id}/login`, { attempt })).status,
      "电脑上线后同一个账号能登",
    ).toBe(202);
    expect((await agent.expect("browser_login")).accountId).toBe(account.id);
  });

  it("别人的账号回 404", async () => {
    const owner = await makeOwner();
    const stranger = await makeOwner();
    await online(owner.local);
    const account = await placeholder(owner);

    const attempt = LoginAttemptId.parse(newId());
    expect((await stranger.client.post(`/api/accounts/${account.id}/login`, { attempt })).status).toBe(404);
    expect((await stranger.client.post("/api/accounts/不是账号/login", { attempt })).status).toBe(404);
  });
});

describe("login_state valid 和 expired", () => {
  it("扫码回 valid，账号已登录带 handle，config 重发带上它", async () => {
    const owner = await makeOwner();
    const agent = await online(owner.local);
    const account = await placeholder(owner);
    await agent.expect("config");

    agent.send({ type: "login_state", accountId: account.id, state: { login: "valid", handle: "白泽工厂日记" } });

    const updated = (await nextPush(owner.push, "account_updated")).account;
    expect(updated).toMatchObject({ id: account.id, login: "valid", handle: "白泽工厂日记" });
    expect(Date.parse(updated.loginChangedAt), "登录状态变了，时刻跟着写").toBeGreaterThanOrEqual(
      Date.parse(account.loginChangedAt),
    );
    const config = await agent.expect("config");
    expect(config.accounts).toEqual([
      { id: account.id, platform: "xiaohongshu", handle: "白泽工厂日记", tier: "confirm_publish", login: "valid" },
    ]);
    expect(await listed(owner)).toEqual([updated]);
  });

  it("过期重登更新原来那行，不多出一行", async () => {
    const owner = await makeOwner();
    const agent = await online(owner.local);
    const first = await placeholder(owner);
    await agent.expect("config");
    agent.send({ type: "login_state", accountId: first.id, state: { login: "valid", handle: "白泽工厂日记" } });
    await nextPush(owner.push, "account_updated");
    await agent.expect("config");

    agent.send({ type: "login_state", accountId: first.id, state: { login: "expired" } });
    expect((await nextPush(owner.push, "account_updated")).account.login).toBe("expired");
    const notice = (await nextPush(owner.push, "notify")).notice;
    expect(notice.kind, "过期是没办成要用户处理，不走电脑掉线的 stuck").toBe("failed");
    expect(notice.text).toContain("白泽工厂日记");
    expect(notice.text).toContain("重新登录");
    await agent.expect("config");

    // 用户在账号页又点了一次「加小红书」，扫的还是同一个号。
    const second = await placeholder(owner);
    expect(second.id, "原来那行已经不是占位，新建一个").not.toBe(first.id);
    await agent.expect("config");
    // 扫码之前 Bot 已经往这个占位上起了一稿。
    const bot = CreateBotResponse.parse(await (await owner.client.post("/api/bots", { name: "小内" })).json());
    expect((await owner.client.post(`/api/groups/${bot.group.id}/messages`, { text: "起一稿" })).status).toBe(201);
    let prompt = await agent.next();
    while (prompt.type !== "prompt") prompt = await agent.next();
    const draftId = DraftId.parse(randomUUID());
    agent.send({
      type: "draft_create",
      runId: prompt.runId,
      botId: bot.bot.id,
      groupId: bot.group.id,
      draft: {
        draftId,
        accountId: second.id,
        content: { kind: "post", title: "占位上的稿", text: "占位上的稿", images: [], github: null },
        scheduledAt: null,
      },
    });
    await pushesUntil(owner.push, (pushed) => pushed.type === "draft_updated" && pushed.draft.id === draftId);
    await nextPush(owner.push, "message");
    agent.send({ type: "login_state", accountId: second.id, state: { login: "valid", handle: "白泽工厂日记" } });

    expect(await nextPush(owner.push, "account_deleted"), "占位并进原来那行").toEqual({
      type: "account_deleted",
      accountId: second.id,
    });
    const revived = (await nextPush(owner.push, "account_updated")).account;
    expect(revived).toMatchObject({ id: first.id, login: "valid", handle: "白泽工厂日记" });
    expect(await listed(owner), "同一台电脑同一个号只有一行").toEqual([revived]);
    expect((await agent.expect("config")).accounts.map((one) => one.id)).toEqual([first.id]);
    const page = MessageListResponse.parse(
      await (await owner.client.get(`/api/groups/${bot.group.id}/messages`)).json(),
    );
    expect(page.drafts.find((one) => one.id === draftId)?.accountId, "占位上的稿跟着并到原来那行").toBe(first.id);
  });

  it("重复报 expired 不重复通知，过期时刻不变", async () => {
    const owner = await makeOwner();
    const agent = await online(owner.local);
    const accountId = await insertAccount(owner, { computerId: owner.local.computerId, handle: "白泽工厂日记" });

    agent.send({ type: "login_state", accountId, state: { login: "expired" } });
    const expired = (await nextPush(owner.push, "account_updated")).account;
    expect(expired.login).toBe("expired");
    await nextPush(owner.push, "notify");
    await agent.expect("config");

    agent.send({ type: "login_state", accountId, state: { login: "expired" } });
    agent.send({
      type: "login_state",
      accountId,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
    });
    const seen = await pushesUntil(owner.push, (pushed) => pushed.type === "notify");
    expect(
      seen.map((pushed) => pushed.type),
      "第二次 expired 什么都不推，下一条就是登录窗口那次失败",
    ).toEqual(["login_failed", "notify"]);
    expect(seen[1]?.type === "notify" && seen[1].notice.text).toContain("登录窗口");
    const [after] = await listed(owner);
    expect(after, "重复报过期不改过期时刻").toEqual(expired);
  });

  it("另一台电脑报这个账号 expired，账号不变", async () => {
    const owner = await makeOwner();
    const onLocal = await insertAccount(owner, { computerId: owner.local.computerId, handle: "白泽工厂日记" });
    const remote = await remoteOf(owner);
    const onRemote = await insertAccount(owner, { computerId: remote.computerId, handle: "远程号" });
    const agent = await online(remote);

    agent.send({ type: "login_state", accountId: onLocal, state: { login: "expired" } });
    agent.send({
      type: "login_state",
      accountId: onRemote,
      state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
    });

    const seen = await pushesUntil(owner.push, (pushed) => pushed.type === "notify");
    expect(
      seen.map((pushed) => pushed.type),
      "本机账号那条整条丢掉，没推账号也没推通知",
    ).toEqual(["login_failed", "notify"]);
    expect(seen[1]?.type === "notify" && seen[1].notice.text).toContain("登录窗口");
    expect((await listed(owner)).find((one) => one.id === onLocal)?.login).toBe("valid");
  });

  it("今天页过期账号的时间是记过期的那一刻", async () => {
    const owner = await makeOwner();
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const accountId = await insertAccount(owner, {
      computerId: owner.local.computerId,
      handle: "白泽工厂日记",
      createdAt: longAgo,
    });
    const agent = await online(owner.local);
    const before = Date.now();

    agent.send({ type: "login_state", accountId, state: { login: "expired" } });
    const expired = (await nextPush(owner.push, "account_updated")).account;

    const today = TodayResponse.parse(await (await owner.client.get("/api/today")).json());
    const card = today.pending.find((item) => item.kind === "account");
    expect(card?.kind === "account" && card.account.id).toBe(accountId);
    expect(card?.since, "账号三天前就挂上了，卡上写的是刚才过期的那一刻").toBe(expired.loginChangedAt);
    expect(Date.parse(card?.since ?? "")).toBeGreaterThanOrEqual(before);
  });
});
