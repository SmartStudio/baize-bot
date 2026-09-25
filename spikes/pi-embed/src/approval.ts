import type { ToolView } from "@baize/shared";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

// 审批拦截器。扩展在 tool_call 事件里挂起一个 pending，外部通过 HTTP 给出批准或拒绝。
// 对应规格第三部分「审批用 Pi 的 tool_call 事件拦截」，这里用本地 HTTP 顶替控制面。

export const Decision = z.object({ approved: z.boolean(), reason: z.string().default("") });
export type Decision = z.infer<typeof Decision>;

export interface PendingApproval {
  readonly callId: string;
  readonly botId: string;
  readonly tool: string;
  readonly view: ToolView;
}

export interface ApprovalGate {
  readonly baseUrl: string;
  /** 扩展调用。挂起直到外部给出结论。 */
  request(pending: PendingApproval): Promise<Decision>;
  readonly blockedCallIds: ReadonlySet<string>;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      raw += c;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });

export async function startApprovalGate(): Promise<ApprovalGate> {
  const waiting = new Map<string, { pending: PendingApproval; resolve: (d: Decision) => void }>();
  const blockedCallIds = new Set<string>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/approvals") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([...waiting.values()].map((w) => w.pending)));
      return;
    }
    if (req.method === "POST" && url.startsWith("/approvals/")) {
      const callId = decodeURIComponent(url.slice("/approvals/".length));
      const entry = waiting.get(callId);
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `没有等待中的审批 ${callId}` }));
        return;
      }
      const decision = Decision.parse(JSON.parse(await readBody(req)));
      waiting.delete(callId);
      if (!decision.approved) blockedCallIds.add(callId);
      entry.resolve(decision);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ callId, ...decision }));
      return;
    }
    res.writeHead(404).end();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    blockedCallIds,
    request: (pending) =>
      new Promise<Decision>((resolve) => {
        waiting.set(pending.callId, { pending, resolve });
      }),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
