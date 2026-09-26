import { BotListResponse, LoginResponse } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { addAccount } from "../src/repo/accounts.js";
import { DEV_EMAIL, DEV_PASSWORD, seed } from "../src/seed.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser } from "./helpers/fixtures.js";

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

describe("迁移", () => {
  it("在建好的库上重跑不再应用任何文件", async () => {
    const again = await runMigrations(database.sql);
    expect(again, "第二次跑迁移应当一个文件都不应用").toEqual([]);
  });

  it("停在 0014 且已有凭据的库，只跑 0015 之后旧凭据算第一代", async () => {
    const older = await createTestDb();
    try {
      await older.sql.unsafe('DROP TABLE "oauth_states"');
      await older.sql.unsafe('ALTER TABLE "account_credentials" DROP COLUMN "generation"');
      await older.sql`DELETE FROM _migrations WHERE name = '0015_p1_5_oauth_states.sql'`;

      const user = await makeUser(older.db);
      const computer = await makeComputer(older.db, user.id);
      const account = await addAccount(older.db, {
        ownerId: user.id,
        computerId: computer.computerId,
        platform: "github",
        handle: "老凭据",
      });
      await older.sql`
        INSERT INTO account_credentials (account_id, access_enc, scope, updated_at)
        VALUES (${account.id}, 'enc:old', 'repo', now())
      `;

      const applied = await runMigrations(older.sql);
      expect(applied, "只该补上 0015 这一个文件").toEqual(["0015_p1_5_oauth_states.sql"]);
      const [row] = await older.sql<{ generation: number }[]>`
        SELECT generation FROM account_credentials WHERE account_id = ${account.id}
      `;
      expect(row?.generation, "升级前就有的凭据算第一代").toBe(1);
    } finally {
      await older.close();
    }
  });

  it("建出二十五张业务表加一张迁移记账表", async () => {
    const rows = await database.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    // 库的排序规则不确定，下划线开头的表位置会变，所以在 JS 里排。
    expect(rows.map((r) => r.table_name).toSorted()).toEqual([
      "_migrations",
      "account_credentials",
      "accounts",
      "approvals",
      "bots",
      "computers",
      "content_plans",
      "drafts",
      "grants",
      "group_members",
      "groups",
      "handoffs",
      "messages",
      "oauth_states",
      "publications",
      "routine_runs",
      "routines",
      "runs",
      "sessions",
      "settings",
      "skills",
      "tasks",
      "tool_connection_bots",
      "tool_connections",
      "user_counters",
      "users",
    ]);
  });
});

describe("seed", () => {
  it("建出开发账号和三个 Bot，各带一条示例消息", async () => {
    const result = await seed(database.db);
    expect(result.createdUser).toBe(true);
    expect(result.createdBots).toEqual(["小服", "小销", "小采"]);

    const client = server.client();
    const login = await client.login(DEV_EMAIL, DEV_PASSWORD);
    expect(login.status).toBe(200);
    expect(LoginResponse.parse(await login.json()).user.email).toBe(DEV_EMAIL);

    const list = BotListResponse.parse(await (await client.get("/api/bots")).json());
    expect(
      list.items.map((i) => i.bot.name),
      "开发账号和注册的用户一样先有主助理",
    ).toEqual(["主助理", "小服", "小销", "小采"]);
    expect(list.items.map((i) => i.bot.tag)).toEqual(["", "客服", "销售", "采购"]);
    expect(
      list.items.map((i) => i.lastMessage?.body.kind),
      "主助理先开口，三个队员各有一条示例消息",
    ).toEqual(["bot", "user", "user", "user"]);
  });

  it("第二次跑不重复建", async () => {
    const before = await seed(database.db);
    const again = await seed(database.db);

    expect(again.createdUser).toBe(false);
    expect(again.createdBots, "第二次不应当再建 Bot").toEqual([]);
    expect(again.user.id).toBe(before.user.id);

    const client = server.client();
    await client.login(DEV_EMAIL, DEV_PASSWORD);
    const list = BotListResponse.parse(await (await client.get("/api/bots")).json());
    expect(
      list.items.map((i) => i.bot.name),
      "重复 seed 不应当多出 Bot，主助理也只有一个",
    ).toEqual(["主助理", "小服", "小销", "小采"]);
  });

  it("上一次只建了一半时补齐缺的那个", async () => {
    await seed(database.db);
    const client = server.client();
    await client.login(DEV_EMAIL, DEV_PASSWORD);

    const before = BotListResponse.parse(await (await client.get("/api/bots")).json());
    const victim = before.items.find((i) => i.bot.name === "小销");
    expect(victim).toBeDefined();
    expect((await client.delete(`/api/bots/${victim?.bot.id}`)).status).toBe(204);

    const again = await seed(database.db);
    expect(again.createdUser, "账号还在就不重建").toBe(false);
    expect(again.createdBots, "缺的那个要补回来").toEqual(["小销"]);

    const after = BotListResponse.parse(await (await client.get("/api/bots")).json());
    expect(new Set(after.items.map((i) => i.bot.name))).toEqual(new Set(["主助理", "小服", "小销", "小采"]));
  });
});
