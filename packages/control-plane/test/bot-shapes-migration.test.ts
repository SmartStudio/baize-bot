import { BotListResponse, POKER_PERSONAS } from "@baize/shared";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { hashPassword } from "../src/password.js";
import { startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { PASSWORD } from "./helpers/fixtures.js";

it("0042 给旧行稳定回填，保留颜色和发号器，重跑不覆盖用户修改", async () => {
  const database = await createTestDb({ through: "0041_p3_runs_continue_requested.sql" });
  try {
    const { sql } = database;
    await sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '甲', 'a@baize.dev', ${await hashPassword(PASSWORD)}), ('u2', '乙', 'b@baize.dev', 'x')`;
    await sql`INSERT INTO settings (user_id) VALUES ('u1')`;
    await sql`INSERT INTO user_counters (user_id, next_task_number, next_hue_index) VALUES ('u1', 1020, 5), ('u2', 1002, 1)`;
    await sql`INSERT INTO bots (id, owner_id, name, hue, role, created_at) VALUES ('assistant', 'u1', '主助理', 'sky', 'assistant', '2020-01-01')`;
    for (const id of ["m3", "m1", "m2", "m4", "m5", "m6", "m7", "m8", "m9"])
      await sql`INSERT INTO bots (id, owner_id, name, hue, created_at) VALUES (${id}, 'u1', ${id}, 'mint', '2020-01-02')`;
    await sql`INSERT INTO bots (id, owner_id, name, hue, created_at) VALUES ('other', 'u2', '另一个用户', 'pink', '2020-01-01')`;
    for (const [preset, card] of Object.entries(POKER_PERSONAS))
      await sql`INSERT INTO bots (id, owner_id, name, hue, role, preset) VALUES (${preset}, 'u1', ${card.name}, ${card.hue}, ${preset === "laobai" ? "host" : "player"}, ${preset})`;
    await sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES ('g-assistant', 'u1', 'assistant'), ('g-member', 'u1', 'm2')`;
    await sql`INSERT INTO group_members (group_id, bot_id, position) VALUES ('g-assistant', 'assistant', 0), ('g-member', 'm2', 0)`;
    await sql`INSERT INTO tasks (id, group_id, number, title) VALUES ('t-assistant', 'g-assistant', 'T-1001', '主助理'), ('t-member', 'g-member', 'T-1002', 'm2')`;

    expect(await runMigrations(sql)).toContain("0042_skinny_wendell_vaughn.sql");
    const rows = await sql<{ id: string; hue: string; shape: string }[]>`SELECT id, hue, shape FROM bots ORDER BY id`;
    expect(rows.find((row) => row.id === "assistant")).toMatchObject({ hue: "sky", shape: "pillow" });
    expect(rows.filter((row) => row.id.startsWith("m")).map((row) => row.shape)).toEqual([
      "pillow",
      "cloud",
      "triangle",
      "bean",
      "droplet",
      "arch",
      "leaf",
      "pudding",
      "pillow",
    ]);
    expect(rows.filter((row) => row.id.startsWith("m")).every((row) => row.hue === "mint")).toBe(true);
    expect(rows.find((row) => row.id === "other")).toMatchObject({ hue: "pink", shape: "pillow" });
    for (const [preset, card] of Object.entries(POKER_PERSONAS))
      expect(rows.find((row) => row.id === preset)?.shape).toBe(card.shape);
    expect(await sql`SELECT next_hue_index FROM user_counters WHERE user_id = 'u1'`).toEqual([{ next_hue_index: 5 }]);
    await sql`UPDATE bots SET shape = 'leaf' WHERE id = 'm1'`;
    expect(await runMigrations(sql)).toEqual([]);
    expect(await sql`SELECT shape FROM bots WHERE id = 'm1'`).toEqual([{ shape: "leaf" }]);
    await expect(sql`UPDATE bots SET shape = NULL WHERE id = 'm1'`).rejects.toThrow();

    const server = await startTestServer(database.db);
    try {
      const client = server.client();
      expect((await client.login("a@baize.dev", PASSWORD)).status).toBe(200);
      const list = BotListResponse.parse(await (await client.get("/api/bots")).json());
      expect(list.items.find((item) => item.bot.role === "assistant")?.bot.shape).toBe("pillow");
      expect(list.items.find((item) => item.bot.id === "m2")?.bot.shape).toBe("cloud");
    } finally {
      await server.close();
    }
  } finally {
    await database.close();
  }
});
