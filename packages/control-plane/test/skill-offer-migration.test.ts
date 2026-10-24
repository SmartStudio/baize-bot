import { DecideSkillOfferResponse, MessageListResponse } from "@baize/shared";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { hashPassword } from "../src/password.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { PASSWORD } from "./helpers/fixtures.js";

it("0046 把旧的平铺 name、steps 卡包成存 skill 的变更，迁移后群里读得出、点得动", async () => {
  const database = await createTestDb({ through: "0045_skill_origin.sql" });
  let server: TestServer | null = null;
  try {
    const { sql } = database;
    await sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '甲', 'a@baize.dev', ${await hashPassword(PASSWORD)})`;
    await sql`INSERT INTO settings (user_id) VALUES ('u1')`;
    await sql`INSERT INTO user_counters (user_id) VALUES ('u1')`;
    await sql`INSERT INTO bots (id, owner_id, name, hue, shape) VALUES ('b-fu', 'u1', '小服', 'mint', 'pillow')`;
    await sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES ('g-fu', 'u1', 'b-fu')`;
    await sql`INSERT INTO group_members (group_id, bot_id, position) VALUES ('g-fu', 'b-fu', 0)`;
    await sql`INSERT INTO tasks (id, group_id, number, title) VALUES ('t-fu', 'g-fu', 'T-1001', '小服')`;
    const created = { bot: { id: "b-fu" }, group: { id: "g-fu" } };
    const legacy = (status: string, skillId: string | null) => ({
      kind: "skill_offer",
      botId: created.bot.id,
      name: `周报-${status}`,
      steps: ["翻一遍群消息", "写三段"],
      status,
      skillId,
    });
    await sql`INSERT INTO messages (id, group_id, body, skill_offer_source, created_at) VALUES
      ('m-offered', ${created.group.id}, ${JSON.stringify(legacy("offered", null))}::jsonb, 'chat', now()),
      ('m-dismissed', ${created.group.id}, ${JSON.stringify(legacy("dismissed", null))}::jsonb, NULL, now())`;

    expect(await runMigrations(sql)).toContain("0046_skill_offer_change.sql");
    server = await startTestServer(database.db);
    const client = server.client();
    expect((await client.login("a@baize.dev", PASSWORD)).status).toBe(200);

    const listed = await client.get(`/api/groups/${created.group.id}/messages`);
    expect(listed.status, "旧卡不再让整页消息解析失败").toBe(200);
    const bodies = MessageListResponse.parse(await listed.json()).messages.flatMap((one) =>
      one.body.kind === "skill_offer" ? [one.body] : [],
    );
    expect(bodies).toEqual([
      {
        kind: "skill_offer",
        botId: created.bot.id,
        change: { op: "add", name: "周报-offered", steps: ["翻一遍群消息", "写三段"], origin: null },
        status: "offered",
        skillId: null,
      },
      {
        kind: "skill_offer",
        botId: created.bot.id,
        change: { op: "add", name: "周报-dismissed", steps: ["翻一遍群消息", "写三段"], origin: null },
        status: "dismissed",
        skillId: null,
      },
    ]);

    const decided = await client.post("/api/messages/m-offered/skill-offer", { decision: "save" });
    expect(decided.status).toBe(200);
    expect(DecideSkillOfferResponse.parse(await decided.json()).skill, "迁移前没点的卡迁移后照样存得下").toMatchObject({
      name: "周报-offered",
      source: "chat",
      origin: null,
    });
  } finally {
    await server?.close();
    await database.close();
  }
});
