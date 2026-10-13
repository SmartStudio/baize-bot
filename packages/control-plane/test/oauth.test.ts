import { createHash } from "node:crypto";
import { format } from "node:util";
import {
  AccountListResponse,
  ComputerTokenResponse,
  DecideDraftResponse,
  LoginAttemptId,
  type Account,
  type AccountId,
  type Notice,
  type OAuthPlatform,
} from "@baize/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountTokens, CredentialCrypto, addAccountWithToken } from "../src/credentials.js";
import { accountCredentials, accounts as accountRows, drafts, oauthStates, toolConnections } from "../src/db/schema.js";
import type { RequestMatch } from "../src/fake-platforms.js";
import { newId } from "../src/ids.js";
import { markLoginExpired } from "../src/repo/accounts.js";
import { pruneOverflow } from "../src/repo/oauth-states.js";
import { TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { contentJob, createDraft, issuePost, nextOf, specOf } from "./helpers/content.js";
import { makeUser, waitFor } from "./helpers/fixtures.js";
import {
  LONG_LIFETIME_S,
  SHORT_LIFETIME_S,
  GITHUB_APP,
  X_APP,
  browse,
  connectPlatform,
  makeOwner,
  oauthStack,
  proxyFetch,
  redirectOf,
  type OAuthStack,
  type Owner,
} from "./helpers/oauth.js";
import type { PushClient } from "./helpers/ws.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function stack(...options: Parameters<typeof oauthStack>): Promise<OAuthStack> {
  const s = await oauthStack(...options);
  cleanups.push(() => s.close());
  return s;
}

async function owner(s: OAuthStack, remote: boolean): Promise<Owner> {
  const o = await makeOwner(s, { remote });
  cleanups.push(() => o.close());
  return o;
}

async function accountsOf(o: Owner): Promise<readonly Account[]> {
  const response = await o.client.get("/api/accounts");
  expect(response.status).toBe(200);
  return AccountListResponse.parse(await response.json()).accounts;
}

/** 授权完成的那一下：页面收到账号，电脑收到新 config。 */
async function connected(o: Owner): Promise<Account> {
  const { account } = await nextOf(o.push, "account_updated");
  const config = await o.agent.expect("config");
  expect(
    config.accounts.find((one) => one.id === account.id),
    "挂上的账号随 config 下发给电脑",
  ).toMatchObject({ platform: account.platform, handle: account.handle, login: "valid" });
  return account;
}

async function nextNotice(push: PushClient): Promise<Notice> {
  for (;;) {
    const pushed = await push.next();
    if (pushed.type === "notify") return pushed.notice;
  }
}

const tokenRequests = (s: OAuthStack) =>
  s.fake.requests().filter((request) => /\/(login\/oauth\/access_token|2\/oauth2\/token)$/.test(request.path));
const field = (body: unknown, key: string): unknown => (body as Record<string, unknown> | null)?.[key];
const isRefresh: RequestMatch = (request) => field(request.body, "grant_type") === "refresh_token";
const isRead: RequestMatch = (request) => request.method === "GET";
const isIssuePost: RequestMatch = (request) => request.method === "POST" && request.path === "/repos/baize/demo/issues";
const refreshes = (s: OAuthStack) => tokenRequests(s).filter(isRefresh);
const WHOAMI: Record<OAuthPlatform, string> = { github: "/user", x: "/2/users/me" };
/** X 对撤销或用过的刷新令牌实际回的描述，见 xdevplatform/twitter-api-typescript-sdk#54。 */
const X_DEAD_TOKEN = "Value passed for the token was invalid.";

async function credentialsOf(s: OAuthStack, accountId: AccountId) {
  const [row] = await s.database.db
    .select()
    .from(accountCredentials)
    .where(eq(accountCredentials.accountId, accountId));
  return row;
}

function captureErrors(): string[] {
  const logged: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(format(...args));
  });
  cleanups.push(() => {
    vi.restoreAllMocks();
  });
  return logged;
}

