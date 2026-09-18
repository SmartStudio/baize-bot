import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Sql = ReturnType<typeof postgres>;

export type ConnectOptions = { readonly max?: number };

export function connect(url: string, options: ConnectOptions = {}): { db: Db; sql: Sql } {
  const sql = postgres(url, { max: options.max ?? 10 });
  return { db: drizzle(sql, { schema }), sql };
}
