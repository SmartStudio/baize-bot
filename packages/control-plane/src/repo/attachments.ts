import {
  AttachmentId,
  type AttachmentMime,
  type BotId,
  type DraftImage,
  type GroupId,
  type UserId,
} from "@baize/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { attachments, bots, groupMembers, groups } from "../db/schema.js";
import { newId } from "../ids.js";
import type { Tx } from "./messages.js";
import { lockOwner, shareBotRunsLock } from "./runs.js";

export async function canUploadAttachment(
  db: Db,
  input: { readonly ownerId: UserId; readonly botId: BotId; readonly groupId: GroupId },
): Promise<boolean> {
  const [scope] = await db
    .select({ botId: bots.id })
    .from(groupMembers)
    .innerJoin(bots, eq(bots.id, groupMembers.botId))
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(
      and(
        eq(bots.id, input.botId),
        eq(bots.ownerId, input.ownerId),
        eq(groups.id, input.groupId),
        eq(groups.ownerId, input.ownerId),
      ),
    )
    .limit(1);
  return scope !== undefined;
}

export async function storeAttachment(
  db: Db,
  input: {
    readonly ownerId: UserId;
    readonly botId: BotId;
    readonly groupId: GroupId;
    readonly sha256: string;
    readonly mime: AttachmentMime;
    readonly bytes: Buffer;
  },
): Promise<AttachmentId | null> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, input.ownerId, "shared");
    await shareBotRunsLock(tx, input.botId);
    const [scope] = await tx
      .select({ botId: bots.id })
      .from(groupMembers)
      .innerJoin(bots, eq(bots.id, groupMembers.botId))
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(
        and(
          eq(bots.id, input.botId),
          eq(bots.ownerId, input.ownerId),
          eq(groups.id, input.groupId),
          eq(groups.ownerId, input.ownerId),
        ),
      )
      .for("key share");
    if (scope === undefined) return null;

    const [stored] = await tx
      .insert(attachments)
      .values({ id: newId(), ...input, size: input.bytes.length })
      .onConflictDoUpdate({
        target: [attachments.ownerId, attachments.botId, attachments.groupId, attachments.sha256],
        set: { sha256: input.sha256 },
      })
      .returning({ id: attachments.id });
    if (stored === undefined) throw new Error("保存附件没有返回 id");
    return AttachmentId.parse(stored.id);
  });
}

const FACTS = { id: attachments.id, sha256: attachments.sha256, mime: attachments.mime, size: attachments.size };

export async function findOwnedAttachmentFacts(db: Db | Tx, ownerId: UserId, ids: readonly AttachmentId[]) {
  if (ids.length === 0) return [];
  return db
    .select(FACTS)
    .from(attachments)
    .where(and(eq(attachments.ownerId, ownerId), inArray(attachments.id, [...ids])));
}

export async function findOwnedAttachmentBytes(db: Db, ownerId: UserId, ids: readonly AttachmentId[]) {
  if (ids.length === 0) return [];
  return db
    .select({ ...FACTS, bytes: attachments.bytes })
    .from(attachments)
    .where(and(eq(attachments.ownerId, ownerId), inArray(attachments.id, [...ids])));
}

export type DraftImageMatch<R> =
  { readonly kind: "matched"; readonly rows: readonly R[] } | { readonly kind: "missing"; readonly position: number };

export function matchDraftImages<R extends { readonly id: string; readonly sha256: string; readonly mime: string }>(
  images: readonly DraftImage[],
  rows: readonly R[],
): DraftImageMatch<R> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const matched: R[] = [];
  for (const [index, image] of images.entries()) {
    const row = image.kind === "attachment" ? byId.get(image.attachmentId) : undefined;
    if (image.kind !== "attachment" || row === undefined || row.sha256 !== image.sha256 || row.mime !== image.mime) {
      return { kind: "missing", position: index + 1 };
    }
    matched.push(row);
  }
  return { kind: "matched", rows: matched };
}

export const draftAttachmentIds = (images: readonly DraftImage[]): AttachmentId[] =>
  images.flatMap((image) => (image.kind === "attachment" ? [image.attachmentId] : []));

export async function findOwnedAttachment(db: Db, ownerId: UserId, id: AttachmentId) {
  const [row] = await db
    .select({ bytes: attachments.bytes, mime: attachments.mime, size: attachments.size })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}