/** 等数据库里有这么多个连接卡在锁上。 */
async function lockWaiters(s: OAuthStack, count: number, what: string): Promise<void> {
  await waitFor(async () => {
    const [row] = await s.database.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = ${s.database.databaseName} AND wait_event_type = 'Lock'`;
    return (row?.count ?? 0) >= count;
  }, what);
}

/**
 * 在库里放一个钩子：命中触发器的那条语句停在钩子上，直到测试放行。停着的连接在 lockWaiters 里算一个。
 * 放行之后钩子还在，后来的语句直接过。
 */
async function dbHold(s: OAuthStack, key: number, trigger: string): Promise<() => Promise<void>> {
  const gate = await s.database.sql.reserve();
  cleanups.push(async () => {
    await gate`SELECT pg_advisory_unlock_all()`;
    gate.release();
  });
  await gate`SELECT pg_advisory_lock(${key})`;
  await s.database.sql.unsafe(`
    CREATE FUNCTION test_hold_${key}() RETURNS trigger AS $$
    BEGIN PERFORM pg_advisory_lock(${key}); PERFORM pg_advisory_unlock(${key}); RETURN NEW; END;
    $$ LANGUAGE plpgsql`);
  await s.database.sql.unsafe(`CREATE TRIGGER test_hold_${key} ${trigger} EXECUTE FUNCTION test_hold_${key}()`);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await gate`SELECT pg_advisory_unlock(${key})`;
  };
}

/** 账号被记过期的那条 UPDATE 停在写入前：这时过期事务已经锁住账号行。 */
const holdExpiry = (s: OAuthStack) =>
  dbHold(s, 7102, "BEFORE UPDATE ON accounts FOR EACH ROW WHEN (NEW.login = 'expired')");

/** 写凭据的语句（授权回调落新一代、刷新成功换代、刷新被拒清刷新令牌）停在写入前：这时它已经锁住账号行。 */
const holdCredentials = (s: OAuthStack) =>
  dbHold(s, 7103, "BEFORE INSERT OR UPDATE ON account_credentials FOR EACH STATEMENT");

/** 另一个进程里的 AccountTokens：和服务里的那份不共享进程内合并，只靠账号行锁排队。 */
function ownTokens(s: OAuthStack): AccountTokens {
  return new AccountTokens(s.database.db, new CredentialCrypto(TEST_CREDENTIALS_KEY), {
    github: GITHUB_APP,
    x: X_APP,
    githubOauthBaseUrl: s.fake.githubOauthBaseUrl,
    xOauthBaseUrl: s.fake.xOauthBaseUrl,
    githubApiBaseUrl: s.fake.githubBaseUrl,
    xApiBaseUrl: s.fake.xBaseUrl,
  });
}

async function loginOf(o: Owner, accountId: AccountId): Promise<Account["login"] | undefined> {
  return (await accountsOf(o)).find((one) => one.id === accountId)?.login;
}

/** 推送流里接下来的 count 条 account_updated 的 login，中间的通知跳过。 */
async function pushedLogins(push: PushClient, count: number): Promise<Account["login"][]> {
  const logins: Account["login"][] = [];
  while (logins.length < count) {
    const pushed = await push.next();
    if (pushed.type === "account_updated") logins.push(pushed.account.login);
  }
  return logins;
}

/** 打一条一定会推 account_updated 的请求：推送流里它前面没有别的，就说明前面那件事没多推东西。 */
async function expectQuietUntilPlaceholder(o: Pick<Owner, "client" | "push" | "local">): Promise<void> {
  const created = await o.client.post("/api/accounts", { platform: "xiaohongshu", computerId: o.local.computerId });
  expect(created.status).toBe(201);
  expect((await nextOf(o.push, "account_updated")).account.platform, "中间没有别的推送").toBe("xiaohongshu");
}

describe("连平台账号", () => {
  it("连 GitHub：start 跳到授权页带 state，回调换到令牌，账号已登录挂在远程电脑，库里只有密文", async () => {
    const s = await stack();
    const o = await owner(s, true);

    const walk = await connectPlatform(o.client, "github");

    expect(`${walk.authorize.origin}${walk.authorize.pathname}`).toBe(
      `${s.fake.githubOauthBaseUrl}/login/oauth/authorize`,
    );
    expect(walk.authorize.searchParams.get("client_id")).toBe(GITHUB_APP.clientId);
    expect(walk.authorize.searchParams.get("redirect_uri")).toBe(`${o.client.origin}/api/oauth/github/callback`);
    expect(walk.authorize.searchParams.get("state")?.length, "state 是一串够长的随机数").toBeGreaterThanOrEqual(32);
    expect(`${walk.landed.origin}${walk.landed.pathname}`, "授权完跳回 Web").toBe(`${o.client.origin}/`);
    expect(Object.fromEntries(walk.landed.searchParams)).toEqual({ oauth: "github", result: "connected" });

    const account = await connected(o);
    expect(account).toMatchObject({
      platform: "github",
      handle: s.fake.handles.github,
      login: "valid",
      computerId: o.remote?.computerId,
    });
    expect(await accountsOf(o)).toEqual([account]);

    const [exchange, whoami] = s.fake.requests();
    expect(exchange).toMatchObject({ platform: "github", method: "POST", path: "/login/oauth/access_token" });
    expect(exchange?.body).toMatchObject({
      grant_type: "authorization_code",
      client_id: GITHUB_APP.clientId,
      client_secret: GITHUB_APP.clientSecret,
      redirect_uri: `${o.client.origin}/api/oauth/github/callback`,
    });
    expect(whoami).toMatchObject({ platform: "github", method: "GET", path: "/user" });
    const accessToken = whoami?.authorization?.replace(/^Bearer /, "") ?? "";
    expect(accessToken).toMatch(/^github_access_/);

    const [row] = await s.database.db
      .select()
      .from(accountCredentials)
      .where(eq(accountCredentials.accountId, account.id));
    expect(row?.accessEnc.startsWith("v1:"), "访问令牌是密文").toBe(true);
    expect(row?.refreshEnc?.startsWith("v1:"), "刷新令牌也存了，也是密文").toBe(true);
    expect(row?.accessExpiresAt, "GitHub App 的令牌会过期，过期时间要落库").not.toBeNull();
    expect(row?.refreshExpiresAt).not.toBeNull();
    expect(JSON.stringify(row), "库里 grep 不到明文令牌").not.toMatch(/github_(access|refresh)_\d/);
  });

  it("连 X 走 PKCE：授权页带 code_challenge，回调时令牌端点收到对得上的 code_verifier", async () => {
    const s = await stack();
    const o = await owner(s, false);

    const walk = await connectPlatform(o.client, "x");

    expect(`${walk.authorize.origin}${walk.authorize.pathname}`).toBe(`${s.fake.xOauthBaseUrl}/i/oauth2/authorize`);
    const challenge = walk.authorize.searchParams.get("code_challenge");
    expect(walk.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(walk.authorize.searchParams.get("scope")?.split(" "), "要 offline.access 才给刷新令牌").toContain(
      "offline.access",
    );
    expect(Object.fromEntries(walk.landed.searchParams)).toEqual({ oauth: "x", result: "connected" });

    const [exchange] = tokenRequests(s);
    expect(exchange).toMatchObject({ platform: "x", method: "POST", path: "/2/oauth2/token" });
    const verifier = field(exchange?.body, "code_verifier");
    expect(typeof verifier).toBe("string");
    expect(createHash("sha256").update(String(verifier)).digest("base64url"), "verifier 对得上授权页的 challenge").toBe(
      challenge,
    );
    expect(field(exchange?.body, "client_id"), "公共客户端把 client_id 放在表单里").toBe(X_APP.clientId);
    expect(exchange?.authorization, "公共客户端没有 secret，不带 Basic").toBeNull();

    const account = await connected(o);
    expect(account, "没有远程电脑就挂本机").toMatchObject({
      platform: "x",
      handle: s.fake.handles.x,
      login: "valid",
      computerId: o.local.computerId,
    });
  });

  it("伪造或重放的 state 回调被拒，不建账号", async () => {
    const s = await stack();
    const o = await owner(s, true);
    const stranger = await owner(s, true);
    const callbackUrl = `${o.client.origin}/api/oauth/github/callback`;

    const forged = redirectOf(await browse(o.client, `${callbackUrl}?code=github_code_1&state=${"f".repeat(43)}`));
    expect(Object.fromEntries(forged.searchParams)).toEqual({ oauth: "github", result: "invalid_state" });

    // 别人发起的授权，回调落在这个人的会话上：state 不是他的，不能把别人的平台号挂到他名下。
    const theirs = redirectOf(await browse(stranger.client, `${o.client.origin}/api/oauth/github/start`));
    const theirCallback = redirectOf(await browse(stranger.client, theirs.href));
    const crossed = redirectOf(await browse(o.client, theirCallback.href));
    expect(Object.fromEntries(crossed.searchParams)).toEqual({ oauth: "github", result: "invalid_state" });

    expect(await accountsOf(o), "state 不对，一个账号都没建").toEqual([]);
    expect(tokenRequests(s), "state 不对，没拿授权码去换令牌").toEqual([]);

    const walk = await connectPlatform(o.client, "github");
    expect(walk.landed.searchParams.get("result")).toBe("connected");
    const account = await connected(o);
    const replayed = redirectOf(await browse(o.client, walk.callback.href));
    expect(Object.fromEntries(replayed.searchParams), "state 只能用一次").toEqual({
      oauth: "github",
      result: "invalid_state",
    });
    expect(await accountsOf(o)).toEqual([account]);
    expect(tokenRequests(s), "重放没再换一次令牌").toHaveLength(1);
  });

  it("平台没配时 start 回 503", async () => {
    const s = await stack({ github: null, x: null });
    const o = await owner(s, true);

    const github = await browse(o.client, `${o.client.origin}/api/oauth/github/start`);
    expect(github.status).toBe(503);
    expect(((await github.json()) as { error: string }).error).toContain("管理员还没配 GitHub 应用");
    const x = await browse(o.client, `${o.client.origin}/api/oauth/x/start`);
    expect(x.status).toBe(503);
    expect(((await x.json()) as { error: string }).error).toContain("管理员还没配 X 应用");
    expect((await browse(o.client, `${o.client.origin}/api/oauth/xiaohongshu/start`)).status, "小红书不走 OAuth").toBe(
      404,
    );
    expect(s.fake.requests()).toEqual([]);
  });

  it("同一个号重新授权更新原来那行，不多出一行", async () => {
    const s = await stack();
    const o = await owner(s, true);
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(o.client, "github");
    const first = await connected(o);

    s.fake.revoke();
    expect((await proxyFetch(o, `/${first.id}/user`)).status).toBe(409);
    expect((await nextOf(o.push, "account_updated")).account).toMatchObject({ id: first.id, login: "expired" });
    await nextNotice(o.push);
    expect((await o.agent.expect("config")).accounts.find((one) => one.id === first.id)?.login).toBe("expired");

    s.fake.setTokenLifetime(LONG_LIFETIME_S);
    await connectPlatform(o.client, "github");
    const again = await connected(o);
    expect(again, "还是原来那行，记回已登录").toMatchObject({ id: first.id, login: "valid" });
    expect((await accountsOf(o)).map((one) => one.id)).toEqual([first.id]);
    expect((await proxyFetch(o, `/${first.id}/user`)).status, "新令牌能用").toBe(200);

    // 先挂在本机，后来有了远程电脑再授权：还是那一行，挪到远程电脑上。
    const p = await owner(s, false);
    await connectPlatform(p.client, "github");
    const [onLocal] = await accountsOf(p);
    expect(onLocal).toMatchObject({ computerId: p.local.computerId, login: "valid" });
    const remote = ComputerTokenResponse.parse(await (await p.client.post("/api/computers/remote")).json());
    expect((await connectPlatform(p.client, "github")).landed.searchParams.get("result")).toBe("connected");
    expect(await accountsOf(p), "没在远程电脑上另起一行").toEqual([
      expect.objectContaining({ id: onLocal?.id, computerId: remote.computerId, login: "valid" }),
    ]);
  });

  it("两次授权和建远程电脑交错进行，同一个号最后只有一行", async () => {
    const s = await stack();
    const o = await owner(s, false);
    const authorized = async () =>
      redirectOf(
        await browse(o.client, redirectOf(await browse(o.client, `${o.client.origin}/api/oauth/github/start`)).href),
      );
    const first = await authorized();
    const second = await authorized();

    // 账号 INSERT 卡在测试手里的一把锁上：第一条回调停在建行那一步，趁这时建远程电脑、送第二条回调。
    const gate = await s.database.sql.reserve();
    cleanups.push(async () => {
      await gate`SELECT pg_advisory_unlock_all()`;
      gate.release();
    });
    await gate`SELECT pg_advisory_lock(7101)`;
    await s.database.sql`
      CREATE FUNCTION test_hold_account_insert() RETURNS trigger AS $$
      BEGIN PERFORM pg_advisory_lock(7101); PERFORM pg_advisory_unlock(7101); RETURN NEW; END;
      $$ LANGUAGE plpgsql`;
    await s.database.sql`
      CREATE TRIGGER test_hold_account_insert BEFORE INSERT ON accounts
      FOR EACH ROW EXECUTE FUNCTION test_hold_account_insert()`;

    const firstLanded = browse(o.client, first.href).then(redirectOf);
    await lockWaiters(s, 1, "第一条回调卡在建账号行");
    const remote = await o.client.post("/api/computers/remote");
    expect(remote.status).toBe(200);
    const { computerId: remoteId } = ComputerTokenResponse.parse(await remote.json());
    const secondLanded = browse(o.client, second.href).then(redirectOf);
    await lockWaiters(s, 2, "第二条回调也走到账号那一步");
    await gate`SELECT pg_advisory_unlock(7101)`;

    const landed = await Promise.all([firstLanded, secondLanded]);
    expect(landed.map((url) => url.searchParams.get("result"))).toEqual(["connected", "connected"]);
    expect(await accountsOf(o), "同一个人同一个平台同一个名字只有一行，落在后来建的远程电脑上").toEqual([
      expect.objectContaining({ platform: "github", handle: s.fake.handles.github, computerId: remoteId }),
    ]);
  });

  it("授权回调提交之后，这个人这个平台的 advisory lock 已经放掉", async () => {
    const s = await stack();
    const o = await owner(s, true);

    await connectPlatform(o.client, "github");
    await connected(o);

    const [row] = await s.database.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_locks l JOIN pg_database d ON d.oid = l.database
      WHERE l.locktype = 'advisory' AND d.datname = ${s.database.databaseName}`;
    expect(
      row?.count,
      "直接查 pg_locks：会话级的锁挂在连接池的空闲连接上，接口上要等同一人同一平台的下一条回调碰巧拿到别的连接、卡死才看得出来",
    ).toBe(0);
  });

  it("WEB_BASE_URL 末尾带斜杠，回调地址和跳回的地址里都没有 //", async () => {
    const web = "https://baize.example.com";
    const s = await stack({}, { webBaseUrl: `${web}/` });
    const o = await owner(s, false);

    const authorize = redirectOf(await browse(o.client, `${o.client.origin}/api/oauth/github/start`));
    expect(authorize.searchParams.get("redirect_uri"), "和平台登记的回调一字不差").toBe(
      `${web}/api/oauth/github/callback`,
    );
    const callback = redirectOf(await browse(o.client, authorize.href));
    expect(`${callback.origin}${callback.pathname}`).toBe(`${web}/api/oauth/github/callback`);
    // 反向代理把这个地址转给控制面，这里直接打控制面。
    const landed = redirectOf(await browse(o.client, `${o.client.origin}${callback.pathname}${callback.search}`));
    expect(landed.href).toBe(`${web}/?oauth=github&result=connected`);
  });
});

