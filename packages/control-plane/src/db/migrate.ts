import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./client.js";

export const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

// 咨询锁的 key，随便一个常数，只要所有迁移进程用同一个。
const MIGRATION_LOCK = 0x6261697a;

/**
 * 应用 drizzle-kit 生成的 SQL，已应用的记在 _migrations 里跳过。
 * 整批在一个事务里，并发的第二个进程被咨询锁挡在外面，进来时已经能看到前一个的记账。
 */
export async function runMigrations(sql: Sql): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const done = await tx<{ name: string }[]>`SELECT name FROM _migrations`;
    const seen = new Set(done.map((r) => r.name));

    const applied: string[] = [];
    for (const file of files) {
      if (seen.has(file)) continue;
      const statements = (await readFile(join(migrationsDir, file), "utf8"))
        .split(STATEMENT_BREAKPOINT)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const statement of statements) await tx.unsafe(statement);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      applied.push(file);
    }
    return applied;
  });
}
