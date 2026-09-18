import { ApiError, Computer } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_EMAIL, DEV_PASSWORD, seed } from "../src/seed.js";
import { authenticateComputer, findComputerByOwner } from "../src/repo/computers.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";

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

    const computer = Computer.parse(await (await client.get("/api/computer")).json());
    expect(computer.ownerId).toBe(user.id);
    expect(computer.status).toBe("creating");
    expect(computer.host).toBeNull();
    expect(computer.lastSeenAt).toBeNull();
  });

  it("再登录一次不多建一台", async () => {
    const user = await makeUser(database.db);
    const client = server.client();

    await client.login(user.email, PASSWORD);
    const first = Computer.parse(await (await client.get("/api/computer")).json());
    await client.login(user.email, PASSWORD);
    const second = Computer.parse(await (await client.get("/api/computer")).json());

    expect(second.id).toBe(first.id);
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

    const first = Computer.parse(await (await one.get("/api/computer")).json());
    const second = Computer.parse(await (await two.get("/api/computer")).json());
    expect(first.id).not.toBe(second.id);
  });

  it("没登录时返回 401", async () => {
    const response = await server.client().get("/api/computer");
    expect(response.status).toBe(401);
    ApiError.parse(await response.json());
  });
});

describe("token", () => {
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
    expect(Computer.parse(await (await client.get("/api/computer")).json()).id).toBe(result.computerId);
  });

  it("第二次 seed 不重建电脑也不再给 token", async () => {
    const before = await seed(database.db);
    const again = await seed(database.db);

    expect(again.computerId).toBe(before.computerId);
    expect(again.computerToken, "电脑已经在了就拿不到明文，要重置才有").toBeNull();
  });
});