describe("令牌端点发来不安全的访问令牌", () => {
  const isExchange: RequestMatch = (request) => field(request.body, "grant_type") === "authorization_code";

  it.each([
    { name: "十二个连续反斜杠", token: `ghu_${"\\".repeat(12)}X` },
    { name: "十二个连续百分号", token: `ghu_${"%".repeat(12)}X` },
    { name: "控制字符", token: "ghu_a\u0001b" },
    { name: "Latin-1 字符", token: "ghu_toké" },
  ])(
    "含$name：授权回调不建账号；刷新时旧刷新令牌已被平台用掉，账号记过期让用户重新登录；这把令牌都进不了库",
    async ({ token }) => {
      const s = await stack();
      const o = await owner(s, true);
      const logged = captureErrors();
      const grant = {
        access_token: token,
        expires_in: 3600,
        refresh_token: "github_refresh_unsafe",
        token_type: "bearer",
      };

      s.fake.failNext(200, isExchange, grant);
      const walk = await connectPlatform(o.client, "github");
      expect(Object.fromEntries(walk.landed.searchParams)).toEqual({ oauth: "github", result: "failed" });
      expect(await accountsOf(o), "账号没建").toEqual([]);
      expect(await s.database.db.select().from(accountCredentials), "凭据没落库").toEqual([]);
      expect(s.fake.requests().filter(isRead), "没拿这把令牌去问我是谁").toEqual([]);

      s.fake.setTokenLifetime(SHORT_LIFETIME_S);
      await connectPlatform(o.client, "github");
      const account = await connected(o);
      const stored = await credentialsOf(s, account.id);
      s.fake.failNext(200, isRefresh, grant);
      const failed = await proxyFetch(o, `/${account.id}${WHOAMI.github}`);
      expect(failed.status, "刷新令牌只能用一次，稍后再试也救不回来，按登录过期回").toBe(409);
      expect((await nextOf(o.push, "account_updated")).account).toMatchObject({ id: account.id, login: "expired" });
      const notice = await nextNotice(o.push);
      expect(notice.kind).toBe("failed");
      expect(notice.text, "通知用户重新登录").toContain("重新登录");
      const after = await credentialsOf(s, account.id);
      expect(after?.accessEnc, "刷出来的这把没写进库").toBe(stored?.accessEnc);
      expect(after?.generation, "代际不动，过期的就是这一代").toBe(stored?.generation);
      expect(after?.refreshEnc, "用掉的刷新令牌不留").toBeNull();
      const tokenCalls = tokenRequests(s).length;
      expect((await proxyFetch(o, `/${account.id}${WHOAMI.github}`)).status, "过期之后不再拿它去刷").toBe(409);
      expect(tokenRequests(s)).toHaveLength(tokenCalls);
      expect(
        logged.filter((line) => line.includes("访问令牌含反斜杠、百分号、控制字符或非 ASCII 字符，不收")),
      ).toHaveLength(2);
      expect(logged.join("\n"), "日志里没有这把令牌").not.toContain(token);
    },
  );

  it("十几个请求一起等刷新、刷出来的令牌不安全：每个都回 409，但账号只推一次过期、只通知一次", async () => {
    const s = await stack();
    const o = await owner(s, true);
    captureErrors();
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(o.client, "github");
    const account = await connected(o);

    s.fake.failNext(200, isRefresh, {
      access_token: `ghu_${"\\".repeat(12)}X`,
      expires_in: 3600,
      refresh_token: "github_refresh_unsafe",
      token_type: "bearer",
    });
    const release = s.fake.hold(isRefresh);
    cleanups.push(release);
    const burst = Array.from({ length: 12 }, () => proxyFetch(o, `/${account.id}${WHOAMI.github}`));
    await waitFor(async () => refreshes(s).length === 1, "第一条刷新挂在假平台上");
    release();
    const responses = await Promise.all(burst);

    expect(
      responses.map((response) => response.status),
      "每个请求都被告知要重新登录",
    ).toEqual(Array(12).fill(409));
    expect(refreshes(s), "只刷一次").toHaveLength(1);
    expect((await nextOf(o.push, "account_updated")).account).toMatchObject({ id: account.id, login: "expired" });
    expect((await nextOf(o.push, "notify")).notice.kind).toBe("failed");
    // 多出来的过期推送或通知会排在占位账号那条前面，nextOf 当场认出。去重靠 markLoginExpired 的 login = 'valid' 守卫。
    await expectQuietUntilPlaceholder(o);
    expect(await loginOf(o, account.id)).toBe("expired");
  });
});

