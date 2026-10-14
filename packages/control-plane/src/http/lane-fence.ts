import { BotId, GroupId, LaneIdentity, type Computer } from "@baize/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bots, computers, groupMembers, groups, laneLeases } from "../db/schema.js";
import type { Tx } from "../repo/messages.js";

export const LANE_FENCE_ERRORS = {
  stale_epoch: "代际过时",
  not_holder: "不是持有者",
  expired: "租约已过期",
  invalid: "缺少或格式不对",
} as const;

export type LaneFenceResult =
  { kind: "ok"; lane: { botId: BotId; groupId: GroupId; epoch: number } } | { kind: keyof typeof LANE_FENCE_ERRORS };

export async function validateLaneFence(
  db: Db | Tx,
  computer: Computer,
  header: string | undefined,
): Promise<LaneFenceResult> {
  const parts = header === undefined ? null : /^([^\s/]+)\/([^\s/]+)\/([1-9]\d*)$/.exec(header);
  if (parts === null) return { kind: "invalid" };
  const parsed = LaneIdentity.safeParse({ botId: parts[1], groupId: parts[2], epoch: Number(parts[3]) });
  const bot = BotId.safeParse(parts[1]);
  const group = GroupId.safeParse(parts[2]);
  if (!parsed.success || !bot.success || !group.success || !Number.isSafeInteger(parsed.data.epoch))
    return { kind: "invalid" };
  const lane = { botId: bot.data, groupId: group.data, epoch: parsed.data.epoch };
  const [lease] = await db
    .select({
      holderComputerId: laneLeases.holderComputerId,
      holderInstallId: laneLeases.holderInstallId,
      epoch: laneLeases.epoch,
      installId: computers.installId,
      live: sql<boolean>`${computers.leaseUntil} > clock_timestamp()`,
    })
    .from(laneLeases)
    .innerJoin(bots, and(eq(bots.id, laneLeases.botId), eq(bots.ownerId, computer.ownerId)))
    .innerJoin(groups, and(eq(groups.id, laneLeases.groupId), eq(groups.ownerId, computer.ownerId)))
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.botId, bots.id)))
    .innerJoin(computers, and(eq(computers.id, computer.id), eq(computers.ownerId, computer.ownerId)))
    .where(and(eq(laneLeases.botId, lane.botId), eq(laneLeases.groupId, lane.groupId)));
  if (lease === undefined) return { kind: "not_holder" };
  if (lease.epoch !== lane.epoch) return { kind: "stale_epoch" };
  if (lease.holderComputerId !== computer.id || lease.holderInstallId !== lease.installId)
    return { kind: "not_holder" };
  if (lease.live !== true) return { kind: "expired" };
  return { kind: "ok", lane };
}
