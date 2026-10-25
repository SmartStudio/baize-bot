import { GroupResponse, UserId } from "@baize/shared";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { hashPassword } from "../src/password.js";
import { ApiClient, startTestServer } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";

it("0051 把单个来源迁成一个元素的数组，旧样本和目标归到这个指标上，项目页读到的进度和迁移前一样", async () => {
  const database = await createTestDb({ through: "0050_furry_typhoid_mary.sql" });
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
  try {
    const { sql } = database;
    const user = { id: UserId.parse("u-old"), email: "old@baize.dev", password: "old-password" };
    await sql`INSERT INTO users (id, name, email, password_hash) VALUES (${user.id}, '陈', ${user.email}, ${await hashPassword(user.password)})`;
    await sql`INSERT INTO user_counters (user_id) VALUES (${user.id})`;
    await sql`INSERT INTO settings (user_id) VALUES (${user.id})`;
    await sql`INSERT INTO computers (id, owner_id, kind, token_hash, gateway_key_hash) VALUES ('c1', ${user.id}, 'local', 'h1', 'g1')`;
    await sql`INSERT INTO accounts (id, owner_id, computer_id, platform, via, handle, login) VALUES ('a-gh', ${user.id}, 'c1', 'github', 'api', 'baize-dev', 'valid')`;
    const projects = [
      ["g-stars", { kind: "github_stars", accountId: "a-gh", repo: "baize/bot" }, 1000],
      ["g-xhs", { kind: "reported", platform: "xiaohongshu", label: "粉丝" }, null],
      ["g-plain", null, 50],
    ] as const;
    for (const [index, [groupId, source, target]] of projects.entries()) {
      const botId = `b-${groupId}`;
      await sql`INSERT INTO bots (id, owner_id, name, hue, shape) VALUES (${botId}, ${user.id}, ${botId}, 'sky', 'pillow')`;
      await sql`INSERT INTO groups (id, owner_id, solo_bot_id) VALUES (${groupId}, ${user.id}, ${botId})`;
      await sql`INSERT INTO group_members (group_id, bot_id, position) VALUES (${groupId}, ${botId}, 0)`;
      await sql`
        INSERT INTO tasks (id, group_id, number, title, goal_target, goal_unit, metric_source)
        VALUES (${`t-${groupId}`}, ${groupId}, ${`T-${1000 + index}`}, '旧项目', ${target}, ${target === null ? null : "个"},
          ${source === null ? null : JSON.stringify(source)}::jsonb)`;
    }
    const now = Date.now();
    await sql`
      INSERT INTO metric_samples (id, group_id, value, source, sampled_at) VALUES
        ('s1', 'g-stars', 300, 'manual', ${new Date(now - 60_000).toISOString()}),
        ('s2', 'g-stars', 320, 'github_stars', ${new Date(now - 30_000).toISOString()}),
        ('s3', 'g-xhs', 800, 'reported', ${new Date(now - 30_000).toISOString()}),
        ('s4', 'g-plain', 12, 'manual', ${new Date(now - 30_000).toISOString()})`;

    expect(await runMigrations(sql)).toContain("0051_lethal_felicia_hardy.sql");
    expect(await sql`SELECT group_id, metric_sources, goal_metric FROM tasks ORDER BY group_id`).toEqual([
      { group_id: "g-plain", metric_sources: [], goal_metric: null },
      {
        group_id: "g-stars",
        metric_sources: [{ kind: "github_stars", accountId: "a-gh", repo: "baize/bot" }],
        goal_metric: "github_stars:baize/bot",
      },
      {
        group_id: "g-xhs",
        metric_sources: [{ kind: "reported", platform: "xiaohongshu", label: "粉丝" }],
        goal_metric: null,
      },
    ]);
    expect(await sql`SELECT id, metric FROM metric_samples ORDER BY id`, "旧样本不分来源都归到那个群的指标上").toEqual([
      { id: "s1", metric: "github_stars:baize/bot" },
      { id: "s2", metric: "github_stars:baize/bot" },
      { id: "s3", metric: "reported:粉丝" },
      { id: "s4", metric: null },
    ]);

    server = await startTestServer(database.db);
    const client = new ApiClient(server.server.port);
    expect((await client.login(user.email, user.password)).status).toBe(200);
    const read = async (groupId: string) => {
      const response = await client.get(`/api/groups/${groupId}`);
      expect(response.status).toBe(200);
      return GroupResponse.parse(await response.json()).task;
    };

    const stars = await read("g-stars");
    expect(stars.goal).toEqual({ target: 1000, unit: "个", dueAt: null, metric: "github_stars:baize/bot" });
    expect(stars.metric, "目标进度还是最新那条样本").toMatchObject({ kind: "read", current: 320 });
    expect(
      stars.metrics.map(({ key, metric, account }) => [key, metric.kind === "read" ? metric.current : null, account]),
    ).toEqual([["github_stars:baize/bot", 320, "connected"]]);
    const xhs = await read("g-xhs");
    expect(
      xhs.metrics.map(({ key, metric, account }) => [key, metric.kind === "read" ? metric.current : null, account]),
    ).toEqual([["reported:粉丝", 800, null]]);
    const plain = await read("g-plain");
    expect(plain.metricSources).toEqual([]);
    expect(plain.metric, "没挂来源的项目，手记的数还是目标进度").toMatchObject({ kind: "read", current: 12 });
  } finally {
    await server?.close();
    await database.close();
  }
});
