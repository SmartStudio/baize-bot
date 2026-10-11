import {
  BotId,
  ToolConnection,
  ToolConnectionConfig,
  ToolConnectionId,
  type CreateToolRequest,
  type ToolOperation,
  type UpdateToolRequest,
  type UserId,
} from "@baize/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ToolCrypto } from "../crypto.js";
import type { Db } from "../db/client.js";
import { bots, toolConnectionBots, toolConnections } from "../db/schema.js";
import { newId } from "../ids.js";
import type { Tx } from "./messages.js";

type ToolRow = typeof toolConnections.$inferSelect;

const toTool = (row: ToolRow, assignedBotIds: BotId[]): ToolConnection =>
  ToolConnection.parse({
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    url: row.url,
    operations: row.operations,
    assignedBotIds,
    status: row.status,
  });

const assignments = async (db: Db | Tx, ids: string[]): Promise<Map<string, BotId[]>> => {
  const byTool = new Map<string, BotId[]>();
  if (ids.length === 0) return byTool;
  const rows = await db
    .select({ toolConnectionId: toolConnectionBots.toolConnectionId, botId: toolConnectionBots.botId })
    .from(toolConnectionBots)
    .where(inArray(toolConnectionBots.toolConnectionId, ids))
    .orderBy(asc(toolConnectionBots.botId));
  for (const row of rows) {
    const current = byTool.get(row.toolConnectionId) ?? [];
    current.push(BotId.parse(row.botId));
    byTool.set(row.toolConnectionId, current);
  }
  return byTool;
};

const ownedRow = async (db: Db, ownerId: UserId, id: ToolConnectionId): Promise<ToolRow | null> => {
  const [row] = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.id, id), eq(toolConnections.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
};

export async function findOwnedTool(db: Db, ownerId: UserId, id: ToolConnectionId): Promise<ToolConnection | null> {
  const row = await ownedRow(db, ownerId, id);
  if (row === null) return null;
  const byTool = await assignments(db, [id]);
  return toTool(row, byTool.get(id) ?? []);
}

export async function listToolsByOwner(db: Db, ownerId: UserId): Promise<ToolConnection[]> {
  const rows = await db
    .select()
    .from(toolConnections)
    .where(eq(toolConnections.ownerId, ownerId))
    .orderBy(asc(toolConnections.createdAt), asc(toolConnections.id));
  const byTool = await assignments(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toTool(row, byTool.get(row.id) ?? []));
}

export async function listToolConfigs(db: Db, ownerId: UserId, crypto: ToolCrypto): Promise<ToolConnectionConfig[]> {
  const rows = await db
    .select()
    .from(toolConnections)
    .where(eq(toolConnections.ownerId, ownerId))
    .orderBy(asc(toolConnections.createdAt), asc(toolConnections.id));
  const byTool = await assignments(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    ToolConnectionConfig.parse({
      ...toTool(row, byTool.get(row.id) ?? []),
      authorization: row.authorizationEnc === null ? null : crypto.decrypt(row.authorizationEnc),
    }),
  );
}

export async function createTool(
  db: Db,
  ownerId: UserId,
  input: CreateToolRequest,
  operations: ToolOperation[],
  crypto: ToolCrypto,
): Promise<ToolConnection | null> {
  const [row] = await db
    .insert(toolConnections)
    .values({
      id: ToolConnectionId.parse(newId()),
      ownerId,
      name: input.name,
      url: input.url,
      authorizationEnc: input.authorization === undefined ? null : crypto.encrypt(input.authorization),
      operations,
    })
    .onConflictDoNothing({ target: [toolConnections.ownerId, toolConnections.name] })
    .returning();
  return row === undefined ? null : toTool(row, []);
}

const isNameTaken = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "23505";

export type UpdateToolResult =
  | { kind: "ok"; tool: ToolConnection }
  | { kind: "gone" }
  | { kind: "name_taken" }
  | { kind: "invalid_operation" }
  | { kind: "invalid_bot" };

/** 换了凭据之后重新探测到的操作表，和加密好的新凭据。 */
export type Reauthorized = { readonly authorizationEnc: string | null; readonly discovered: readonly ToolOperation[] };

