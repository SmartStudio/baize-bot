import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { connect, type Db, type Sql } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { databaseUrl } from "../../src/env.js";

export type TestDb = {
  readonly db: Db;
  readonly sql: Sql;
  readonly databaseName: string;
  close(): Promise<void>;
};

/**
 * 每个测试文件一个库。drizzle-kit 生成的外键写死了 "public"，
 * 换 search_path 装不下，所以隔离只能落在库这一级。
 */
export async function createTestDb(options: { readonly through?: string } = {}): Promise<TestDb> {
  const databaseName = `baize_test_${randomBytes(6).toString("hex")}`;
  await withAdmin((admin) => admin`CREATE DATABASE ${admin(databaseName)}`);

  const url = new URL(databaseUrl());
  url.pathname = `/${databaseName}`;
  const { db, sql } = connect(url.toString(), { max: 4 });
  await runMigrations(sql, options.through);

  return {
    db,
    sql,
    databaseName,
    close: async () => {
      await sql.end();
      await withAdmin((admin) => admin`DROP DATABASE ${admin(databaseName)} WITH (FORCE)`);
    },
  };
}

async function withAdmin(run: (admin: Sql) => Promise<unknown>): Promise<void> {
  const admin = postgres(databaseUrl(), { max: 1 });
  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}
