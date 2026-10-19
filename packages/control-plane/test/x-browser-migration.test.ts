import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/db.js";

it("0043 按平台回填 via：小红书走电脑、GitHub 和 X 走接口，之后各平台能走哪种由约束钉住", async () => {
  const database = await createTestDb({ through: "0042_skinny_wendell_vaughn.sql" });
  try {
    const { sql } = database;
    await sql`INSERT INTO users (id, name, email, password_hash) VALUES ('u1', '甲', 'a@baize.dev', 'x')`;
    await sql`INSERT INTO computers (id, owner_id, kind, token_hash, gateway_key_hash) VALUES ('c1', 'u1', 'local', 'h1', 'g1')`;
    await sql`INSERT INTO accounts (id, owner_id, computer_id, platform, handle, login) VALUES
      ('a-xhs', 'u1', 'c1', 'xiaohongshu', '白泽', 'valid'),
      ('a-xhs-none', 'u1', 'c1', 'xiaohongshu', NULL, 'none'),
      ('a-x', 'u1', 'c1', 'x', 'baize_x', 'valid'),
      ('a-gh', 'u1', 'c1', 'github', 'baize-dev', 'valid')`;

    expect(await runMigrations(sql)).toContain("0043_x_browser_and_cli_tools.sql");
    expect(await sql`SELECT id, via FROM accounts ORDER BY id`).toEqual([
      { id: "a-gh", via: "api" },
      { id: "a-x", via: "api" },
      { id: "a-xhs", via: "computer" },
      { id: "a-xhs-none", via: "computer" },
    ]);

    await sql`INSERT INTO accounts (id, owner_id, computer_id, platform, via, handle, login) VALUES ('a-x-web', 'u1', 'c1', 'x', 'computer', 'baize_x', 'valid')`;
    expect(
      await sql`SELECT count(*)::int AS n FROM accounts WHERE platform = 'x' AND handle = 'baize_x'`,
      "同一个 X 号两种连法各一行",
    ).toEqual([{ n: 2 }]);
    await expect(
      sql`INSERT INTO accounts (id, owner_id, computer_id, platform, via, handle, login) VALUES ('dup', 'u1', 'c1', 'x', 'computer', 'baize_x', 'valid')`,
      "同一种连法同一个号只有一行",
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO accounts (id, owner_id, computer_id, platform, handle, login) VALUES ('no-via', 'u1', 'c1', 'x', 'n', 'valid')`,
      "via 没有默认值",
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO accounts (id, owner_id, computer_id, platform, via, handle, login) VALUES ('xhs-api', 'u1', 'c1', 'xiaohongshu', 'api', 'n', 'valid')`,
      "小红书只能走电脑",
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO accounts (id, owner_id, computer_id, platform, via, handle, login) VALUES ('gh-web', 'u1', 'c1', 'github', 'computer', 'n', 'valid')`,
      "GitHub 只能走接口",
    ).rejects.toThrow();
    await expect(
      sql`UPDATE accounts SET tier = 'direct_publish' WHERE id = 'a-x-web'`,
      "走电脑的不能直接发",
    ).rejects.toThrow();
    await sql`UPDATE accounts SET tier = 'direct_publish' WHERE id = 'a-x'`;
    await sql`INSERT INTO accounts (id, owner_id, computer_id, platform, via, handle, login) VALUES ('x-none', 'u1', 'c1', 'x', 'computer', NULL, 'none')`;
    await expect(
      sql`INSERT INTO accounts (id, owner_id, computer_id, platform, via, handle, login) VALUES ('x-none-2', 'u1', 'c1', 'x', 'computer', NULL, 'none')`,
      "每人每平台每种连法最多一个未登录占位",
    ).rejects.toThrow();
  } finally {
    await database.close();
  }
});