/**
 * 补授权按新列表重建：同名的沿用原来定过的 needsApproval，新出现的按注解定，列表里没有了的就去掉。
 * 再叠上这次请求自己带的 needsApproval；带了不在表上的操作名就是 null。
 */
function nextOperations(
  stored: readonly ToolOperation[],
  reauthorized: Reauthorized | undefined,
  patched: UpdateToolRequest["operations"],
): ToolOperation[] | null {
  const base =
    reauthorized === undefined
      ? stored
      : reauthorized.discovered.map((operation) => ({
          ...operation,
          needsApproval:
            stored.find((before) => before.name === operation.name)?.needsApproval ?? operation.needsApproval,
        }));
  if (patched === undefined) return [...base];
  const byName = new Map(patched.map((operation) => [operation.name, operation.needsApproval]));
  if (byName.size !== patched.length || [...byName.keys()].some((name) => !base.some((op) => op.name === name))) {
    return null;
  }
  return base.map(({ name, description, inputSchema, needsApproval }) => ({
    name,
    description,
    inputSchema,
    needsApproval: byName.get(name) ?? needsApproval,
  }));
}

export async function updateTool(
  db: Db,
  ownerId: UserId,
  current: ToolConnection,
  patch: UpdateToolRequest,
  reauthorized?: Reauthorized,
): Promise<UpdateToolResult> {
  const assigned = patch.assignedBotIds === undefined ? undefined : [...new Set(patch.assignedBotIds)];
  if (assigned !== undefined && assigned.length > 0) {
    const owned = await db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.ownerId, ownerId), inArray(bots.id, assigned)));
    if (owned.length !== assigned.length) return { kind: "invalid_bot" };
  }

  try {
    return await db.transaction(async (tx): Promise<UpdateToolResult> => {
      // 补授权要等 MCP 回列表，这期间别的请求可能已经改了操作表。锁住行、按落库的最新一版合并，不拿进来时那份旧的。
      const [locked] = await tx
        .select()
        .from(toolConnections)
        .where(and(eq(toolConnections.id, current.id), eq(toolConnections.ownerId, ownerId)))
        .for("update");
      if (locked === undefined) return { kind: "gone" };
      const changes: Partial<typeof toolConnections.$inferInsert> = {};
      if (patch.name !== undefined) changes.name = patch.name;
      if (reauthorized !== undefined || patch.operations !== undefined) {
        const operations = nextOperations(locked.operations, reauthorized, patch.operations);
        if (operations === null) return { kind: "invalid_operation" };
        changes.operations = operations;
      }
      if (reauthorized !== undefined) {
        changes.authorizationEnc = reauthorized.authorizationEnc;
        changes.status = "ready";
      }
      const [row] =
        Object.keys(changes).length === 0
          ? [locked]
          : await tx.update(toolConnections).set(changes).where(eq(toolConnections.id, locked.id)).returning();
      if (row === undefined) return { kind: "gone" };
      if (assigned !== undefined) {
        await tx.delete(toolConnectionBots).where(eq(toolConnectionBots.toolConnectionId, current.id));
        if (assigned.length > 0) {
          await tx
            .insert(toolConnectionBots)
            .values(assigned.map((botId) => ({ toolConnectionId: current.id, botId })));
        }
      }
      // 不改分配就按锁住之后读到的最新分配回，不拿进来时那份：等 MCP 的这段时间别的请求可能改过。
      const assignedNow = assigned ?? (await assignments(tx, [locked.id])).get(locked.id) ?? [];
      return { kind: "ok", tool: toTool(row, assignedNow) };
    });
  } catch (error) {
    if (isNameTaken(error)) return { kind: "name_taken" };
    throw error;
  }
}

export async function deleteTool(db: Db, ownerId: UserId, id: ToolConnectionId): Promise<boolean> {
  const deleted = await db
    .delete(toolConnections)
    .where(and(eq(toolConnections.id, id), eq(toolConnections.ownerId, ownerId)))
    .returning({ id: toolConnections.id });
  return deleted.length > 0;
}
