import {
  AccountId,
  AccountListResponse,
  ComputerTokenResponse,
  LoginAccountResponse,
  LoginAttemptId,
  TodayResponse,
  type ComputerId,
  type LoginFailure,
  type Notice,
  type ServerPush,
  type UserId,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

type Owner = {
  readonly userId: UserId;
  readonly client: ApiClient;
  readonly computer: TestComputer;
};

async function makeOwner(): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return { userId: user.id, client, computer };
}

async function validAccount(owner: Owner, computerId: ComputerId = owner.computer.computerId): Promise<AccountId> {
  const accountId = AccountId.parse(newId());
  await database.db.insert(accounts).values({
    id: accountId,
    ownerId: owner.userId,
    computerId,
    platform: "xiaohongshu",
    handle: "@小红",
    login: "valid",
    tier: "confirm_publish",
  });
  return accountId;
}

async function nextNotice(push: PushClient): Promise<Notice> {
  for (;;) {
    const pushed = await push.next();
    if (pushed.type === "notify") return pushed.notice;
  }
}

async function online(owner: Owner): Promise<{ readonly agent: AgentClient; readonly push: PushClient }> {
  const push = await connectPush(server.server.port, owner.client.cookie ?? "");
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  return { agent, push };
}

async function pendingAccounts(owner: Owner): Promise<readonly string[]> {
  const today = TodayResponse.parse(await (await owner.client.get("/api/today")).json());
  return today.pending.flatMap((item) => (item.kind === "account" ? [item.account.id] : []));
}

async function nextOf<K extends ServerPush["type"]>(
  push: PushClient,
  type: K,
): Promise<Extract<ServerPush, { type: K }>> {
  for (;;) {
    const pushed = await push.next();
    if (pushed.type === type) return pushed as Extract<ServerPush, { type: K }>;
  }
}