describe("令牌刷新", () => {
  it("同一个账号十几个请求一起等刷新：只刷一次，等着的不占数据库连接，别的账号和别的接口照常走", async () => {
    const s = await stack();
    const o = await owner(s, true);
    await connectPlatform(o.client, "x");
    const x = await connected(o);
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(o.client, "github");
    const github = await connected(o);
    s.fake.setTokenLifetime(LONG_LIFETIME_S);
    const before = s.fake.requests().length;

    const release = s.fake.hold(isRefresh);
    cleanups.push(release);
    const burst = Array.from({ length: 12 }, () => proxyFetch(o, `/${github.id}/user`));
    await waitFor(async () => refreshes(s).length === 1, "第一条刷新挂在假平台上");
    // 测试库的连接池只有 4 条。等刷新的请求要是各占一条，下面两条都拿不到连接，一直挂到刷新放行。
    expect((await o.client.get("/api/me")).status, "刷新挂着时无关的接口照常回").toBe(200);
    expect((await proxyFetch(o, `/${x.id}/2/users/me`)).status, "刷新挂着时另一个账号照常读").toBe(200);
    release();
    const responses = await Promise.all(burst);

    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(200));
    expect(refreshes(s), "只刷一次").toHaveLength(1);
    const reads = s.fake
      .requests()
      .slice(before)
      .filter((request) => request.platform === "github" && isRead(request));
    expect(reads).toHaveLength(12);
    expect(new Set(reads.map((request) => request.authorization)).size, "都拿到同一个新令牌").toBe(1);
    const original = s.fake.requests().find((request) => request.path === "/user")?.authorization;
    expect(reads[0]?.authorization).not.toBe(original);
    expect(reads[0]?.authorization).toMatch(/^Bearer github_access_/);
  });

  it.each([
    { platform: "github", label: "GitHub", code: "bad_refresh_token" },
    { platform: "x", label: "X", code: "invalid_request" },
  ] as const)("$label 回 $code：刷新令牌清掉，账号记过期，推一条通知", async ({ platform, label }) => {
    const s = await stack();
    const o = await owner(s, true);
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(o.client, platform);
    const account = await connected(o);

    // 假平台撤销之后照各家实际回法：GitHub 200 带 bad_refresh_token，X 400 invalid_request 加「Value passed for the token was invalid.」。
    s.fake.revoke();
    const refused = await proxyFetch(o, `/${account.id}${WHOAMI[platform]}`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("重新");

    expect((await nextOf(o.push, "account_updated")).account).toMatchObject({ id: account.id, login: "expired" });
    const notice = await nextNotice(o.push);
    expect(notice.kind).toBe("failed");
    expect(notice.text).toContain(label);
    expect(notice.text).toContain(s.fake.handles[platform]);
    expect(notice.text).toContain("重新登录");
    expect((await o.agent.expect("config")).accounts.find((one) => one.id === account.id)?.login).toBe("expired");
    expect((await accountsOf(o))[0]?.login).toBe("expired");
    expect((await credentialsOf(s, account.id))?.refreshEnc, "死掉的刷新令牌不留").toBeNull();

    const tokenCalls = tokenRequests(s).length;
    expect((await proxyFetch(o, `/${account.id}${WHOAMI[platform]}`)).status, "过期之后不再拿死掉的刷新令牌去试").toBe(
      409,
    );
    expect(tokenRequests(s)).toHaveLength(tokenCalls);
  });

  it.each([
    { name: "400 invalid_request，描述正是令牌不认", error: "invalid_request", description: X_DEAD_TOKEN },
    {
      name: "400 invalid_request，描述里带着令牌不认",
      error: "invalid_request",
      description: `oauth2: ${X_DEAD_TOKEN}`,
    },
    { name: "400 invalid_grant（RFC 6749 §5.2 的刷新令牌失效）", error: "invalid_grant", description: null },
  ])("X 回 $name：刷新令牌清掉，账号记过期", async ({ error, description }) => {
    const s = await stack();
    const o = await owner(s, true);
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(o.client, "x");
    const account = await connected(o);

    s.fake.failNext(400, isRefresh, description === null ? { error } : { error, error_description: description });
    expect((await proxyFetch(o, `/${account.id}${WHOAMI.x}`)).status).toBe(409);
    expect((await nextOf(o.push, "account_updated")).account).toMatchObject({ id: account.id, login: "expired" });
    expect((await credentialsOf(s, account.id))?.refreshEnc, "死掉的刷新令牌不留").toBeNull();
  });

  const KEPT: readonly {
    readonly name: string;
    readonly platform: OAuthPlatform;
    readonly status: number;
    readonly body: unknown;
    readonly code: string;
  }[] = [
    {
      name: "X 回 401 invalid_client",
      platform: "x",
      status: 401,
      body: { error: "invalid_client" },
      code: "invalid_client",
    },
    {
      name: "X 回 400 unauthorized_client",
      platform: "x",
      status: 400,
      body: { error: "unauthorized_client" },
      code: "unauthorized_client",
    },
    {
      name: "GitHub 回 200 incorrect_client_credentials",
      platform: "github",
      status: 200,
      body: { error: "incorrect_client_credentials" },
      code: "incorrect_client_credentials",
    },
    { name: "GitHub 回 400 非 JSON", platform: "github", status: 400, body: "Bad Request", code: "无" },
    { name: "GitHub 回 503", platform: "github", status: 503, body: { message: "unavailable" }, code: "无" },
    {
      name: "GitHub 回 502 带 bad_refresh_token",
      platform: "github",
      status: 502,
      body: { error: "bad_refresh_token" },
      code: "bad_refresh_token",
    },
    {
      name: "X 回 503 invalid_request，描述是令牌不认",
      platform: "x",
      status: 503,
      body: { error: "invalid_request", error_description: X_DEAD_TOKEN },
      code: "invalid_request",
    },
    {
      name: "X 回 401 invalid_request，描述是令牌不认",
      platform: "x",
      status: 401,
      body: { error: "invalid_request", error_description: X_DEAD_TOKEN },
      code: "invalid_request",
    },
    {
      name: "X 回 400 invalid_request，描述是别的",
      platform: "x",
      status: 400,
      body: { error: "invalid_request", error_description: "Missing required parameter [code_verifier]." },
      code: "invalid_request",
    },
    {
      name: "X 回 400 invalid_request，没有描述",
      platform: "x",
      status: 400,
      body: { error: "invalid_request" },
      code: "invalid_request",
    },
  ];

  it.each(KEPT)(
    "$name：当运维错误回 502，密文和账号状态都不动，下一次请求重新刷新回 200",
    async ({ platform, status, body, code }) => {
      const s = await stack();
      const o = await owner(s, true);
      s.fake.setTokenLifetime(SHORT_LIFETIME_S);
      await connectPlatform(o.client, platform);
      const account = await connected(o);
      const stored = await credentialsOf(s, account.id);
      const logged = captureErrors();

      s.fake.failNext(status, isRefresh, body);
      const failed = await proxyFetch(o, `/${account.id}${WHOAMI[platform]}`);

      expect(failed.status, "没换到令牌，让 Bot 稍后再试").toBe(502);
      expect(await credentialsOf(s, account.id), "不能证明刷新令牌死了，密文一个字不动").toEqual(stored);
      await expectQuietUntilPlaceholder(o);
      expect((await accountsOf(o)).find((one) => one.id === account.id)?.login).toBe("valid");
      expect(
        logged.some((line) => line.includes(`${platform} 刷新令牌没换到`) && line.includes(`错误码 ${code}`)),
        "运维日志写平台和错误码",
      ).toBe(true);
      expect(logged.join("\n"), "日志里没有令牌").not.toMatch(/_(access|refresh)_\d/);

      const retried = await proxyFetch(o, `/${account.id}${WHOAMI[platform]}`);
      expect(retried.status, "配置修好、平台恢复之后，原来的刷新令牌照常能用；上一趟失败的刷新不留在合并表里").toBe(
        200,
      );
      expect(refreshes(s)).toHaveLength(2);
    },
  );

  it("发布循环用快过期的令牌时先刷新再发", async () => {
    const s = await stack();
    const job = await contentJob(s.server, s.database.db, [{ platform: "github", handle: s.fake.handles.github }]);
    cleanups.push(() => job.close());
    const [placed] = job.accounts;
    if (placed === undefined) throw new Error("没挂上账号");

    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(job.client, "github");
    expect((await nextOf(job.push, "account_updated")).account, "授权落在已挂的那行上").toMatchObject({
      id: placed.id,
      login: "valid",
    });
    await job.agent.expect("config");
    s.fake.setTokenLifetime(LONG_LIFETIME_S);
    const before = s.fake.requests().length;

    const spec = specOf(placed, issuePost("刷新之后再发"));
    await createDraft(job, spec);
    const approved = await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" });
    expect(DecideDraftResponse.parse(await approved.json()).draft.status).toBe("approved");
    await nextOf(job.push, "draft_updated");
    await s.server.server.publisher.tick();
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    await nextOf(job.push, "publication_created");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("published");

    const after = s.fake.requests().slice(before);
    expect(after.map((request) => [request.method, request.path])).toEqual([
      ["POST", "/login/oauth/access_token"],
      ["POST", "/repos/baize/demo/issues"],
    ]);
    expect(field(after[0]?.body, "grant_type")).toBe("refresh_token");
    const original = s.fake.requests().find((request) => request.path === "/user")?.authorization;
    expect(after[1]?.authorization, "发布用的是刷新后的令牌").not.toBe(original);
    expect(after[1]?.authorization).toMatch(/^Bearer github_access_/);
  });
});

