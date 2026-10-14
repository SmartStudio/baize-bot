import { createHash } from "node:crypto";
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentId,
  AttachmentMime,
  AttachmentSha256,
  AttachmentUploadQuery,
  AttachmentUploadResponse,
  imageMime,
} from "@baize/shared";
import { Hono } from "hono";
import type { Db } from "../../db/client.js";
import { canUploadAttachment, findOwnedAttachment, storeAttachment } from "../../repo/attachments.js";
import type { HubEnv } from "../hub-auth.js";

export function createAttachmentRoutes(deps: { readonly db: Db }): Hono<HubEnv> {
  const app = new Hono<HubEnv>();

  app.put("/attachments", async (c) => {
    const query = AttachmentUploadQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "附件的 Bot 和群参数格式不对" }, 400);
    const mime = AttachmentMime.safeParse(c.req.header("content-type"));
    if (!mime.success) return c.json({ error: "附件只支持 PNG、JPEG、WebP 和 GIF" }, 415);
    const declaredHash = AttachmentSha256.safeParse(c.req.header("x-baize-sha256"));
    if (!declaredHash.success) return c.json({ error: "附件 sha256 格式不对" }, 400);
    // 先核归属再读体，不替别人的 Bot 收完 20 MiB；storeAttachment 在事务里还会再核一次。
    if (!(await canUploadAttachment(deps.db, { ownerId: c.get("ownerId"), ...query.data })))
      return c.json({ error: "没有这个 Bot 或群" }, 404);

    const bytes = await readAttachment(c.req.raw);
    if (bytes === null) return c.json({ error: "附件超过 20 MiB 上限" }, 413);
    if (bytes.length === 0) return c.json({ error: "附件图片不能为空" }, 400);
    const actualMime = imageMime(bytes);
    if (actualMime === null) return c.json({ error: "附件字节不是 PNG、JPEG、WebP 或 GIF 图片" }, 400);
    if (actualMime !== mime.data) return c.json({ error: "附件图片格式和 Content-Type 不一致" }, 400);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== declaredHash.data) return c.json({ error: "附件 sha256 和声明不一致" }, 400);

    const attachmentId = await storeAttachment(deps.db, {
      ownerId: c.get("ownerId"),
      ...query.data,
      sha256,
      mime: mime.data,
      bytes,
    });
    if (attachmentId === null) return c.json({ error: "没有这个 Bot 或群" }, 404);
    return c.json(AttachmentUploadResponse.parse({ attachmentId, sha256 }));
  });

  app.get("/attachments/:id", async (c) => {
    const id = AttachmentId.safeParse(c.req.param("id"));
    const attachment = id.success ? await findOwnedAttachment(deps.db, c.get("ownerId"), id.data) : null;
    if (attachment === null) return c.json({ error: "没有这个附件" }, 404);
    return new Response(new Uint8Array(attachment.bytes), {
      headers: { "content-type": attachment.mime, "content-length": String(attachment.size) },
    });
  });

  return app;
}

async function readAttachment(request: Request): Promise<Buffer | null> {
  if (request.body === null) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > ATTACHMENT_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
