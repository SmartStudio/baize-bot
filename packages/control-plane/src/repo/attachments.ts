import { AttachmentId, type AttachmentMime, type BotId, type GroupId, type UserId } from "@baize/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { attachments, bots, groupMembers, groups } from "../db/schema.js";
import { newId } from "../ids.js";
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

export async function findOwnedAttachment(db: Db, ownerId: UserId, id: AttachmentId) {
  const [row] = await db
    .select({ bytes: attachments.bytes, mime: attachments.mime, size: attachments.size })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}
