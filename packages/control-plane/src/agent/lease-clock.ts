import type { ComputerId } from "@baize/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computers } from "../db/schema.js";

/** 连接代际必须仍有效，旧 socket 的续期和关闭都不能碰新连接的时钟。 */
export async function setComputerLease(
  db: Db,
  computerId: ComputerId,
  conn: number,
  durationMs: number,
): Promise<number | null> {
  const [row] = await db
    .update(computers)
    .set({ leaseUntil: sql`clock_timestamp() + (${durationMs} * interval '1 millisecond')` })
    .where(and(eq(computers.id, computerId), eq(computers.connGen, conn)))
    .returning({
      remainingMs: sql<number>`GREATEST(0, floor(extract(epoch FROM (${computers.leaseUntil} - clock_timestamp())) * 1000)::int)`,
    });
  return row?.remainingMs ?? null;
}
