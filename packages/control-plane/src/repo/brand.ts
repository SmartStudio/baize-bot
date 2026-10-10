import {
  BrandBook,
  GrantId,
  GrantTarget,
  type BrandEdit,
  type ControlToAgent,
  type DraftEdit,
  type DraftId,
  type UpdateBrandRequest,
  type UserId,
} from "@baize/shared";
import { and, eq, getTableColumns } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import { brandBooks, grants } from "../db/schema.js";
import { newId } from "../ids.js";
import { findComputerByOwner } from "./computers.js";
import type { Tx } from "./messages.js";

type ConfigBrand = Extract<ControlToAgent, { type: "config" }>["brand"];
type BrandRow = typeof brandBooks.$inferSelect;

export const BRAND_MAX_CHARS = 8000;
const MAX_EDITS = 50;

function toBrand(row: BrandRow): BrandBook {
  return BrandBook.parse({
    facts: row.facts,
    voice: row.voice,
    taboo: row.taboo,
    assetsDir: row.assetsDir,
    edits: row.edits,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function getBrand(db: Db, ownerId: UserId): Promise<BrandBook | null> {
  const [row] = await db.select().from(brandBooks).where(eq(brandBooks.ownerId, ownerId)).limit(1);
  return row === undefined ? null : toBrand(row);
}

/** 可编辑的四段（事实、口吻、禁忌、素材文件夹）合计字数。「改过的地方」不算：它只随批准增长，条数另有上限。 */
function editableLength(book: UpdateBrandRequest): number {
  return book.facts.length + book.voice.length + book.taboo.length + (book.assetsDir?.length ?? 0);
}

export type BrandWrite =
  | { readonly kind: "ok"; readonly brand: BrandBook }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "stale" };

type BrandValues = Omit<UpdateBrandRequest, "version"> & { readonly updatedAt: Date };

/** 第一次写：没有手册时才插得进，主键冲突说明别人先建了，同样算版本不符。 */
async function insertFirst(tx: Tx, ownerId: UserId, values: BrandValues) {
  const [row] = await tx
    .insert(brandBooks)
    .values({ ownerId, ...values, version: 1 })
    .onConflictDoNothing()
    .returning();
  return row === undefined ? null : { row, previousAssetsDir: null };
}

/**
 * 只在库里还是调用方读到的那一版时写。自连接一份改之前的行，为的是一条语句里同时拿到旧的素材文件夹：
 * 并发写过的行重查 version 不再相等，整条不命中。
 */
async function updateAt(tx: Tx, ownerId: UserId, version: number, values: BrandValues) {
  const previous = alias(brandBooks, "previous");
  const [written] = await tx
    .update(brandBooks)
    .set({ ...values, version: version + 1 })
    .from(previous)
    .where(and(eq(brandBooks.ownerId, ownerId), eq(brandBooks.version, version), eq(previous.ownerId, ownerId)))
    .returning({ row: getTableColumns(brandBooks), previousAssetsDir: previous.assetsDir });
  return written ?? null;
}

/**
 * 整本替换，version 加一。input.version 是调用方基于的那一版，库里已经不是它就回 stale，什么都不写：
 * 草稿批准随时会往手册里追加改动，拿旧版整本覆盖会把它冲掉。
 * 素材文件夹换成新值时给本机建一条永久读授权（D9）；没换就不碰授权，人在设置里删掉的那条不会被一次无关的保存悄悄建回来。
 */
export async function replaceBrand(db: Db, ownerId: UserId, input: UpdateBrandRequest): Promise<BrandWrite> {
  if (editableLength(input) > BRAND_MAX_CHARS) {
    return { kind: "invalid", error: `品牌手册四段加起来最多 ${BRAND_MAX_CHARS} 字` };
  }
  const { version, ...book } = input;
  const values: BrandValues = { ...book, updatedAt: new Date() };
  return db.transaction(async (tx): Promise<BrandWrite> => {
    const written =
      version === 0 ? await insertFirst(tx, ownerId, values) : await updateAt(tx, ownerId, version, values);
    if (written === null) return { kind: "stale" };
    if (input.assetsDir !== null && input.assetsDir !== written.previousAssetsDir) {
      await grantAssetsRead(tx, ownerId, input.assetsDir);
    }
    return { kind: "ok", brand: toBrand(written.row) };
  });
}

async function grantAssetsRead(tx: Tx, ownerId: UserId, prefix: string): Promise<void> {
  const computer = await findComputerByOwner(tx, ownerId);
  if (computer === null) return;
  await tx
    .insert(grants)
    .values({
      id: GrantId.parse(newId()),
      ownerId,
      action: "read",
      // 请求边界已按同一契约挡过；这里再过一次，坏授权一旦落库，授权列表和 config 都会解析失败。
      target: GrantTarget.parse({ kind: "path", computerId: computer.id, prefix }),
      scope: "forever",
      groupId: null,
    })
    .onConflictDoNothing();
}

const sameEdit = (left: BrandEdit, right: BrandEdit) =>
  left.draftId === right.draftId && left.before === right.before && left.after === right.after;

/**
 * 草稿批准时调，和批准同一个事务：把这次批准记下的那笔改动追加进手册的「改过的地方」。
 * 同一条草稿的同一处改动已经在手册里就不再加，回 null，调用方据此不推 brand_updated。
 * 只看手册眼下留着的改动：人删掉的、被 50 条上限挤掉的，再批一次就是新的信号，重新记一笔。
 */
export async function recordApprovedEdit(
  tx: Tx,
  ownerId: UserId,
  draftId: DraftId,
  edit: DraftEdit | undefined,
): Promise<BrandBook | null> {
  if (edit === undefined) return null;
  const entry: BrandEdit = { draftId, before: edit.before, after: edit.after, at: edit.at };
  // 先占住这一行再锁：两条草稿同时批准时后一条等前一条提交再读，追加不会互相覆盖。
  await tx.insert(brandBooks).values({ ownerId }).onConflictDoNothing();
  const [current] = await tx.select().from(brandBooks).where(eq(brandBooks.ownerId, ownerId)).for("update");
  if (current === undefined) throw new Error("品牌手册行在同一事务里消失了");
  if (current.edits.some((existing) => sameEdit(existing, entry))) return null;
  const [row] = await tx
    .update(brandBooks)
    .set({ edits: [...current.edits, entry].slice(-MAX_EDITS), version: current.version + 1, updatedAt: new Date() })
    .where(eq(brandBooks.ownerId, ownerId))
    .returning();
  if (row === undefined) throw new Error("追加手册改动没有返回行");
  return toBrand(row);
}

const SECTIONS = [
  ["品牌事实", "facts"],
  ["口吻", "voice"],
  ["禁忌", "taboo"],
] as const;

function renderBrand(book: BrandBook): string {
  const parts = SECTIONS.filter(([, key]) => book[key].trim() !== "").map(
    ([title, key]) => `## ${title}\n${book[key].trim()}`,
  );
  if (book.assetsDir !== null) parts.push(`## 素材文件夹\n${book.assetsDir}`);
  if (book.edits.length > 0) {
    const lines = book.edits.map((edit) => `- 「${edit.before}」改成「${edit.after}」`);
    parts.push(`## 改过的地方（你写的被人改成了右边这样，以后照改后的写）\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** 随 config 下发的那份。没写过是 null，运行器据此当作「没有品牌手册」；version 不变运行器就不重送。 */
export async function listBrandForConfig(db: Db, ownerId: UserId): Promise<ConfigBrand> {
  const book = await getBrand(db, ownerId);
  return book === null ? null : { version: book.version, text: renderBrand(book) };
}