describe("login_state failed", () => {
  it("登录没成推 login_failed，accountId、attempt 和 reason 都是这一次点击的", async () => {
    const owner = await makeOwner();
    const accountId = await validAccount(owner);
    const { agent, push } = await online(owner);

    try {
      const attempt = LoginAttemptId.parse(newId());
      const response = await owner.client.post(`/api/accounts/${accountId}/login`, { attempt });
      expect(response.status).toBe(202);
      expect(LoginAccountResponse.parse(await response.json()).attempt).toBe(attempt);
      expect((await agent.expect("browser_login")).attempt, "电脑拿到的是页面取的那个号").toBe(attempt);

      agent.send({ type: "login_state", accountId, state: { login: "failed", reason: "remote_refused", attempt } });
      const failed = await nextOf(push, "login_failed");
      expect(failed, "页面按这三样把卡结算到那一次点击上").toEqual({
        type: "login_failed",
        accountId,
        attempt,
        reason: "remote_refused",
      });
      expect((await nextOf(push, "notify")).notice.kind, "给人看的通知照旧").toBe("failed");
    } finally {
      agent.close();
      push.close();
    }
  });

  it("登录没成记在账号上：推 account_updated，刷新后 GET 还带着；再没成换成新的，登上之后清掉", async () => {
    const owner = await makeOwner();
    const accountId = await validAccount(owner);
    const { agent, push } = await online(owner);
    const listed = async () =>
      AccountListResponse.parse(await (await owner.client.get("/api/accounts")).json()).accounts.find(
        (account) => account.id === accountId,
      );
    const failed = (reason: LoginFailure, attempt: string) =>
      agent.send({
        type: "login_state",
        accountId,
        state: { login: "failed", reason, attempt: LoginAttemptId.parse(attempt) },
      });

    try {
      expect((await listed())?.lastLoginFailure, "还没失败过").toBeNull();

      failed("window_failed", "try-1");
      const first = (await nextOf(push, "account_updated")).account;
      expect(first.lastLoginFailure?.reason, "页面不刷新也收到这次的原因").toBe("window_failed");
      expect(first.login, "登录没成不改登录状态").toBe("valid");
      expect((await nextOf(push, "login_failed")).attempt, "卡照样按这一次结算").toBe("try-1");
      expect(await listed(), "刷新页面重新拉账号，痕迹还在").toEqual(first);

      failed("remote_refused", "try-2");
      const second = (await nextOf(push, "account_updated")).account;
      expect(second.lastLoginFailure?.reason, "只留最近一次").toBe("remote_refused");
      expect(Date.parse(second.lastLoginFailure?.at ?? ""), "时刻跟着这一次走").toBeGreaterThanOrEqual(
        Date.parse(first.lastLoginFailure?.at ?? ""),
      );

      agent.send({ type: "login_state", accountId, state: { login: "valid", handle: "@小红" } });
      const loggedIn = (await nextOf(push, "account_updated")).account;
      expect(loggedIn.lastLoginFailure, "登上了，推出去的快照不再带痕迹").toBeNull();
      expect((await listed())?.lastLoginFailure, "库里也清掉了").toBeNull();
      await agent.expect("config");
    } finally {
      agent.close();
      push.close();
    }
  });

  it("登录窗口出错：账号还是有效，用户收到一句中文原因", async () => {
    const owner = await makeOwner();
    const accountId = await validAccount(owner);
    const { agent, push } = await online(owner);

    try {
      agent.send({
        type: "login_state",
        accountId,
        state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
      });

      const notice = await nextNotice(push);
      expect(notice.kind, "没办成要用户处理，不能显示成「做完了」").toBe("failed");
      expect(notice.groupId, "账号不在哪个群里").toBeNull();
      expect(notice.text).toContain("小红书");
      expect(notice.text).toContain("登录窗口");
      expect(notice.text, "登录失败不等于过期，不能让用户以为要重新授权").toContain("账号状态没变");
      expect(await pendingAccounts(owner), "账号没被改成过期，「今天」不会让他去重新登录").toEqual([]);

      agent.send({
        type: "login_state",
        accountId,
        state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
      });
      expect((await nextNotice(push)).kind, "再点一次又没成，照样再推一条，不像电脑掉线那样一段只推一次").toBe(
        "failed",
      );
    } finally {
      agent.close();
      push.close();
    }
  });

  it("远程电脑拒绝登录：告诉用户去本机登录", async () => {
    const owner = await makeOwner();
    const accountId = await validAccount(owner);
    const { agent, push } = await online(owner);

    try {
      agent.send({
        type: "login_state",
        accountId,
        state: { login: "failed", reason: "remote_refused", attempt: LoginAttemptId.parse("try-1") },
      });

      const notice = await nextNotice(push);
      expect(notice.kind, "没办成要用户处理，不能显示成「做完了」").toBe("failed");
      expect(notice.text).toContain("远程电脑");
      expect(notice.text).toContain("本机");
      expect(await pendingAccounts(owner)).toEqual([]);
    } finally {
      agent.close();
      push.close();
    }
  });

  it("不是这台电脑上的账号，整条静默丢掉", async () => {
    const owner = await makeOwner();
    const stranger = await makeOwner();
    const strangersAccount = await validAccount(stranger);
    const accountId = await validAccount(owner);
    const mine = await online(owner);
    const theirs = await online(stranger);

    try {
      mine.agent.send({
        type: "login_state",
        accountId: strangersAccount,
        state: { login: "failed", reason: "remote_refused", attempt: LoginAttemptId.parse("try-1") },
      });
      mine.agent.send({
        type: "login_state",
        accountId,
        state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
      });
      expect((await nextNotice(mine.push)).text, "别人账号那条没有推给这台电脑的主人").toContain("登录窗口");

      theirs.agent.send({
        type: "login_state",
        accountId: strangersAccount,
        state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
      });
      expect((await nextNotice(theirs.push)).text, "也没有推给账号的主人，他收到的第一条是自己电脑发的").toContain(
        "登录窗口",
      );
    } finally {
      for (const side of [mine, theirs]) {
        side.agent.close();
        side.push.close();
      }
    }
  });

  it("同一个人的另一台电脑报这个账号，也整条丢掉", async () => {
    const owner = await makeOwner();
    const onLocal = await validAccount(owner);
    const remote = ComputerTokenResponse.parse(await (await owner.client.post("/api/computers/remote")).json());
    const onRemote = await validAccount(owner, remote.computerId);
    const push = await connectPush(server.server.port, owner.client.cookie ?? "");
    const { agent } = await helloAgent(server.server.port, remote.computerId, remote.token);

    try {
      agent.send({
        type: "login_state",
        accountId: onLocal,
        state: { login: "failed", reason: "remote_refused", attempt: LoginAttemptId.parse("try-1") },
      });
      agent.send({
        type: "login_state",
        accountId: onRemote,
        state: { login: "failed", reason: "window_failed", attempt: LoginAttemptId.parse("try-1") },
      });
      expect(
        (await nextNotice(push)).text,
        "本机账号那条没推：远程电脑管不到本机的登录窗口，推了用户会被一条无关的失败吓到",
      ).toContain("登录窗口");
    } finally {
      agent.close();
      push.close();
    }
  });
});