describe("发布碰到平台 401", () => {
  it("代理已经换到新令牌 B，发布拿旧令牌 A 晚到的 401 不记过期，换 B 重试发出去", async () => {
    const s = await stack();
    const job = await contentJob(s.server, s.database.db, [{ platform: "github", handle: s.fake.handles.github }]);
    cleanups.push(() => job.close());
    const [placed] = job.accounts;
    if (placed === undefined) throw new Error("没挂上账号");
    await connectPlatform(job.client, "github");
    expect((await nextOf(job.push, "account_updated")).account).toMatchObject({ id: placed.id, login: "valid" });
    const config = await job.agent.expect("config");

    const spec = specOf(placed, issuePost("旧令牌晚到的 401"));
    await createDraft(job, spec);
    const approved = await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" });
    expect(DecideDraftResponse.parse(await approved.json()).draft.status).toBe("approved");
    await nextOf(job.push, "draft_updated");
    const before = s.fake.requests().length;

    const release = s.fake.hold(isIssuePost);
    cleanups.push(release);
    s.fake.failNext(401, isIssuePost);
    s.fake.failNext(401, isRead);
    const ticked = s.server.server.publisher.tick();
    await waitFor(async () => s.fake.requests().slice(before).some(isIssuePost), "发布带着令牌 A 挂在假平台上");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");

    const read = await proxyFetch({ config }, `/${placed.id}/user`);
    expect(read.status, "代理 401 之后刷出 B，用 B 重试成功").toBe(200);
    release();
    await ticked;

    await nextOf(job.push, "publication_created");
    expect((await nextOf(job.push, "draft_updated")).draft.status, "草稿用 B 重试后发出去").toBe("published");
    const accounts = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(accounts.find((one) => one.id === placed.id)?.login, "B 好好的，账号不记过期").toBe("valid");

    const after = s.fake.requests().slice(before);
    expect(after.map((request) => [request.method, request.path, field(request.body, "grant_type") ?? null])).toEqual([
      ["POST", "/repos/baize/demo/issues", null],
      ["GET", "/user", null],
      ["POST", "/login/oauth/access_token", "refresh_token"],
      ["GET", "/user", null],
      ["POST", "/repos/baize/demo/issues", null],
    ]);
    const [publishA, readA, , readB, publishB] = after;
    expect(publishA?.authorization, "发布第一次和代理第一次用的都是 A").toBe(readA?.authorization);
    expect(readB?.authorization).not.toBe(readA?.authorization);
    expect(publishB?.authorization, "发布重试直接用代理刷出的 B，不再刷新").toBe(readB?.authorization);
  });

  it("同一个账号两条草稿同时碰到 401：只刷一次，各用新令牌只重试自己那条，都发出去", async () => {
    const s = await stack();
    const job = await contentJob(s.server, s.database.db, [{ platform: "github", handle: s.fake.handles.github }]);
    cleanups.push(() => job.close());
    const [placed] = job.accounts;
    if (placed === undefined) throw new Error("没挂上账号");
    await connectPlatform(job.client, "github");
    await nextOf(job.push, "account_updated");
    await job.agent.expect("config");

    const specs = [specOf(placed, issuePost("第一条")), specOf(placed, issuePost("第二条"))];
    for (const spec of specs) {
      await createDraft(job, spec);
      await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" });
      expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("approved");
    }
    const before = s.fake.requests().length;
    const release = s.fake.hold(isIssuePost);
    cleanups.push(release);
    s.fake.failNext(401, isIssuePost);
    s.fake.failNext(401, isIssuePost);
    const ticked = s.server.server.publisher.tick();
    await waitFor(
      async () => s.fake.requests().slice(before).filter(isIssuePost).length === 2,
      "两条发布带着同一个令牌同时挂在假平台上",
    );
    release();
    await ticked;

    const pushed = await Promise.all(Array.from({ length: 6 }, () => job.push.next()));
    const published = pushed.flatMap((one) =>
      one.type === "draft_updated" && one.draft.status === "published" ? [one.draft.id] : [],
    );
    expect(published.toSorted(), "两条都发出去").toEqual(specs.map((spec) => spec.draftId).toSorted());
    await expectQuietUntilPlaceholder({ client: job.client, push: job.push, local: job.computer });
    const accounts = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(accounts.find((one) => one.id === placed.id)?.login).toBe("valid");

    const after = s.fake.requests().slice(before);
    expect(after.filter(isRefresh), "两条 401 合并成一次刷新").toHaveLength(1);
    const posts = after.filter(isIssuePost);
    expect(posts, "每条只重试一次，一共四次发布").toHaveLength(4);
    const [first, second, retryA, retryB] = posts.map((request) => request.authorization);
    expect(second, "第一轮两条用的是同一个旧令牌").toBe(first);
    expect(retryA, "重试用刷新出来的新令牌").not.toBe(first);
    expect(retryB, "两条重试用的是同一个新令牌").toBe(retryA);
  });

  it("发布刷新后重试还是 401：只刷一次、只重试一次，草稿记登录过期，账号跟着过期", async () => {
    const s = await stack();
    const job = await contentJob(s.server, s.database.db, [{ platform: "github", handle: s.fake.handles.github }]);
    cleanups.push(() => job.close());
    const [placed] = job.accounts;
    if (placed === undefined) throw new Error("没挂上账号");
    await connectPlatform(job.client, "github");
    await nextOf(job.push, "account_updated");
    await job.agent.expect("config");

    const spec = specOf(placed, issuePost("两次 401"));
    await createDraft(job, spec);
    await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" });
    await nextOf(job.push, "draft_updated");
    const before = s.fake.requests().length;
    s.fake.failNext(401, isIssuePost);
    s.fake.failNext(401, isIssuePost);
    await s.server.server.publisher.tick();

    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({
      status: "failed",
      failure: "login_expired",
    });
    expect((await nextOf(job.push, "account_updated")).account).toMatchObject({ id: placed.id, login: "expired" });
    expect(
      s.fake
        .requests()
        .slice(before)
        .map((request) => [request.method, request.path]),
    ).toEqual([
      ["POST", "/repos/baize/demo/issues"],
      ["POST", "/login/oauth/access_token"],
      ["POST", "/repos/baize/demo/issues"],
    ]);
  });
});

describe("旧刷新令牌被拒和同一个号重新授权交错", () => {
  /**
   * 刷新事务锁着账号行、令牌端点挂着；重新授权这时排在账号行锁后面。
   * 放行之后旧刷新拿到「不认」，新一代凭据随后落库。旧请求的结论只属于被拒的那一代。
   */
  async function interleave(s: OAuthStack, client: Owner["client"], stale: () => Promise<unknown>) {
    s.fake.revoke();
    const release = s.fake.hold(isRefresh);
    cleanups.push(release);
    const pending = stale();
    await waitFor(async () => refreshes(s).length === 1, "旧刷新令牌挂在假平台上，刷新事务锁着凭据行");
    const reauth = connectPlatform(client, "github");
    await lockWaiters(s, 1, "重新授权等在账号行锁上");
    release();
    const walked = await reauth;
    expect(walked.landed.searchParams.get("result"), "重新授权成功").toBe("connected");
    await pending;
  }

  it("代理：新一代凭据落库后，旧请求不把账号记过期", async () => {
    const s = await stack();
    const o = await owner(s, true);
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(o.client, "github");
    const account = await connected(o);
    s.fake.setTokenLifetime(LONG_LIFETIME_S);
    const before = await credentialsOf(s, account.id);

    await interleave(s, o.client, () => proxyFetch(o, `/${account.id}/user`));

    expect((await nextOf(o.push, "account_updated")).account, "只推重新授权的那一条").toMatchObject({
      id: account.id,
      login: "valid",
    });
    expect((await accountsOf(o)).find((one) => one.id === account.id)?.login, "新一代登录不能被旧请求标成过期").toBe(
      "valid",
    );
    await expectQuietUntilPlaceholder(o);
    const after = await credentialsOf(s, account.id);
    expect(after?.refreshEnc, "新一代的刷新令牌在库里").not.toBeNull();
    expect(after?.accessEnc).not.toBe(before?.accessEnc);
    expect((await proxyFetch(o, `/${account.id}/user`)).status, "新一代凭据照常能用").toBe(200);
  });

  it("发布：新一代凭据落库后，旧认领的草稿记登录过期，账号不记过期", async () => {
    const s = await stack();
    const job = await contentJob(s.server, s.database.db, [{ platform: "github", handle: s.fake.handles.github }]);
    cleanups.push(() => job.close());
    const [placed] = job.accounts;
    if (placed === undefined) throw new Error("没挂上账号");
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(job.client, "github");
    expect((await nextOf(job.push, "account_updated")).account).toMatchObject({ id: placed.id, login: "valid" });
    await job.agent.expect("config");
    s.fake.setTokenLifetime(LONG_LIFETIME_S);

    const spec = specOf(placed, issuePost("旧刷新被拒时刚重新授权"));
    await createDraft(job, spec);
    const approved = await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" });
    expect(DecideDraftResponse.parse(await approved.json()).draft.status).toBe("approved");
    await nextOf(job.push, "draft_updated");

    await interleave(s, job.client, () => s.server.server.publisher.tick());

    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    const settled = [await job.push.next(), await job.push.next()];
    expect(settled, "重新授权推一次账号，草稿推一次失败，谁先谁后不定").toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "account_updated",
          account: expect.objectContaining({ id: placed.id, login: "valid" }),
        }),
        expect.objectContaining({
          type: "draft_updated",
          draft: expect.objectContaining({ id: spec.draftId, status: "failed", failure: "login_expired" }),
        }),
      ]),
    );
    const accounts = AccountListResponse.parse(await (await job.client.get("/api/accounts")).json()).accounts;
    expect(accounts.find((one) => one.id === placed.id)?.login, "新一代登录不能被旧认领的结论标成过期").toBe("valid");
    await expectQuietUntilPlaceholder({ client: job.client, push: job.push, local: job.computer });
    expect((await credentialsOf(s, placed.id))?.refreshEnc, "新一代的刷新令牌在库里").not.toBeNull();
  });
});

