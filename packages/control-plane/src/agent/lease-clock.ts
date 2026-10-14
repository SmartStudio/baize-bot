import type { ComputerId } from "@baize/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computers } from "../db/schema.js";

/** 连接代际必须仍有效，旧 socket 的续期和关闭都不能碰新连接的时钟。 */
export async function setComputerLease(db: Db, computerId: ComputerId, conn: number, until: Date): Promise<void> {
  await db
    .update(computers)
    .set({ leaseUntil: until })
    .where(and(eq(computers.id, computerId), eq(computers.connGen, conn)));
}
