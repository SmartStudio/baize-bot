import { CreateBotResponse, DecideSkillOfferResponse, MessageListResponse } from "@baize/shared";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";

it("0046 把旧的平铺 name、steps 卡包成存 skill 的变更，迁移后群里读得出、点得动", async () => {
  const database = await createTestDb({ through: "0045_skill_origin.sql" });
  const server = await startTestServer(database.db);
  try {
    const user = await makeUser(database.db);
    const client = server.client();
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小服" })).json());
    const legacy = (status: string, skillId: string | null) => ({
      kind: "skill_offer",
      botId: created.bot.id,
      name: `周报-${status}`,
      steps: ["翻一遍群消息", "写三段"],
      status,
      skillId,
    });
    const { sql } = database;
    await sql`INSERT INTO messages (id, group_id, body, skill_offer_source, created_at) VALUES
      ('m-offered', ${created.group.id}, ${JSON.stringify(legacy("offered", null))}::jsonb, 'chat', now()),
      ('m-dismissed', ${created.group.id}, ${JSON.stringify(legacy("dismissed", null))}::jsonb, NULL, now())`;

    expect(await runMigrations(sql)).toContain("0046_skill_offer_change.sql");

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
    await server.close();
    await database.close();
  }
});