describe("过期和刷新成功交错", () => {
  it("双请求：一条重试后仍 401 正在记过期，另一条随后刷新出新一代并重试成功，账号最终是 valid", async () => {
    const s = await stack();
    const o = await owner(s, true);
    await connectPlatform(o.client, "github");
    const account = await connected(o);
    const refreshed = refreshes(s).length;
    const release = await holdExpiry(s);

    // P1：A 被拒，刷出 B（第二代），B 也被拒，进过期事务停在钩子上。
    s.fake.failNext(401, isRead);
    s.fake.failNext(401, isRead);
    const p1 = proxyFetch(o, `/${account.id}/user`);
    await lockWaiters(s, 1, "P1 锁着账号行、停在记过期前");
    expect(refreshes(s).length - refreshed, "P1 已经刷出第二代").toBe(1);
    // P2：拿库里的 B 去读，被拒，强制刷新；刷新在过期事务后面排队。
    s.fake.failNext(401, isRead);
    const p2 = proxyFetch(o, `/${account.id}/user`);
    await lockWaiters(s, 2, "P2 的刷新排在过期事务后面");
    await release();

    expect((await p1).status, "P1 的第二代被拒，回过期").toBe(409);
    expect((await p2).status, "P2 刷出第三代，重试成功").toBe(200);
    expect(refreshes(s).length - refreshed, "两次刷新").toBe(2);
    expect((await credentialsOf(s, account.id))?.generation, "库里是第三代").toBe(3);
    expect(await loginOf(o, account.id), "第三代凭据可用，账号不能停在 expired").toBe("valid");
    expect((await proxyFetch(o, `/${account.id}/user`)).status, "后续请求照常").toBe(200);
    expect(await pushedLogins(o.push, 2), "P1 记过期先推，P2 刷新成功把账号推回 valid").toEqual(["expired", "valid"]);
    await o.agent.expect("config");
    const config = await o.agent.expect("config");
    expect(config.accounts.find((one) => one.id === account.id)?.login, "电脑收到的最后一份 config 是 valid").toBe(
      "valid",
    );
  });
});

describe("锁序", () => {
  it("授权回调锁住账号、还没写凭据时发起过期：两边都完成，没有 deadlock，账号是新一代的 valid", async () => {
    const s = await stack();
    const o = await owner(s, true);
    await connectPlatform(o.client, "github");
    const account = await connected(o);
    const release = await holdCredentials(s);

    const reauth = connectPlatform(o.client, "github");
    await lockWaiters(s, 1, "回调锁着账号行，停在写凭据前");
    const expiry = markLoginExpired(s.database.db, {
      ownerId: o.user.id,
      accountId: account.id,
      evidence: { kind: "rejected", generation: 1 },
    });
    await lockWaiters(s, 2, "过期事务排在账号行锁后面");
    await release();

    const settled = await Promise.allSettled([reauth, expiry]);
    const failures = settled.flatMap((one) => (one.status === "rejected" ? [String(one.reason)] : []));
    expect(failures, "两个事务都完成，没有 deadlock detected").toEqual([]);
    const [walked, expired] = settled;
    expect(walked.status === "fulfilled" && walked.value.landed.searchParams.get("result")).toBe("connected");
    expect(expired.status === "fulfilled" && expired.value, "第一代已经换掉，过期落不下").toBeNull();
    expect((await credentialsOf(s, account.id))?.generation).toBe(2);
    expect(await loginOf(o, account.id)).toBe("valid");
  });
});

type Ctx = { readonly s: OAuthStack; readonly o: Owner; readonly account: Account };
const expire = async (ctx: Ctx, generation: number | null) => {
  await markLoginExpired(ctx.s.database.db, {
    ownerId: ctx.o.user.id,
    accountId: ctx.account.id,
    evidence: { kind: "rejected", generation },
  });
};

describe("四种操作两两交错", () => {
  type Op = {
    readonly name: string;
    /** 让这个操作停在它锁住账号行之后、写入之前的钩子。 */
    readonly hold: (s: OAuthStack) => Promise<() => Promise<void>>;
    readonly run: (ctx: Ctx) => Promise<void>;
  };
  // 代理和发布循环拿到 login_expired 都会把那一代交给 markLoginExpired，这里照做。
  const refresh = async (ctx: Ctx) => {
    const got = await ownTokens(ctx.s).accessToken(ctx.account.id);
    if (got.kind === "login_expired") await expire(ctx, got.generation);
  };
  const E: Op = { name: "过期（第一代被拒）", hold: holdExpiry, run: (ctx) => expire(ctx, 1) };
  const RS: Op = { name: "刷新成功", hold: holdCredentials, run: refresh };
  const RR: Op = {
    name: "刷新被拒",
    hold: holdCredentials,
    run: (ctx) => {
      ctx.s.fake.revoke();
      return refresh(ctx);
    },
  };
  const A: Op = {
    name: "重新授权",
    hold: holdCredentials,
    run: async (ctx) => {
      expect((await connectPlatform(ctx.o.client, "github")).landed.searchParams.get("result")).toBe("connected");
    },
  };

  // 终态按不变式推：代际推进了（刷新成功、重新授权）就是 valid；停在第一代且第一代被拒过就是 expired。
  const cases = [
    { first: E, second: RS, login: "valid", generation: 2 },
    { first: RS, second: E, login: "valid", generation: 2 },
    { first: E, second: RR, login: "expired", generation: 1 },
    { first: RR, second: E, login: "expired", generation: 1 },
    { first: E, second: A, login: "valid", generation: 2 },
    { first: A, second: E, login: "valid", generation: 2 },
    { first: RS, second: RR, login: "valid", generation: 2 },
    { first: RR, second: RS, login: "expired", generation: 1 },
    { first: RS, second: A, login: "valid", generation: 3 },
    { first: A, second: RS, login: "valid", generation: 2 },
    { first: RR, second: A, login: "valid", generation: 2 },
    { first: A, second: RR, login: "valid", generation: 2 },
  ] as const;

  it.each(cases)("$first.name 先锁住账号行，$second.name 排在后面", async ({ first, second, login, generation }) => {
    const s = await stack();
    const o = await owner(s, true);
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(o.client, "github");
    const account = await connected(o);
    s.fake.setTokenLifetime(LONG_LIFETIME_S);
    const ctx = { s, o, account };

    const release = await first.hold(s);
    const one = first.run(ctx);
    await lockWaiters(s, 1, `${first.name} 锁着账号行，停在钩子上`);
    const two = second.run(ctx);
    await lockWaiters(s, 2, `${second.name} 排在账号行锁后面`);
    await release();
    await Promise.all([one, two]);

    expect({
      login: await loginOf(o, account.id),
      generation: (await credentialsOf(s, account.id))?.generation,
    }).toEqual({ login, generation });
    expect((await proxyFetch(o, `/${account.id}/user`)).status, "valid 的账号凭据真能用，expired 的挡在代理外").toBe(
      login === "valid" ? 200 : 409,
    );
  });
});

