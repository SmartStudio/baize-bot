import { ApiError, ComputerListResponse, ComputerTokenResponse, type ComputerId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_EMAIL, DEV_PASSWORD, seed } from "../src/seed.js";
import {
  authenticateComputer,
  findComputerByOwner,
  markComputerOnline,
  rotateGatewayKey,
} from "../src/repo/computers.js";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, waitFor } from "./helpers/fixtures.js";

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

describe("电脑归属", () => {
  it("首次登录建出一台 creating 的电脑", async () => {
    const user = await makeUser(database.db);
    expect(await findComputerByOwner(database.db, user.id), "登录之前不该有电脑").toBeNull();

    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);

    const computer = ComputerListResponse.parse(await (await client.get("/api/computers")).json()).computers[0];
    if (computer === undefined) throw new Error("登录后应有本机电脑");
    expect(computer.ownerId).toBe(user.id);
    expect(computer.status).toBe("creating");
    expect(computer.host).toBeNull();
    expect(computer.lastSeenAt).toBeNull();
  });

  it("再登录一次不多建一台", async () => {
    const user = await makeUser(database.db);
    const client = server.client();

    await client.login(user.email, PASSWORD);
    const first = ComputerListResponse.parse(await (await client.get("/api/computers")).json()).computers[0];
    await client.login(user.email, PASSWORD);
    const second = ComputerListResponse.parse(await (await client.get("/api/computers")).json()).computers[0];

    expect(second?.id).toBe(first?.id);
    const rows = await database.sql<{ n: string }[]>`SELECT count(*) AS n FROM computers WHERE owner_id = ${user.id}`;
    expect(rows[0]?.n).toBe("1");
  });

  it("一人一台，两个用户各自一台", async () => {
    const one = server.client();
    const two = server.client();
    const userOne = await makeUser(database.db);
    const userTwo = await makeUser(database.db);
    await one.login(userOne.email, PASSWORD);
    await two.login(userTwo.email, PASSWORD);

    const first = ComputerListResponse.parse(await (await one.get("/api/computers")).json()).computers[0];
    const second = ComputerListResponse.parse(await (await two.get("/api/computers")).json()).computers[0];
    expect(first?.id).not.toBe(second?.id);
  });

  it("没登录时返回 401", async () => {
    const response = await server.client().get("/api/computers");
    expect(response.status).toBe(401);
    ApiError.parse(await response.json());
  });
});

describe("token", () => {
  it("未登录不能取得本机 token", async () => {
    const response = await server.client().post("/api/computers/local");
    expect(response.status).toBe(401);
    ApiError.parse(await response.json());
  });

  it("本机 token 只在响应里出现一次，再查不到明文", async () => {
    const user = await makeUser(database.db);
    const client = server.client();
    await client.login(user.email, PASSWORD);

    const response = await client.post("/api/computers/local");
    expect(response.status).toBe(200);
    const raw = await response.text();
    const local = ComputerTokenResponse.parse(JSON.parse(raw));
    expect(raw.split(local.token)).toHaveLength(2);

    const stored = await database.sql<Record<string, unknown>[]>`
      SELECT * FROM computers WHERE owner_id = ${user.id}
    `;
    expect(JSON.stringify(stored), "数据库行里不能出现 token 明文").not.toContain(local.token);

    const visible = await client.get("/api/computers");
    expect(await visible.text(), "后续查询不能再拿到 token 明文").not.toContain(local.token);

    const connected = await helloAgent(server.server.port, local.computerId, local.token);
    connected.agent.close();
  });

  it("库里只存哈希，明文不落库", async () => {
    const user = await makeUser(database.db);
    await server.client().login(user.email, PASSWORD);

    const rows = await database.sql<{ token_hash: string; gateway_key_hash: string }[]>`
      SELECT token_hash, gateway_key_hash FROM computers WHERE owner_id = ${user.id}
    `;
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.gateway_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(rows[0]?.gateway_key_hash);
  });

  it("认不出编造的 token", async () => {
    const user = await makeUser(database.db);
    await server.client().login(user.email, PASSWORD);
    const computer = await findComputerByOwner(database.db, user.id);
    if (computer === null) throw new Error("登录之后电脑应当已经建出来");

    expect(await authenticateComputer(database.db, computer.id, "a".repeat(64))).toBeNull();
  });
});

describe("seed", () => {
  it("给开发账号建电脑并交出 token 明文", async () => {
    const result = await seed(database.db);
    expect(result.computerToken, "第一次 seed 要给出可复制的 token").not.toBeNull();

    const authenticated = await authenticateComputer(database.db, result.computerId, result.computerToken ?? "");
    expect(authenticated?.ownerId).toBe(result.user.id);

    const client = server.client();
    await client.login(DEV_EMAIL, DEV_PASSWORD);
    expect(ComputerListResponse.parse(await (await client.get("/api/computers")).json()).computers[0]?.id).toBe(
      result.computerId,
    );
  });

  it("第二次 seed 不重建电脑也不再给 token", async () => {
    const before = await seed(database.db);
    const again = await seed(database.db);

    expect(again.computerId).toBe(before.computerId);
    expect(again.computerToken, "电脑已经在了就拿不到明文，要重置才有").toBeNull();
  });
});

async function statusOf(computerId: ComputerId): Promise<string | undefined> {
  const rows = await database.sql<{ status: string }[]>`SELECT status FROM computers WHERE id = ${computerId}`;
  return rows[0]?.status;
}

describe("在线状态不跨进程留存", () => {
  it("关服务时先把连着的电脑标成休眠再断连接", async () => {
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const own = await startTestServer(database.db);
    const { agent } = await helloAgent(own.server.port, computer.computerId, computer.token);

    try {
      await waitFor(async () => (await statusOf(computer.computerId)) === "online", "电脑握手后变在线");
      await own.close();
      expect(await statusOf(computer.computerId), "关服务返回时就该是休眠，不能等 socket 回调").toBe("sleeping");
    } finally {
      agent.close();
    }
  });

  it("起服务时把上次没关干净留下的在线改成休眠", async () => {
    const stale = await makeComputer(database.db, (await makeUser(database.db)).id);
    // 照 hello 的样子留下一条在线：先轮换网关 key，再带着它写上线。
    await markComputerOnline(database.db, stale.computerId, await rotateGatewayKey(database.db, stale.computerId));
    const untouched = await makeComputer(database.db, (await makeUser(database.db)).id);

    const own = await startTestServer(database.db);
    try {
      expect(await statusOf(stale.computerId), "进程刚起不可能有连接，库里的在线只能是残留").toBe("sleeping");
      expect(await statusOf(untouched.computerId), "只翻在线那些，别的状态不动").toBe("creating");
    } finally {
      await own.close();
    }
  });
});
