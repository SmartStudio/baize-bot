import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/db.js";

const PREVIOUS_MIGRATION = "0027_p3_hint_index.sql";
const system = (text: string) => JSON.stringify({ kind: "system", text });
const receipt = (runId: string, callId: string, result: object) =>
  system(JSON.stringify({ type: "poker_result", runId, callId, result }));

it("0028 把旧出牌回执搬进专表并删掉原消息，进行中的手按旧标记接上重派计数", async () => {
  const database = await createTestDb({ through: PREVIOUS_MIGRATION });
  const { sql } = database;
  try {
    await sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '陈', 'chen@baize.dev', 'x')`;
    await sql`INSERT INTO bots (id, owner_id, name, hue) VALUES ('b1', 'u1', '豹子', 'sky')`;
    await sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES ('g1', 'u1', 'b1')`;
    const seats = JSON.stringify([1, 2, 3, 4].map((seat) => ({ seat, botId: seat === 4 ? null : "b1", stack: 2000 })));
    await sql`INSERT INTO poker_tables (group_id, owner_id, request_id, seats, button_seat, small_blind, big_blind, starting_stack, status) VALUES ('g1', 'u1', 'r1', ${seats}::jsonb, 1, 10, 20, 2000, 'in_hand')`;
    await sql`INSERT INTO poker_sessions (id, group_id) VALUES ('s1', 'g1')`;
    for (const [id, number, status] of [
      ["h-done", 1, "complete"],
      ["h-live", 2, "playing"],
    ] as const)
      await sql`INSERT INTO poker_hands (id, group_id, session_id, number, seed, seats_start, button_seat, blinds, status) VALUES (${id}, 'g1', 's1', ${number}, 'x', ${seats}::jsonb, 1, '{"small":10,"big":20}'::jsonb, ${status})`;
    for (const seq of [0, 1, 2])
      await sql`INSERT INTO poker_events (hand_id, seq, event) VALUES ('h-live', ${seq}, '{}'::jsonb)`;
    await sql`INSERT INTO runs (id, group_id, bot_id, started_at, table_role) VALUES ('run-1', 'g1', 'b1', now(), 'player')`;

    const hidden = JSON.stringify([{ kind: "bot", botId: "b1" }]);
    const messages: [string, string][] = [
      ["poker-result:a", receipt("run-1", "call-ok", { ok: true })],
      ["poker-result:b", receipt("run-1", "call-bad", { ok: false, error: "没人下注，不能跟注" })],
      ["poker-result:c", receipt("run-gone", "call-orphan", { ok: true })],
      ["poker-result:d", system("出牌确认处理中")],
      ["tag-1", system("牌桌决策点 h-live/3")],
      ["tag-2", system("牌桌决策点 h-live/3")],
      ["tag-old", system("牌桌决策点 h-live/2")],
      ["tag-done", system("牌桌决策点 h-done/3")],
    ];
    for (const [id, body] of messages)
      await sql`INSERT INTO messages (id, group_id, body, created_at, visible_to) VALUES (${id}, 'g1', ${body}::jsonb, now(), ${hidden}::jsonb)`;

    expect(await runMigrations(sql)).toContain("0028_p3_poker_converge.sql");

    const moved = await sql<{ run_id: string; call_id: string; result: unknown }[]>`
      SELECT run_id, call_id, result FROM poker_act_receipts ORDER BY call_id`;
    expect(moved, "run 还在的回执原样搬过来，run 已删的不搬").toEqual([
      { run_id: "run-1", call_id: "call-bad", result: { ok: false, error: "没人下注，不能跟注" } },
      { run_id: "run-1", call_id: "call-ok", result: { ok: true } },
    ]);
    const left = await sql<{ id: string }[]>`SELECT id FROM messages WHERE id LIKE 'poker-result:%'`;
    expect(left, "旧回执消息全部删掉").toEqual([]);
    expect((await sql<{ id: string }[]>`SELECT id FROM messages WHERE id LIKE 'tag-%'`).length, "触发消息不动").toBe(4);

    const hands = await sql<{ id: string; dispatch_seq: number | null; dispatch_count: number }[]>`
      SELECT id, dispatch_seq, dispatch_count FROM poker_hands ORDER BY id`;
    expect(hands, "只数进行中的手、当前决策点的标记").toEqual([
      { id: "h-done", dispatch_seq: null, dispatch_count: 0 },
      { id: "h-live", dispatch_seq: 3, dispatch_count: 2 },
    ]);
    await expect(sql`UPDATE poker_hands SET status = 'abandoned' WHERE id = 'h-live'`).resolves.toBeDefined();
    await expect(sql`UPDATE poker_hands SET dispatch_count = 0 WHERE id = 'h-live'`).rejects.toThrow(
      /poker_hands_dispatch_check/,
    );
  } finally {
    await database.close();
  }
});
