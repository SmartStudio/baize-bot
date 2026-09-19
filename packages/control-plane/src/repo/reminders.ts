import { UserId, type Message } from "@baize/shared";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { groups } from "../db/schema.js";
import type { PushHub } from "../ws/hub.js";
import { appendMessage, type Tx } from "./messages.js";

/** 一条要补进群里的提醒。群决定它落在哪儿、推给谁。 */
export type StaleReminder = { readonly groupId: string; readonly text: string };

/**
 * 超时提醒共用的那一半。审批和交接各写各的「哪几行过点了」，剩下的形状是同一个：
 * 占住提醒标记和补消息必须一起提交，标记单独落地而消息没写成的话那几行以后再也扫不中，提醒永久丢掉；
 * 推留在事务外，连接那头出事不该把已经落库的提醒回滚掉。
 * 时钟不在这儿，由调用方按参数传进 claim，所以测试能直接给一个 25 小时后的时刻。
 */
export async function appendReminders(
  db: Db,
  push: PushHub,
  claim: (tx: Tx) => Promise<StaleReminder[]>,
): Promise<number> {
  const written = await db.transaction(async (tx) => {
    const stale = await claim(tx);
    if (stale.length === 0) return [] as Written[];

    const owners = await ownersOf(
      tx,
      stale.map((one) => one.groupId),
    );
    const messages: Written[] = [];
    for (const one of stale) {
      const ownerId = owners.get(one.groupId);
      if (ownerId === undefined) continue;
      messages.push({
        ownerId,
        message: await appendMessage(tx, one.groupId, { kind: "system", tone: "info", text: one.text }),
      });
    }
    return messages;
  });

  for (const one of written) push.push(one.ownerId, { type: "message", message: one.message });
  return written.length;
}

type Written = { readonly ownerId: UserId; readonly message: Message };

async function ownersOf(db: Db | Tx, groupIds: readonly string[]): Promise<Map<string, UserId>> {
  const rows = await db
    .select({ id: groups.id, ownerId: groups.ownerId })
    .from(groups)
    .where(inArray(groups.id, [...groupIds]));
  return new Map(rows.map((row) => [row.id, UserId.parse(row.ownerId)]));
}
