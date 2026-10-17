import { ComputerId, type Computer, type ComputerKind, type ComputerView, type UserId } from "@baize/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computers } from "../db/schema.js";
import type { Tx } from "../repo/messages.js";
import type { ComputerRecord } from "../repo/rows.js";
import type { AgentHub } from "./hub.js";

/**
 * online：连着，config 已收下。grace：刚断开还在宽限期里，下行先入箱等它回来。rejected：连着但 config 被拒。
 * 其余都是 offline，连着但租约过期也算：placeRun 认的是库里的租约。
 */
export type ComputerReach = "online" | "grace" | "rejected" | "offline";

export interface ComputerAvailability {
  readonly id: ComputerId;
  readonly kind: ComputerKind;
  readonly reach: ComputerReach;
  /** 派活能不能派过去，online 或 grace。 */
  readonly dispatchable: boolean;
}

export type AvailabilityAgents = Pick<AgentHub, "isOnline" | "configRejected"> & Partial<Pick<AgentHub, "canDeliver">>;

export type ComputerLease = { readonly id: ComputerId; readonly kind: ComputerKind; readonly leased: boolean };

/** 连接状态在 hub 内存里，租约在库里。这里只读库那一半，一次查完这个人的全部电脑。 */
export async function computerLeases(db: Db | Tx, ownerId: UserId): Promise<readonly ComputerLease[]> {
  const rows = await db
    .select({
      id: computers.id,
      kind: computers.kind,
      leased: sql<boolean>`coalesce(${computers.leaseUntil} > clock_timestamp(), false)`,
    })
    .from(computers)
    .where(eq(computers.ownerId, ownerId));
  return rows.map((row) => ({ id: ComputerId.parse(row.id), kind: row.kind, leased: row.leased }));
}

function reachOf(lease: ComputerLease, agents: AvailabilityAgents): ComputerReach {
  if (agents.configRejected(lease.id)) return "rejected";
  if (!lease.leased) return "offline";
  if (agents.isOnline(lease.id)) return "online";
  return agents.canDeliver?.(lease.id) === true ? "grace" : "offline";
}

/** 单拆出来给 hub 用：租约先 await 读好，config 收下的同一拍里再判连接状态并推送，两步之间没有 await。 */
export function availabilityOf(
  leases: readonly ComputerLease[],
  agents: AvailabilityAgents,
): readonly ComputerAvailability[] {
  return leases.map((lease) => {
    const reach = reachOf(lease, agents);
    return { id: lease.id, kind: lease.kind, reach, dispatchable: reach === "online" || reach === "grace" };
  });
}

/** 「能不能派」的唯一定义：选电脑、换电脑的校验、网页上的在线圆点都用它。 */
export async function computerAvailability(
  db: Db | Tx,
  agents: AvailabilityAgents,
  ownerId: UserId,
): Promise<readonly ComputerAvailability[]> {
  return availabilityOf(await computerLeases(db, ownerId), agents);
}

/** 库里那行补上 dispatchable 才出 HTTP 和推送。名单里没有它（刚删掉）就当派不过去。 */
export function withDispatchable(record: ComputerRecord, availability: readonly ComputerAvailability[]): Computer {
  return { ...record, dispatchable: availability.some((one) => one.id === record.id && one.dispatchable) };
}

/** 这条 run 落在 computerId 上时 Bot 看到的另一台和选定。账号下只有这一台、也没选过时为 null。 */
export function computerView(
  availability: readonly ComputerAvailability[],
  computerId: ComputerId,
  choice: ComputerKind | null,
): ComputerView | null {
  const found = availability.find((one) => one.id !== computerId);
  const other = found === undefined ? null : { kind: found.kind, dispatchable: found.dispatchable };
  return other === null && choice === null ? null : { other, choice };
}
