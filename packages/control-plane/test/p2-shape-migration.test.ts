import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BotListResponse, MessageListResponse, UserId } from "@baize/shared";
import { expect, it } from "vitest";
import { migrationsDir, runMigrations } from "../src/db/migrate.js";
import { helloAgent } from "./helpers/agent.js";
import { ApiClient, startTestServer } from "./helpers/client.js";
import { hashPassword } from "../src/password.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer } from "./helpers/fixtures.js";

type ColumnRow = { table_name: string; column_name: string };

const columnsOf = async (database: TestDb, tables: readonly string[]): Promise<Set<string>> => {
  const rows = await database.sql<ColumnRow[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(${[...tables]})
  `;
  return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
};

/** 把 bots.tag 迁成 tags 的那个迁移文件，编号会被协调者重排，所以按内容找而不是按名字。 */
const findShapeMigration = async (): Promise<{ readonly file: string; readonly previous: string }> => {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).toSorted();
  for (const [index, file] of files.entries()) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    if (!sql.includes('ALTER TABLE "bots" DROP COLUMN "tag"')) continue;
    const previous = files[index - 1];
    if (previous === undefined) throw new Error(`${file} 前面没有别的迁移`);
    return { file, previous };
  }
  throw new Error("没有哪个迁移把 bots.tag 删掉");
};

it("空库从头跑通：Bot 只有 tags 列，例行只有 state 三列，第 2 期的四张表都在", async () => {
  const database = await createTestDb();
  try {
    const columns = await columnsOf(database, ["bots", "routines", "routine_runs", "tasks"]);
    expect(
      [...columns]
        .filter((name) => /^(bots\.tags?|routines\.(enabled|state|boundary|on_today))$/.test(name))
        .toSorted(),
    ).toEqual(["bots.tags", "routines.boundary", "routines.on_today", "routines.state"]);
    expect(columns.has("routine_runs.seen_at")).toBe(true);
    expect(
      ["goal_target", "goal_unit", "goal_due_at", "metric_source"].every((column) => columns.has(`tasks.${column}`)),
    ).toBe(true);
    const tables = await database.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('metric_samples', 'project_reviews', 'bot_preferences', 'brand_books')
    `;
    expect(tables.map((row) => row.table_name).toSorted()).toEqual([
      "bot_preferences",
      "brand_books",
      "metric_samples",
      "project_reviews",
    ]);
  } finally {
    await database.close();
  }
});

