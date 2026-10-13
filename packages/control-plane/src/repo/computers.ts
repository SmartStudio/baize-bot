import { ComputerId, type Computer, type ComputerKind, type UserId } from "@baize/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Tx } from "./messages.js";
import { computers } from "../db/schema.js";
import { hashSecret, newId, newSecret, secretMatches } from "../ids.js";
import { toComputer } from "./rows.js";

/** 建电脑时才拿得到 token 明文，已经有电脑时是 null。 */
export type EnsureResult = { readonly computer: Computer; readonly token: string | null };

/** 每人每种电脑至多一台，(owner_id, kind) 上的唯一约束兜住并发创建。 */
export async function ensureComputer(
  db: Db | Tx,
  ownerId: UserId,
  kind: ComputerKind = "local",
): Promise<EnsureResult> {
  const token = newSecret();
  const [created] = await db
    .insert(computers)
    .values({
      id: newId(),
      ownerId,
      kind,
      status: "creating",
      tokenHash: hashSecret(token),
      // 下发前一定会在 hello 时轮换，这一把只是占住非空列，永远不会交出去。
      gatewayKeyHash: hashSecret(newSecret()),
    })
    .onConflictDoNothing({ target: [computers.ownerId, computers.kind] })
    .returning();
  if (created !== undefined) return { computer: toComputer(created), token };

  const existing = await findComputerByOwner(db, ownerId, kind);
  if (existing === null) throw new Error(`用户 ${ownerId} 的 ${kind} 电脑既没建成也查不到`);
  return { computer: existing, token: null };
}

export async function findComputerByOwner(
  db: Db | Tx,
  ownerId: UserId,
  kind: ComputerKind = "local",
): Promise<Computer | null> {
  const [row] = await db
    .select()
    .from(computers)
    .where(and(eq(computers.ownerId, ownerId), eq(computers.kind, kind)))
    .limit(1);
  return row === undefined ? null : toComputer(row);
}

export async function listComputers(db: Db, ownerId: UserId): Promise<Computer[]> {
  const rows = await db.select().from(computers).where(eq(computers.ownerId, ownerId));
  return rows
    .map(toComputer)
    .toSorted((left, right) => (left.kind === right.kind ? 0 : left.kind === "local" ? -1 : 1));
}

export async function findComputerById(db: Db, computerId: ComputerId): Promise<Computer | null> {
  const [row] = await db.select().from(computers).where(eq(computers.id, computerId)).limit(1);
  return row === undefined ? null : toComputer(row);
}

/** token 对得上才认；关闭码由调用方根据电脑号是否仍存在决定。 */
export async function authenticateComputer(db: Db, computerId: ComputerId, token: string): Promise<Computer | null> {
  const [row] = await db.select().from(computers).where(eq(computers.id, computerId)).limit(1);
  if (row === undefined) return null;
  if (!secretMatches(token, row.tokenHash)) return null;
  return toComputer(row);
}

/**
 * 每次 hello 现生成一把网关 key，明文只挂在这条连接上。
 * 这样进程重启后没有「明文丢了」这条分支，控制面也不用在内存里长期存秘密。
 */
export async function rotateGatewayKey(db: Db, computerId: ComputerId): Promise<string> {
  const key = newSecret();
  await db
    .update(computers)
    .set({ gatewayKeyHash: hashSecret(key) })
    .where(eq(computers.id, computerId));
  return key;
}

export async function findComputerByGatewayKey(db: Db, key: string): Promise<Computer | null> {
  const [row] = await db
    .select()
    .from(computers)
    .where(eq(computers.gatewayKeyHash, hashSecret(key)))
    .limit(1);
  return row === undefined ? null : toComputer(row);
}

/**
 * 网关 key 每次 hello 都轮换，行上的 hash 就是最近一次握手的代次。带上它，写在途时被更新的 hello 顶掉的那条连接
 * 什么都写不进去：内存里判「还是当前连接」只能挡 UPDATE 发出之前，发出之后落库之前这段只有数据库自己挡得住。
 * hello 和心跳都走这里，都带自己那条连接的 key；不对应某条连接的进程级写是下面 markComputersSleeping 那两条。
 */
export async function markComputerOnline(db: Db, computerId: ComputerId, gatewayKey: string): Promise<Computer | null> {
  const [row] = await db
    .update(computers)
    .set({ status: "online", lastSeenAt: new Date(), idleSince: null })
    .where(ofConnection(computerId, gatewayKey))
    .returning();
  return row === undefined ? null : toComputer(row);
}

/** 只写这条连接自己那一代：它关闭时更新的 hello 已经轮换过 key 的话，这次写不落，在线的那台不会被写成休眠。 */
export async function markComputerSleeping(
  db: Db,
  computerId: ComputerId,
  gatewayKey: string,
): Promise<Computer | null> {
  const [row] = await db
    .update(computers)
    .set({ status: "sleeping", idleSince: new Date() })
    .where(ofConnection(computerId, gatewayKey))
    .returning();
  return row === undefined ? null : toComputer(row);
}

function ofConnection(computerId: ComputerId, gatewayKey: string) {
  return and(eq(computers.id, computerId), eq(computers.gatewayKeyHash, hashSecret(gatewayKey)));
}

/** 关服务时一次写完。socket 的 close 回调排在事件循环后面，进程退出之前跑不完。 */
export async function markComputersSleeping(db: Db, computerIds: readonly ComputerId[]): Promise<void> {
  if (computerIds.length === 0) return;
  await db
    .update(computers)
    .set({ status: "sleeping", idleSince: new Date() })
    .where(inArray(computers.id, [...computerIds]));
}

/** 进程刚起不可能有活着的连接，库里剩下的在线必然是上次没关干净留下的。 */
export async function markOnlineComputersSleeping(db: Db): Promise<void> {
  await db.update(computers).set({ status: "sleeping", idleSince: new Date() }).where(eq(computers.status, "online"));
}

export type TokenReset = { readonly computerId: ComputerId; readonly token: string };

export async function resetComputerToken(
  db: Db,
  ownerId: UserId,
  kind: ComputerKind = "local",
): Promise<TokenReset | null> {
  const token = newSecret();
  const [row] = await db
    .update(computers)
    .set({ tokenHash: hashSecret(token) })
    .where(and(eq(computers.ownerId, ownerId), eq(computers.kind, kind)))
    .returning({ id: computers.id });
  if (row === undefined) return null;
  return { computerId: ComputerId.parse(row.id), token };
}