describe("发布拿凭据被拒只按代际", () => {
  it("认领之后过期又重新授权、新一代随即被拒：账号照样记过期；认领时刻是认领那一刻，不是这一轮的时钟", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    const s = await stack({}, {}, () => old);
    const job = await contentJob(s.server, s.database.db, [
      { platform: "github", handle: s.fake.handles.github, token: "ghp_first_generation" },
    ]);
    cleanups.push(() => job.close());
    const [placed] = job.accounts;
    if (placed === undefined) throw new Error("没挂上账号");
    const spec = specOf(placed, issuePost("认领之后重新授权"));
    await createDraft(job, spec);
    const approved = await job.client.post(`/api/drafts/${spec.draftId}`, { decision: "approve" });
    expect(DecideDraftResponse.parse(await approved.json()).draft.status).toBe("approved");
    await nextOf(job.push, "draft_updated");

    const release = s.fake.hold(isIssuePost);
    cleanups.push(release);
    const inflight = s.server.server.publisher.tick();
    await waitFor(async () => s.fake.requests().filter(isIssuePost).length === 1, "发帖挂在假平台上");
    expect((await nextOf(job.push, "draft_updated")).draft.status).toBe("publishing");
    const [claimed] = await s.database.db
      .select({ claimedAt: drafts.claimedAt })
      .from(drafts)
      .where(eq(drafts.id, spec.draftId));
    expect(claimed?.claimedAt?.getTime(), "认领时刻由认领语句产生，不是这一轮开始时钉住的时钟").toBeGreaterThan(
      old.getTime(),
    );

    // 发着的时候第一代死了、用户重新授权：login_changed_at 晚于认领时刻，第二代 valid。
    await markLoginExpired(s.database.db, {
      ownerId: job.user.id,
      accountId: placed.id,
      evidence: { kind: "rejected", generation: 1 },
    });
    await connectPlatform(job.client, "github");
    expect((await nextOf(job.push, "account_updated")).account).toMatchObject({ id: placed.id, login: "valid" });
    await job.agent.expect("config");
    // 挂着的发帖 401，换第二代重试还是 401：被拒的正是当前这一代。
    s.fake.failNext(401, isIssuePost);
    s.fake.failNext(401, isIssuePost);
    release();
    await inflight;

    expect((await nextOf(job.push, "draft_updated")).draft).toMatchObject({
      id: spec.draftId,
      status: "failed",
      failure: "login_expired",
    });
    expect(
      (await nextOf(job.push, "account_updated")).account,
      "认领早于重新授权也不妨碍：当前这一代死了",
    ).toMatchObject({ id: placed.id, login: "expired" });
    expect((await credentialsOf(s, placed.id))?.generation).toBe(2);
  });
});

const statesOf = (s: OAuthStack, o: Owner, platform: OAuthPlatform) =>
  s.database.db
    .select({ state: oauthStates.state })
    .from(oauthStates)
    .where(and(eq(oauthStates.ownerId, o.user.id), eq(oauthStates.platform, platform)));

describe("授权 state 的上限", () => {
  it("连发 50 次 start：这个人这个平台只留最新 5 条，最新那条回调照样能用", async () => {
    const s = await stack();
    const o = await owner(s, true);
    let authorize: URL | null = null;
    for (let i = 0; i < 50; i += 1) {
      authorize = redirectOf(await browse(o.client, `${o.client.origin}/api/oauth/github/start`));
    }
    if (authorize === null) throw new Error("没发起授权");
    const rows = await statesOf(s, o, "github");
    expect(rows.length, "只留最新 5 条").toBe(5);
    expect(
      rows.map((row) => row.state),
      "最新的 state 还在",
    ).toContain(authorize.searchParams.get("state"));

    const callback = redirectOf(await browse(o.client, authorize.href));
    const landed = redirectOf(await browse(o.client, callback.href));
    expect(landed.searchParams.get("result"), "最新那次授权走得通").toBe("connected");
    expect((await statesOf(s, o, "github")).length, "用掉的那条删了").toBe(4);
  });

  it("同一个人同时发起 20 次，也不越过 5 条", async () => {
    const s = await stack();
    const o = await owner(s, true);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => browse(o.client, `${o.client.origin}/api/oauth/x/start`)),
    );
    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 20 }, () => 302));
    expect((await statesOf(s, o, "x")).length).toBe(5);
  });

  it("挤掉最旧 state 的那条 SQL 走 (owner_id, platform, expires_at, state) 索引，不扫全表", async () => {
    const s = await stack();
    const target = await makeUser(s.database.db);
    await s.database.sql`
      INSERT INTO users (id, name, email, password_hash)
      SELECT 'other-' || g, '别人', 'other-' || g || '@baize.test', 'x' FROM generate_series(1, 2000) g`;
    await s.database.sql`
      INSERT INTO oauth_states (state, owner_id, platform, code_verifier, expires_at)
      SELECT 'state-' || g || '-' || k, 'other-' || g, 'github', 'v', now() + k * interval '1 minute'
      FROM generate_series(1, 2000) g, generate_series(1, 5) k`;
    await s.database.sql`
      INSERT INTO oauth_states (state, owner_id, platform, code_verifier, expires_at)
      SELECT 'mine-' || k, ${target.id}, 'github', 'v', now() + k * interval '1 minute' FROM generate_series(1, 6) k`;
    await s.database.sql`ANALYZE oauth_states`;

    const prune = pruneOverflow(s.database.db, target.id, "github").toSQL();
    const plan = (
      await s.database.sql.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN ${prune.sql}`,
        prune.params.map((value) => (typeof value === "number" ? value : String(value))),
      )
    )
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    expect(plan, "一万行里挑一个人的 5 条，不该全表扫").not.toContain("Seq Scan on oauth_states");
    expect(plan).toContain("oauth_states_owner_platform_idx");
  });
});

describe("代理碰到平台拒绝", () => {
  async function linked(s: OAuthStack): Promise<{ readonly o: Owner; readonly account: Account }> {
    const o = await owner(s, true);
    await connectPlatform(o.client, "github");
    return { o, account: await connected(o) };
  }

  const trail = (s: OAuthStack, before: number) =>
    s.fake
      .requests()
      .slice(before)
      .map((request) => [request.method, request.path, field(request.body, "grant_type") ?? null]);

  it("平台回 401：强制刷新一次，拿新令牌重试回 200，账号还是已登录", async () => {
    const s = await stack();
    const { o, account } = await linked(s);
    const before = s.fake.requests().length;

    s.fake.failNext(401, isRead);
    const response = await proxyFetch(o, `/${account.id}/user`);

    expect(response.status).toBe(200);
    expect(trail(s, before)).toEqual([
      ["GET", "/user", null],
      ["POST", "/login/oauth/access_token", "refresh_token"],
      ["GET", "/user", null],
    ]);
    const [rejected, , retried] = s.fake.requests().slice(before);
    expect(retried?.authorization, "重试用的是刷出来的新令牌").not.toBe(rejected?.authorization);
    await expectQuietUntilPlaceholder(o);
    expect((await accountsOf(o)).find((one) => one.id === account.id)?.login).toBe("valid");
  });

  it("刷新后重试还是 401：账号记过期，推一条通知，config 跟着变", async () => {
    const s = await stack();
    const { o, account } = await linked(s);
    const before = s.fake.requests().length;

    s.fake.failNext(401, isRead);
    s.fake.failNext(401, isRead);
    const response = await proxyFetch(o, `/${account.id}/user`);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("重新");
    expect(trail(s, before), "只刷一次、只重试一次").toEqual([
      ["GET", "/user", null],
      ["POST", "/login/oauth/access_token", "refresh_token"],
      ["GET", "/user", null],
    ]);
    expect((await nextOf(o.push, "account_updated")).account).toMatchObject({ id: account.id, login: "expired" });
    const notice = await nextOf(o.push, "notify");
    expect(notice.notice.kind).toBe("failed");
    expect(notice.notice.text).toContain("重新登录");
    expect((await o.agent.expect("config")).accounts.find((one) => one.id === account.id)?.login).toBe("expired");
    await expectQuietUntilPlaceholder(o);
    expect((await accountsOf(o)).find((one) => one.id === account.id)?.login).toBe("expired");
  });

  it("平台回 403：原样透传，不刷新，账号还是已登录", async () => {
    const s = await stack();
    const { o, account } = await linked(s);
    const before = s.fake.requests().length;

    s.fake.failNext(403, isRead);
    const response = await proxyFetch(o, `/${account.id}/repos/baize/private/issues`);

    expect(response.status).toBe(403);
    expect(trail(s, before)).toEqual([["GET", "/repos/baize/private/issues", null]]);
    await expectQuietUntilPlaceholder(o);
    expect((await accountsOf(o)).find((one) => one.id === account.id)?.login).toBe("valid");
  });
});

/** 在 1 秒内回来，不然就是在等数据库连接。 */
async function withinASecond<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 1 秒内没回来`)), 1000);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

