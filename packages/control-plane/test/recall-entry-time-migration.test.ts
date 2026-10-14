import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/db.js";

const PREVIOUS_MIGRATION = "0035_p3_recall_search.sql";

const message = (id: string, extra: Record<string, unknown> = {}, tail = "") =>
  JSON.stringify({ type: "message", id, parentId: null, message: { role: "user", content: "文字" }, ...extra }) + tail;

// 键 timestamp 的取值以及行里别处的转义，是 Pi 和浏览器工具真会写进来的几种形状。
const cases: { id: string; stream?: "chat" | "table"; piType?: string; line: string; expected: string | null }[] = [
  { id: "z", line: message("z", { timestamp: "2026-10-01T00:00:00.000Z" }), expected: "2026-10-01T00:00:00.000Z" },
  {
    id: "offset",
    line: message("offset", { timestamp: "2026-10-01T01:00:00+08:00" }),
    expected: "2026-09-30T17:00:00.000Z",
  },
  {
    id: "micro",
    line: message("micro", { timestamp: "2026-10-01T00:00:00.123987Z" }),
    expected: "2026-10-01T00:00:00.123Z",
  },
  { id: "bad", line: message("bad", { timestamp: "坏时间" }), expected: null },
  { id: "keyword", line: message("keyword", { timestamp: "now" }), expected: null },
  { id: "number", line: message("number", { timestamp: 1789000000000 }), expected: null },
  { id: "missing", line: message("missing"), expected: null },
  {
    id: "nul",
    line: message("nul", { timestamp: "2026-10-14T00:00:00.000Z", opaque: "a\u0000b" }),
    expected: "2026-10-14T00:00:00.000Z",
  },
  {
    id: "backslash",
    line: message("backslash", { timestamp: "2026-10-15T00:00:00.000Z", opaque: "路径\\u0000字面" }),
    expected: "2026-10-15T00:00:00.000Z",
  },
  {
    id: "compaction",
    piType: "compaction",
    line: message("compaction", { timestamp: "2026-10-01T00:00:00.000Z" }),
    expected: null,
  },
  { id: "table", stream: "table", line: message("table", { timestamp: "2026-10-01T00:00:00.000Z" }), expected: null },
];

it("0036 给旧消息行回填条目时间，新行由触发器取出；坏值、非 ISO、转义 NUL 都不让写入失败", async () => {
  const database = await createTestDb({ through: PREVIOUS_MIGRATION });
  const { sql } = database;
  try {
    await sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '陈', 'chen@baize.dev', 'x')`;
    await sql`INSERT INTO bots (id, owner_id, name, hue) VALUES ('b1', 'u1', '豹子', 'sky')`;
    await sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES ('g1', 'u1', 'b1')`;
    const insert = async (prefix: string, seqBase: number) => {
      for (const [index, { id, stream, piType, line }] of cases.entries()) {
        await sql`
          INSERT INTO work_entries (bot_id, group_id, stream, seq, epoch, owner_id, entry_id, pi_type, retention, line, search_text)
          VALUES ('b1', 'g1', ${stream ?? "chat"}, ${seqBase + index}, 1, 'u1', ${prefix + id}, ${piType ?? "message"}, 'verbatim', ${line}, '文字')`;
      }
    };
    await insert("old-", 0);

    expect(await runMigrations(sql)).toContain("0036_p3_recall_entry_time.sql");
    await insert("new-", 100);

    const rows = await sql<{ entry_id: string; at: string | null }[]>`
      SELECT entry_id, to_char(entry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM work_entries`;
    const byId = new Map(rows.map((row) => [row.entry_id, row.at]));
    for (const prefix of ["old-", "new-"])
      for (const { id, expected } of cases) expect(byId.get(prefix + id), `${prefix}${id}`).toBe(expected);
  } finally {
    await database.close();
  }
});
