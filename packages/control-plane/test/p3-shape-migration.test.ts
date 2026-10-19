import { MessageListResponse, UserId } from "@baize/shared";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { hashPassword } from "../src/password.js";
import { ApiClient, startTestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";

const SHAPE_MIGRATION = "0026_p3_shape.sql";
const PREVIOUS_MIGRATION = "0025_p2_budget.sql";

type ColumnRow = { table_name: string; column_name: string };

const columnsOf = async (database: TestDb, tables: readonly string[]): Promise<Set<string>> => {
  const rows = await database.sql<ColumnRow[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(${[...tables]})
  `;
  return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
};

const indexesOf = async (database: TestDb, table: string): Promise<Set<string>> => {
  const rows = await database.sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}
  `;
  return new Set(rows.map((row) => row.indexname));
};

const POKER_TABLES = [
  "poker_act_receipts",
  "poker_events",
  "poker_hands",
  "poker_hints",
  "poker_sessions",
  "poker_tables",
];

it("空库从头跑通：三张老表各加了列，六张牌局表都在，带条件的唯一索引都建了", async () => {
  const database = await createTestDb();
  try {
    const columns = await columnsOf(database, ["bots", "messages", "runs", ...POKER_TABLES]);
    expect(
      ["bots.preset", "messages.visible_to", "runs.visible_to", "runs.table_role"].every((name) => columns.has(name)),
    ).toBe(true);
    const tables = await database.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'poker_%'
    `;
    expect(tables.map((row) => row.table_name).toSorted()).toEqual(POKER_TABLES);
    expect(columns.has("poker_hands.seed"), "seed 列在库里，但永远不出控制面").toBe(true);
    expect([...(await indexesOf(database, "runs"))].filter((name) => name.startsWith("runs_table")).toSorted()).toEqual(
      ["runs_table_bot_open_idx", "runs_table_role_open_idx"],
    );
    expect((await indexesOf(database, "bots")).has("bots_owner_id_preset_idx")).toBe(true);
    expect((await indexesOf(database, "poker_sessions")).has("poker_sessions_group_id_open_idx")).toBe(true);
    expect((await indexesOf(database, "poker_hands")).has("poker_hands_group_id_playing_idx")).toBe(true);
  } finally {
    await database.close();
  }
});

it("messages.visible_to 为空数组的行被数据库拒绝，null 和至少一个人的数组都收", async () => {
  const database = await createTestDb();
  try {
    await database.sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '陈', 'chen@baize.dev', 'x')`;
    await database.sql`INSERT INTO bots (id, owner_id, name, hue, shape) VALUES ('b1', 'u1', '小服', 'sky', 'pillow')`;
    await database.sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES ('g1', 'u1', 'b1')`;
    const body = JSON.stringify({ kind: "user", text: "嗨" });
    await database.sql`INSERT INTO messages (id, group_id, body, created_at, visible_to) VALUES ('m-all', 'g1', ${body}::jsonb, now(), NULL)`;
    await database.sql`
      INSERT INTO messages (id, group_id, body, created_at, visible_to)
      VALUES ('m-one', 'g1', ${body}::jsonb, now(), ${JSON.stringify([{ kind: "bot", botId: "b1" }])}::jsonb)
    `;
    await expect(
      database.sql`INSERT INTO messages (id, group_id, body, created_at, visible_to) VALUES ('m-none', 'g1', ${body}::jsonb, now(), '[]'::jsonb)`,
    ).rejects.toThrow(/messages_visible_to_check/);
    await expect(
      database.sql`INSERT INTO messages (id, group_id, body, created_at, visible_to) VALUES ('m-obj', 'g1', ${body}::jsonb, now(), '{}'::jsonb)`,
    ).rejects.toThrow(/messages_visible_to_check/);
  } finally {
    await database.close();
  }
});

it("runs.table_role 只收三种角色，同一桌同时至多一个未收尾的解说和复盘", async () => {
  const database = await createTestDb();
  try {
    await database.sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '陈', 'chen@baize.dev', 'x')`;
    await database.sql`INSERT INTO bots (id, owner_id, name, hue, shape) VALUES ('b1', 'u1', '老白', 'sky', 'pillow'), ('b2', 'u1', '阿豹', 'coral', 'triangle')`;
    await database.sql`INSERT INTO groups (id, owner_id) VALUES ('g1', 'u1')`;
    const insertRun = (id: string, botId: string, role: string | null, ended: boolean) => database.sql`
      INSERT INTO runs (id, owner_id, bot_id, group_id, started_at, ended_at, table_role)
      VALUES (${id}, 'u1', ${botId}, 'g1', now(), ${ended ? new Date().toISOString() : null}::timestamptz, ${role})
    `;
    await expect(insertRun("r-dealer", "b1", "dealer", false)).rejects.toThrow(/runs_table_role_check/);
    await insertRun("r-advisor", "b1", "advisor", false);
    await expect(insertRun("r-advisor-2", "b2", "advisor", false), "同桌第二个未收尾的解说").rejects.toThrow(
      /runs_table_role_open_idx/,
    );
    await insertRun("r-advisor-done", "b2", "advisor", true);
    await expect(
      insertRun("r-again", "b1", "player", false),
      "同一个 Bot 同一桌第二个未收尾的牌桌 run",
    ).rejects.toThrow(/runs_table_bot_open_idx/);
    await insertRun("r-plain", "b1", null, false);
  } finally {
    await database.close();
  }
});

it("带第 1、2 期数据的库跑过形状迁移：老行的新列都是 null，历史接口照常读，visibleTo 回 null", async () => {
  const database = await createTestDb({ through: PREVIOUS_MIGRATION });
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    const user = { id: UserId.parse("u-p2"), email: "p2@baize.dev", password: "p2-password" };
    await database.sql`
      INSERT INTO users (id, name, email, password_hash) VALUES (${user.id}, '陈', ${user.email}, ${await hashPassword(user.password)})
    `;
    await database.sql`INSERT INTO user_counters (user_id) VALUES (${user.id})`;
    await database.sql`INSERT INTO settings (user_id) VALUES (${user.id})`;
    await database.sql`
      INSERT INTO bots (id, owner_id, name, hue, role) VALUES ('b-assistant', ${user.id}, '主助理', 'sky', 'assistant')
    `;
    await database.sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES ('g-old', ${user.id}, 'b-assistant')`;
    await database.sql`INSERT INTO group_members (group_id, bot_id, position) VALUES ('g-old', 'b-assistant', 0)`;
    await database.sql`INSERT INTO tasks (id, group_id, number, title) VALUES ('t-old', 'g-old', 'T-1200', '旧单聊')`;
    await database.sql`
      INSERT INTO messages (id, group_id, body, created_at)
      VALUES ('m-old', 'g-old', ${JSON.stringify({ kind: "user", text: "旧消息" })}::jsonb, ${new Date(1_700_000_000_000).toISOString()})
    `;
    await database.sql`
      INSERT INTO runs (id, owner_id, bot_id, group_id, started_at, ended_at)
      VALUES ('r-old', ${user.id}, 'b-assistant', 'g-old', now(), now())
    `;

    const applied = await runMigrations(database.sql);
    expect(applied, "应实际应用形状迁移").toContain(SHAPE_MIGRATION);

    const [bot] = await database.sql<{ preset: string | null }[]>`SELECT preset FROM bots WHERE id = 'b-assistant'`;
    expect(bot?.preset).toBeNull();
    const [run] = await database.sql<
      { visible_to: unknown; table_role: string | null }[]
    >`SELECT visible_to, table_role FROM runs WHERE id = 'r-old'`;
    expect(run).toEqual({ visible_to: null, table_role: null });

    server = await startTestServer(database.db);
    const client = new ApiClient(server.server.port);
    expect((await client.login(user.email, user.password)).status).toBe(200);
    const history = await client.get("/api/groups/g-old/messages");
    expect(history.status).toBe(200);
    const messages = MessageListResponse.parse(await history.json()).messages;
    expect(messages.map((message) => [message.id, message.visibleTo])).toEqual([["m-old", null]]);
  } finally {
    await server?.close();
    await database.close();
  }
});
