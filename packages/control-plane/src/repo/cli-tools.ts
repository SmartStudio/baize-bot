import {
  BotId,
  CliTool,
  CliToolConfig,
  CliToolId,
  type ComputerKind,
  type CreateCliToolRequest,
  type UpdateCliToolRequest,
  type UserId,
} from "@baize/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ToolCrypto } from "../crypto.js";
import type { Db } from "../db/client.js";
import { bots, cliToolBots, cliToolEnv, cliTools } from "../db/schema.js";
import { newId } from "../ids.js";
import type { Tx } from "./messages.js";

type ToolRow = typeof cliTools.$inferSelect;
type EnvRow = typeof cliToolEnv.$inferSelect;

const MAX_ENV = 10;

/** 不足 8 位的值，末四位就是它的一半以上，干脆不给。 */
const last4 = (value: string): string => (value.length >= 8 ? value.slice(-4) : "");

type Related = { readonly env: Map<string, EnvRow[]>; readonly bots: Map<string, BotId[]> };

async function related(db: Db | Tx, ids: string[]): Promise<Related> {
  const env = new Map<string, EnvRow[]>();
  const assigned = new Map<string, BotId[]>();
  if (ids.length === 0) return { env, bots: assigned };
  const [envRows, botRows] = await Promise.all([
    db.select().from(cliToolEnv).where(inArray(cliToolEnv.toolId, ids)).orderBy(asc(cliToolEnv.name)),
    db.select().from(cliToolBots).where(inArray(cliToolBots.toolId, ids)).orderBy(asc(cliToolBots.botId)),
  ]);
  for (const row of envRows) env.set(row.toolId, [...(env.get(row.toolId) ?? []), row]);
  for (const row of botRows) assigned.set(row.toolId, [...(assigned.get(row.toolId) ?? []), BotId.parse(row.botId)]);
  return { env, bots: assigned };
}

const botsOf = (row: ToolRow, rel: Related): BotId[] | null =>
  row.botScope === "all" ? null : (rel.bots.get(row.id) ?? []);

const toView = (row: ToolRow, rel: Related): CliTool =>
  CliTool.parse({
    id: row.id,
    command: row.command,
    install: row.install,
    env: (rel.env.get(row.id) ?? []).map((one) => ({ name: one.name, last4: one.last4 })),
    computers: row.computers,
    bots: botsOf(row, rel),
    createdAt: row.createdAt.toISOString(),
  });

async function ownedRows(db: Db | Tx, ownerId: UserId): Promise<ToolRow[]> {
  return db
    .select()
    .from(cliTools)
    .where(eq(cliTools.ownerId, ownerId))
    .orderBy(asc(cliTools.createdAt), asc(cliTools.id));
}

export async function listCliTools(db: Db, ownerId: UserId): Promise<CliTool[]> {
  const rows = await ownedRows(db, ownerId);
  const rel = await related(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toView(row, rel));
}

/** 下发给一台电脑的：只要登记了这种电脑的，值在这里解密。 */
export async function listCliToolConfigs(
  db: Db,
  ownerId: UserId,
  crypto: ToolCrypto,
  kind: ComputerKind,
): Promise<CliToolConfig[]> {
  const rows = (await ownedRows(db, ownerId)).filter((row) => row.computers.includes(kind));
  const rel = await related(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    CliToolConfig.parse({
      id: row.id,
      command: row.command,
      install: row.install,
      env: (rel.env.get(row.id) ?? []).map((one) => ({ name: one.name, value: crypto.decrypt(one.valueEnc) })),
      bots: botsOf(row, rel),
    }),
  );
}

export type CliToolResult =
  | { readonly kind: "ok"; readonly tool: CliTool }
  | { readonly kind: "gone" }
  | { readonly kind: "command_taken" }
  | { readonly kind: "invalid_bot" }
  | { readonly kind: "too_many_env" };

/** 外键指向的 Bot 在校验和写入之间被删了。 */
const isMissingBot = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "23503";

async function ownsAll(tx: Tx, ownerId: UserId, botIds: readonly BotId[]): Promise<boolean> {
  const owned = await tx
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.ownerId, ownerId), inArray(bots.id, [...botIds])));
  return owned.length === botIds.length;
}

async function replaceBots(tx: Tx, toolId: string, botIds: readonly BotId[] | null): Promise<void> {
  await tx.delete(cliToolBots).where(eq(cliToolBots.toolId, toolId));
  if (botIds !== null) await tx.insert(cliToolBots).values(botIds.map((botId) => ({ toolId, botId })));
}

