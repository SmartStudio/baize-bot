import { POKER_PERSONAS, PokerPersona, type BotRole, type UserId } from "@baize/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots } from "../db/schema.js";
import { newId } from "../ids.js";
import { claimCounter, openSoloGroup } from "./bots.js";
import { lockOwner } from "./runs.js";

/** 牌桌上的角色：不进队伍页和 Bot 列表，只在牌桌里出现，config 照带。 */
export const TABLE_ROLES: readonly BotRole[] = ["player", "host"];

const roleOf = (preset: PokerPersona): BotRole => (preset === "laobai" ? "host" : "player");

/**
 * 给这个用户建齐五位牌友和老白（D26），每位一个单聊群，返回这次新建的。
 * 每个用户一套（D36），靠 (owner_id, preset) 的部分唯一索引挡重复，不先查后写。
 * 建出来不推 bot_created：调用方在返回非空时发一次新的 config，和 ensureAssistant 的调用方一样。
 * 共享锁和建 Bot 同一个理由：删号正在进行就等它提交，醒来后这个人已经不在。
 */
export async function ensurePokerPresets(db: Db, ownerId: UserId): Promise<PokerPersona[]> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerId, "shared");
    const created: PokerPersona[] = [];
    for (const preset of PokerPersona.options) {
      const card = POKER_PERSONAS[preset];
      const [botRow] = await tx
        .insert(bots)
        .values({
          id: newId(),
          ownerId,
          role: roleOf(preset),
          preset,
          name: card.name,
          tags: [...card.tags],
          description: card.line,
          hue: card.hue,
        })
        .onConflictDoNothing({ target: [bots.ownerId, bots.preset], where: sql`${bots.preset} IS NOT NULL` })
        .returning();
      if (botRow === undefined) continue;
      const counter = await claimCounter(tx, ownerId, false);
      await openSoloGroup(tx, botRow, counter.nextTaskNumber);
      created.push(preset);
    }
    return created;
  });
}