it("带第 1 期数据的库：非空 tag 变成单元素数组，空 tag 变成空数组，enabled 变成 on 或 paused", async () => {
  const { file, previous } = await findShapeMigration();
  const database = await createTestDb({ through: previous });
  try {
    await database.sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '陈', 'chen@baize.dev', 'x')`;
    await database.sql`
      INSERT INTO bots (id, owner_id, name, hue, tag) VALUES
        ('b-tagged', 'u1', '小服', 'sky', '客服'),
        ('b-blank', 'u1', '小白', 'sky', '')
    `;
    await database.sql`
      INSERT INTO routines (id, bot_id, name, instruction, enabled) VALUES
        ('r-on', 'b-tagged', '早报', '汇总', true),
        ('r-off', 'b-tagged', '周报', '汇总', false)
    `;

    const applied = await runMigrations(database.sql);
    expect(applied, "应实际应用形状迁移").toContain(file);

    const bots = await database.sql<{ id: string; tags: string[] }[]>`SELECT id, tags FROM bots ORDER BY id`;
    expect(bots).toEqual([
      { id: "b-blank", tags: [] },
      { id: "b-tagged", tags: ["客服"] },
    ]);
    const routines = await database.sql<{ id: string; state: string; boundary: string; on_today: boolean }[]>`
      SELECT id, state, boundary, on_today FROM routines ORDER BY id
    `;
    expect(routines).toEqual([
      { id: "r-off", state: "paused", boundary: "draft", on_today: false },
      { id: "r-on", state: "on", boundary: "draft", on_today: false },
    ]);
    const columns = await columnsOf(database, ["bots", "routines"]);
    expect(columns.has("bots.tag"), "旧的 tag 列要删掉").toBe(false);
    expect(columns.has("routines.enabled"), "旧的 enabled 列要删掉").toBe(false);
  } finally {
    await database.close();
  }
});

const OLD_CARD = {
  kind: "project_offer",
  botId: "b-assistant",
  name: "推广",
  goal: "1000 星",
  team: [
    { name: "小文", tag: "文案", description: "写笔记" },
    { name: "小空", tag: "", description: "" },
    { name: "小长", tag: "12345678901234567890", description: "" },
  ],
  platforms: [],
  cadence: "每周",
  firstStep: "读资料",
  groupId: null,
};

it("第 1 期合法的长标签和旧方案卡迁移后读得通：领域解析、HTTP 列表、群历史和 config 都认", async () => {
  const { previous } = await findShapeMigration();
  const database = await createTestDb({ through: previous });
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    // 不走 createUser：它顺手建主助理，走的是新 schema 的 tags 列，这时库还在第 1 期。
    const user = { id: UserId.parse("u-p1"), email: "p1@baize.dev", password: "p1-password" };
    await database.sql`
      INSERT INTO users (id, name, email, password_hash) VALUES (${user.id}, '陈', ${user.email}, ${await hashPassword(user.password)})
    `;
    await database.sql`INSERT INTO user_counters (user_id) VALUES (${user.id})`;
    await database.sql`INSERT INTO settings (user_id) VALUES (${user.id})`;
    const tagged = [
      ["b-9", "123456789"],
      ["b-20", "12345678901234567890"],
      ["b-emoji", "😀😀😀😀😀"],
    ] as const;
    for (const [id, tag] of tagged) {
      await database.sql`INSERT INTO bots (id, owner_id, name, hue, tag) VALUES (${id}, ${user.id}, ${id}, 'sky', ${tag})`;
      await database.sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES (${`g-${id}`}, ${user.id}, ${id})`;
      await database.sql`INSERT INTO group_members (group_id, bot_id, position) VALUES (${`g-${id}`}, ${id}, 0)`;
    }
    await database.sql`
      INSERT INTO bots (id, owner_id, name, hue, tag, role) VALUES ('b-assistant', ${user.id}, '主助理', 'sky', '', 'assistant')
    `;
    await database.sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES ('g-card', ${user.id}, 'b-assistant')`;
    await database.sql`INSERT INTO group_members (group_id, bot_id, position) VALUES ('g-card', 'b-assistant', 0)`;
    await database.sql`INSERT INTO tasks (id, group_id, number, title) VALUES ('t-card', 'g-card', 'T-1100', '旧项目')`;
    for (const [index, status] of ["offered", "started", "dismissed"].entries()) {
      await database.sql`
        INSERT INTO messages (id, group_id, body, created_at)
        VALUES (${`m-${status}`}, 'g-card', ${JSON.stringify({ ...OLD_CARD, status })}::jsonb, ${new Date(1_700_000_000_000 + index * 1000).toISOString()})
      `;
    }

    await runMigrations(database.sql);

    const teams = await database.sql<
      { id: string; team: unknown }[]
    >`SELECT id, body->'team' AS team FROM messages ORDER BY id`;
    const migratedTeam = [
      { name: "小文", tags: ["文案"], description: "写笔记" },
      { name: "小空", tags: [], description: "" },
      { name: "小长", tags: ["12345678901234567890"], description: "" },
    ];
    expect(teams, "三种状态的旧卡成员都换成 tags，旧键删掉，顺序、名字和描述不动").toEqual([
      { id: "m-dismissed", team: migratedTeam },
      { id: "m-offered", team: migratedTeam },
      { id: "m-started", team: migratedTeam },
    ]);

    server = await startTestServer(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = new ApiClient(server.server.port);
    expect((await client.login(user.email, user.password)).status).toBe(200);

    const listed = await client.get("/api/bots");
    expect(listed.status, "Bot 列表经过 toBot 和最新一条消息，长标签和旧卡都不能让它 500").toBe(200);
    const items = BotListResponse.parse(await listed.json()).items;
    expect(Object.fromEntries(items.map((item) => [item.bot.id, item.bot.tags]))).toEqual({
      "b-9": ["123456789"],
      "b-20": ["12345678901234567890"],
      "b-emoji": ["😀😀😀😀😀"],
      "b-assistant": [],
    });

    const history = await client.get("/api/groups/g-card/messages");
    expect(history.status).toBe(200);
    const cards = MessageListResponse.parse(await history.json()).messages.map((message) => message.body);
    expect(cards.map((body) => (body.kind === "project_offer" ? [body.status, body.team] : body.kind))).toEqual([
      ["offered", migratedTeam],
      ["started", migratedTeam],
      ["dismissed", migratedTeam],
    ]);

    const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
    try {
      expect(Object.fromEntries(config.bots.map((bot) => [bot.id, bot.tags]))).toEqual({
        "b-9": ["123456789"],
        "b-20": ["12345678901234567890"],
        "b-emoji": ["😀😀😀😀😀"],
        "b-assistant": [],
      });
    } finally {
      agent.close();
    }
  } finally {
    await server?.close();
    await database.close();
  }
});

/** 第 1 期的校验放过的非常规旧卡成员：已经是数组形 tags，有的还带旧 tag 键。迁移后 tags 要留住，tag 键一律不留。 */
const migrateOfferTeam = async (team: readonly unknown[]): Promise<unknown> => {
  const { previous } = await findShapeMigration();
  const database = await createTestDb({ through: previous });
  try {
    await database.sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '陈', 'chen@baize.dev', 'x')`;
    await database.sql`INSERT INTO bots (id, owner_id, name, hue, tag, role) VALUES ('b-assistant', 'u1', '主助理', 'sky', '', 'assistant')`;
    await database.sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES ('g-card', 'u1', 'b-assistant')`;
    await database.sql`
      INSERT INTO messages (id, group_id, body, created_at)
      VALUES ('m-card', 'g-card', ${JSON.stringify({ ...OLD_CARD, status: "offered", team })}::jsonb, ${new Date(1_700_000_000_000).toISOString()})
    `;
    await runMigrations(database.sql);
    const [row] = await database.sql<
      { team: unknown }[]
    >`SELECT body->'team' AS team FROM messages WHERE id = 'm-card'`;
    return row?.team;
  } finally {
    await database.close();
  }
};

it("旧卡成员只有数组形 tags：原数组原样保留", async () => {
  expect(await migrateOfferTeam([{ name: "小文", description: "写笔记", tags: ["已有", "标签"] }])).toEqual([
    { name: "小文", description: "写笔记", tags: ["已有", "标签"] },
  ]);
});

it("旧卡成员 tags 加一个不同的 tag：tag 放最前，已有的跟在后面，tag 键删掉", async () => {
  expect(
    await migrateOfferTeam([{ name: "小文", description: "写笔记", tag: "文案", tags: ["已有", "标签"] }]),
  ).toEqual([{ name: "小文", description: "写笔记", tags: ["文案", "已有", "标签"] }]);
});

it("旧卡成员 tags 加空串 tag：原数组原样保留，tag 键删掉", async () => {
  expect(await migrateOfferTeam([{ name: "小文", description: "写笔记", tag: "", tags: ["已有", "标签"] }])).toEqual([
    { name: "小文", description: "写笔记", tags: ["已有", "标签"] },
  ]);
});

it("旧卡成员 tags 加 tag 的两个边界：tag 已在 tags 里不重复，tags 已满 5 项不再加", async () => {
  const full = ["一", "二", "三", "四", "五"];
  expect(
    await migrateOfferTeam([
      { name: "小文", description: "", tag: "标签", tags: ["已有", "标签"] },
      { name: "小满", description: "", tag: "新", tags: full },
    ]),
  ).toEqual([
    { name: "小文", description: "", tags: ["已有", "标签"] },
    { name: "小满", description: "", tags: full },
  ]);
});