async function upsertEnv(
  tx: Tx,
  toolId: string,
  entries: readonly { name: string; value: string }[],
  crypto: ToolCrypto,
): Promise<void> {
  for (const entry of entries) {
    const values = { valueEnc: crypto.encrypt(entry.value), last4: last4(entry.value) };
    await tx
      .insert(cliToolEnv)
      .values({ toolId, name: entry.name, ...values })
      .onConflictDoUpdate({ target: [cliToolEnv.toolId, cliToolEnv.name], set: values });
  }
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** 拒绝时整个事务回滚：抛它出去，在事务外换回结果。 */
class Refused extends Error {
  constructor(readonly result: Exclude<CliToolResult, { kind: "ok" }>) {
    super(result.kind);
  }
}

const refuse = (result: Exclude<CliToolResult, { kind: "ok" }>): never => {
  throw new Refused(result);
};

async function inTx(db: Db, run: (tx: Tx) => Promise<CliToolResult>): Promise<CliToolResult> {
  try {
    return await db.transaction(run);
  } catch (error) {
    if (error instanceof Refused) return error.result;
    if (isMissingBot(error)) return { kind: "invalid_bot" };
    throw error;
  }
}

export async function createCliTool(
  db: Db,
  ownerId: UserId,
  input: CreateCliToolRequest,
  crypto: ToolCrypto,
): Promise<CliToolResult> {
  const botIds = input.bots === null ? null : unique(input.bots);
  return inTx(db, async (tx) => {
    if (botIds !== null && !(await ownsAll(tx, ownerId, botIds))) refuse({ kind: "invalid_bot" });
    const [row] = await tx
      .insert(cliTools)
      .values({
        id: CliToolId.parse(newId()),
        ownerId,
        command: input.command,
        install: input.install,
        computers: unique(input.computers),
        botScope: botIds === null ? "all" : "some",
      })
      .onConflictDoNothing({ target: [cliTools.ownerId, cliTools.command] })
      .returning();
    if (row === undefined) return refuse({ kind: "command_taken" });
    await upsertEnv(tx, row.id, input.env, crypto);
    await replaceBots(tx, row.id, botIds);
    return { kind: "ok", tool: toView(row, await related(tx, [row.id])) };
  });
}

export async function updateCliTool(
  db: Db,
  ownerId: UserId,
  id: CliToolId,
  patch: UpdateCliToolRequest,
  crypto: ToolCrypto,
): Promise<CliToolResult> {
  const botIds = patch.bots === undefined || patch.bots === null ? patch.bots : unique(patch.bots);
  return inTx(db, async (tx) => {
    const [locked] = await tx
      .select()
      .from(cliTools)
      .where(and(eq(cliTools.id, id), eq(cliTools.ownerId, ownerId)))
      .for("update");
    if (locked === undefined) return refuse({ kind: "gone" });
    if (botIds !== undefined && botIds !== null && !(await ownsAll(tx, ownerId, botIds)))
      refuse({ kind: "invalid_bot" });

    const changes: Partial<typeof cliTools.$inferInsert> = {};
    if (patch.install !== undefined) changes.install = patch.install;
    if (patch.computers !== undefined) changes.computers = unique(patch.computers);
    if (botIds !== undefined) changes.botScope = botIds === null ? "all" : "some";
    const [row] =
      Object.keys(changes).length === 0
        ? [locked]
        : await tx.update(cliTools).set(changes).where(eq(cliTools.id, id)).returning();
    if (row === undefined) return refuse({ kind: "gone" });

    if (patch.remove !== undefined && patch.remove.length > 0) {
      await tx.delete(cliToolEnv).where(and(eq(cliToolEnv.toolId, id), inArray(cliToolEnv.name, patch.remove)));
    }
    if (patch.set !== undefined) await upsertEnv(tx, id, patch.set, crypto);
    if (botIds !== undefined) await replaceBots(tx, id, botIds);

    const rel = await related(tx, [id]);
    if ((rel.env.get(id)?.length ?? 0) > MAX_ENV) refuse({ kind: "too_many_env" });
    return { kind: "ok", tool: toView(row, rel) };
  });
}

export async function deleteCliTool(db: Db, ownerId: UserId, id: CliToolId): Promise<boolean> {
  const deleted = await db
    .delete(cliTools)
    .where(and(eq(cliTools.id, id), eq(cliTools.ownerId, ownerId)))
    .returning({ id: cliTools.id });
  return deleted.length > 0;
}
