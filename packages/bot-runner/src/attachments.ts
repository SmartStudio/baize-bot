import {
  ATTACHMENT_MAX_BYTES,
  AttachmentUploadResponse,
  type AttachmentId,
  type AttachmentMime,
  type BotId,
  type ControlToAgent,
  type GroupId,
} from "@baize/shared";

type Config = Extract<ControlToAgent, { type: "config" }>;

export interface AttachmentLive {
  readonly hub: Config["hub"];
  readonly gateway: Config["modelGateway"];
}

export const imageMime = (bytes: Buffer): AttachmentMime | null => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP")
    return "image/webp";
  const gif = bytes.toString("latin1", 0, 6);
  return gif === "GIF87a" || gif === "GIF89a" ? "image/gif" : null;
};

const IMAGE_EXTENSION: Record<AttachmentMime, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const attachmentCopyName = (sha256: string, mime: AttachmentMime): string => `${sha256}${IMAGE_EXTENSION[mime]}`;

const endpoint = (baseUrl: string, path: string): URL => {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path}`);
  url.search = "";
  url.hash = "";
  return url;
};

export async function uploadAttachment(
  live: (() => AttachmentLive) | undefined,
  source: { readonly botId: BotId; readonly groupId: GroupId; readonly sha256: string; readonly mime: AttachmentMime },
  bytes: Buffer,
): Promise<AttachmentUploadResponse> {
  try {
    if (live === undefined) throw new Error("附件配置尚未下发");
    const { hub, gateway } = live();
    const url = endpoint(hub.baseUrl, "attachments");
    url.searchParams.set("botId", source.botId);
    url.searchParams.set("groupId", source.groupId);
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${gateway.apiKey}`,
        "content-type": source.mime,
        "x-baize-sha256": source.sha256,
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("附件上传失败");
    }
    const uploaded = AttachmentUploadResponse.parse(await response.json());
    if (uploaded.sha256 !== source.sha256) throw new Error("附件上传回执的哈希不一致");
    return uploaded;
  } catch {
    // 网络异常和服务器正文可能包含凭据或请求查询串，工具只返回固定文案。
    throw new Error("配图传到白泽失败，过一会儿再起草");
  }
}

export async function downloadAttachment(live: (() => AttachmentLive) | undefined, id: AttachmentId): Promise<Buffer> {
  try {
    if (live === undefined) throw new Error("附件配置尚未下发");
    const { hub, gateway } = live();
    const response = await fetch(endpoint(hub.baseUrl, `attachments/${encodeURIComponent(id)}`), {
      headers: { authorization: `Bearer ${gateway.apiKey}` },
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error("附件下载失败");
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > ATTACHMENT_MAX_BYTES) {
          await reader.cancel();
          throw new Error("附件超过上限");
        }
        parts.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(parts, size);
  } catch {
    throw new Error("配图从白泽下载失败，请稍后重试");
  }
}