describe("不同账号同时刷新", () => {
  it("十个账号同时刷新、令牌端点全挂住：无关接口和一条 select 1 都在 1 秒内回来，放行后十个都换到令牌", async () => {
    const s = await stack();
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    const linked: { readonly o: Owner; readonly account: Account }[] = [];
    for (let i = 0; i < 10; i += 1) {
      const o = await owner(s, false);
      await connectPlatform(o.client, "github");
      linked.push({ o, account: await connected(o) });
    }
    s.fake.setTokenLifetime(LONG_LIFETIME_S);
    const [first] = linked;
    if (first === undefined) throw new Error("没连上账号");

    const release = s.fake.hold(isRefresh);
    cleanups.push(release);
    const burst = linked.map(({ o, account }) => proxyFetch(o, `/${account.id}/user`));
    await waitFor(async () => refreshes(s).length > 0, "刷新挂在假平台上");
    // 测试库的连接池只有 4 条。刷新在事务里等平台的话，十个账号把 4 条全占住，下面两条都要等到平台超时。
    expect((await withinASecond(first.o.client.get("/api/me"), "/api/me")).status).toBe(200);
    expect(await withinASecond(s.database.sql`SELECT 1 AS one`, "select 1")).toEqual([{ one: 1 }]);
    release();

    expect((await Promise.all(burst)).map((response) => response.status)).toEqual(Array(10).fill(200));
    expect(refreshes(s), "每个账号刷一次").toHaveLength(10);

    // 十台电脑的下线要等控制面写完休眠再拆库，不然收尾的写入撞上已经删掉的库。
    for (const { o } of linked) o.close();
    await waitFor(async () => {
      const [row] = await s.database.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM computers WHERE status = 'online'`;
      return row?.count === 0;
    }, "十台电脑下线落库");
  });
});

describe("电脑报 OAuth 账号的登录状态", () => {
  it.each(["github", "x"] as const)(
    "%s 账号：电脑报 expired 或 valid 都整条丢掉，login 和代际都不动",
    async (platform) => {
      const s = await stack();
      const o = await owner(s, false);
      s.fake.setTokenLifetime(SHORT_LIFETIME_S);
      await connectPlatform(o.client, platform);
      const account = await connected(o);
      const created = await o.client.post("/api/accounts", {
        platform: "xiaohongshu",
        computerId: o.local.computerId,
      });
      expect(created.status).toBe(201);
      const placeholder = (await nextOf(o.push, "account_updated")).account;
      // 同一台电脑的上行帧按顺序处理：小红书那条的快照、login_failed 和通知先到，说明前一条已经处理完而且什么都没推。
      const report = async (
        state: { readonly login: "valid"; readonly handle: string } | { readonly login: "expired" },
      ) => {
        o.agent.send({ type: "login_state", accountId: account.id, state });
        o.agent.send({
          type: "login_state",
          accountId: placeholder.id,
          state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse(newId()) },
        });
        const pushed = await o.push.next();
        expect(pushed.type === "account_updated" && pushed.account.id, `电脑报 ${state.login} 不该推任何东西`).toBe(
          placeholder.id,
        );
        expect((await o.push.next()).type).toBe("login_failed");
        expect((await o.push.next()).type).toBe("notify");
      };

      await report({ login: "expired" });
      expect(await loginOf(o, account.id), "电脑说过期不算数").toBe("valid");
      expect((await credentialsOf(s, account.id))?.generation).toBe(1);

      s.fake.revoke();
      expect((await proxyFetch(o, `/${account.id}${WHOAMI[platform]}`)).status).toBe(409);
      expect((await nextOf(o.push, "account_updated")).account.login).toBe("expired");
      await nextNotice(o.push);

      await report({ login: "valid", handle: s.fake.handles[platform] });
      expect(await loginOf(o, account.id), "电脑说登上了也不算数，只有新一代凭据能带回 valid").toBe("expired");
      expect((await credentialsOf(s, account.id))?.generation).toBe(1);
    },
  );
});

describe("凭据落库之后", () => {
  it("重发 config 出错：页面照样 connected，账号已连上，错误只进日志", async () => {
    const s = await stack();
    const o = await owner(s, false);
    const logged = captureErrors();
    // 本机插件随 config 解密，损坏密文可确定触发重发失败。
    await s.database.db.insert(toolConnections).values({
      id: newId(),
      ownerId: o.user.id,
      name: "坏掉的工具",
      url: "https://tool.invalid/mcp",
      authorizationEnc: "不是密文",
      localOnly: true,
    });

    const { landed } = await connectPlatform(o.client, "github");

    expect(landed.searchParams.get("result"), "凭据已经落库，页面不能说失败").toBe("connected");
    const pushed = (await nextOf(o.push, "account_updated")).account;
    expect(pushed).toMatchObject({ platform: "github", login: "valid" });
    expect((await accountsOf(o)).map((one) => one.id)).toEqual([pushed.id]);
    expect((await credentialsOf(s, pushed.id))?.generation).toBe(1);
    expect(logged.join("\n"), "重发 config 的错误记下来").toContain("工具认证");
  });

  it("刷新把过期账号带回 valid 之后重发 config 出错：代理照样回 200，账号是新一代的 valid，错误只进日志", async () => {
    const s = await stack();
    const o = await owner(s, false);
    s.fake.setTokenLifetime(SHORT_LIFETIME_S);
    await connectPlatform(o.client, "github");
    const account = await connected(o);
    const logged = captureErrors();
    // 本机插件随 config 解密，损坏密文可确定触发重发失败。
    await s.database.db.insert(toolConnections).values({
      id: newId(),
      ownerId: o.user.id,
      name: "坏掉的工具",
      url: "https://tool.invalid/mcp",
      authorizationEnc: "不是密文",
      localOnly: true,
    });

    // 代理读到 valid 之后、刷新锁到账号行之前，账号被记过期：这趟刷新成功就是把它带回 valid 的那一下。
    const gate = await s.database.sql.reserve();
    let held = true;
    cleanups.push(async () => {
      if (held) await gate`ROLLBACK`;
      gate.release();
    });
    await gate`BEGIN`;
    await gate`SELECT id FROM accounts WHERE id = ${account.id} FOR UPDATE`;
    await gate`UPDATE accounts SET login = 'expired', login_changed_at = now() WHERE id = ${account.id}`;
    const response = proxyFetch(o, `/${account.id}/user`);
    await lockWaiters(s, 1, "代理的刷新排在记过期后面");
    await gate`COMMIT`;
    held = false;

    expect((await response).status, "新令牌已经落库，重发 config 出错不能把这趟请求变成 502").toBe(200);
    expect(refreshes(s), "刷新了一次").toHaveLength(1);
    expect((await nextOf(o.push, "account_updated")).account).toMatchObject({ id: account.id, login: "valid" });
    expect(await loginOf(o, account.id)).toBe("valid");
    expect((await credentialsOf(s, account.id))?.generation).toBe(2);
    expect(logged.join("\n"), "重发 config 的错误记下来").toContain(`账号 ${account.id} 刷新后重发 config 出错`);
  });
});

describe("account-add 和第一次授权交错", () => {
  it("account-add 在本机挂号还没提交时授权回调进来：同一个号最后只有一行", async () => {
    const s = await stack();
    const o = await owner(s, true);
    const handle = s.fake.handles.github;
    const release = await holdCredentials(s);

    const added = addAccountWithToken(
      s.database.db,
      new CredentialCrypto(TEST_CREDENTIALS_KEY),
      { ownerId: o.user.id, computerId: o.local.computerId, platform: "github", handle },
      "github_access_manual",
    );
    await lockWaiters(s, 1, "account-add 停在写凭据之前");
    const walk = connectPlatform(o.client, "github");
    await lockWaiters(s, 2, "授权回调排在后面");
    await release();
    await added;
    expect((await walk).landed.searchParams.get("result")).toBe("connected");

    const rows = await s.database.db
      .select({ id: accountRows.id, computerId: accountRows.computerId })
      .from(accountRows)
      .where(
        and(eq(accountRows.ownerId, o.user.id), eq(accountRows.platform, "github"), eq(accountRows.handle, handle)),
      );
    expect(rows, "同一个外部账号收敛到一行").toHaveLength(1);
    expect(rows[0]?.computerId, "授权回调把它挂到远程电脑").toBe(o.remote?.computerId);
  });

  it("授权回调在远程挂号还没提交时 account-add 进来：同一个号最后只有一行，account-add 写的是这一行的凭据", async () => {
    const s = await stack();
    const o = await owner(s, true);
    const handle = s.fake.handles.github;
    const release = await holdCredentials(s);

    const walk = connectPlatform(o.client, "github");
    await lockWaiters(s, 1, "授权回调建好行、停在写凭据之前");
    const added = addAccountWithToken(
      s.database.db,
      new CredentialCrypto(TEST_CREDENTIALS_KEY),
      { ownerId: o.user.id, computerId: o.local.computerId, platform: "github", handle },
      "github_access_manual",
    );
    await lockWaiters(s, 2, "account-add 排在后面");
    await release();
    expect((await walk).landed.searchParams.get("result")).toBe("connected");
    const account = await added;

    const rows = await s.database.db
      .select({ id: accountRows.id, computerId: accountRows.computerId })
      .from(accountRows)
      .where(
        and(eq(accountRows.ownerId, o.user.id), eq(accountRows.platform, "github"), eq(accountRows.handle, handle)),
      );
    expect(rows, "同一个外部账号收敛到一行").toEqual([{ id: account.id, computerId: o.remote?.computerId }]);
    expect(account.login).toBe("valid");
    expect((await credentialsOf(s, account.id))?.generation, "account-add 在授权那一代后面写下第二代").toBe(2);
  });
});
