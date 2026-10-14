import { createHash } from "node:crypto";
import { createServer } from "node:http";

export async function startAttachmentHub() {
  const uploads: Array<{
    authorization: string;
    botId: string | null;
    groupId: string | null;
    sha256: string;
    mime: string;
    bytes: Buffer;
  }> = [];
  const downloads: string[] = [];
  const stored = new Map<string, Buffer>();
  let failUpload = false;
  let downloadBytes: Buffer | null = null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const authorization = request.headers.authorization ?? "";
    if (request.method === "PUT" && url.pathname === "/hub/v1/attachments") {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part as Uint8Array));
      const bytes = Buffer.concat(parts);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      uploads.push({
        authorization,
        botId: url.searchParams.get("botId"),
        groupId: url.searchParams.get("groupId"),
        sha256: String(request.headers["x-baize-sha256"]),
        mime: String(request.headers["content-type"]),
        bytes,
      });
      if (failUpload) {
        response.writeHead(503).end(`Bearer ${authorization} ${request.url}`);
        return;
      }
      const attachmentId = `attachment-${sha256}`;
      stored.set(attachmentId, bytes);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ attachmentId, sha256 }));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/hub/v1/attachments/")) {
      downloads.push(authorization);
      const id = decodeURIComponent(url.pathname.slice("/hub/v1/attachments/".length));
      const bytes = downloadBytes ?? stored.get(id);
      if (bytes === undefined) {
        response.writeHead(404).end(`Bearer ${authorization} ${request.url}`);
        return;
      }
      response.writeHead(200, { "content-type": "image/png" }).end(bytes);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假附件服务没有监听端口");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/hub/v1`,
    uploads,
    downloads,
    stored,
    failUploads: () => {
      failUpload = true;
    },
    corruptDownloads: (bytes: Buffer) => {
      downloadBytes = bytes;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

export type AttachmentHub = Awaited<ReturnType<typeof startAttachmentHub>>;
