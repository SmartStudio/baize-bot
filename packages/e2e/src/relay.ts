import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

export type RelayEntry = {
  readonly port: number;
  /** /agent 的升级落到这里，帧怎么转由用例自己接。 */
  readonly agents: WebSocketServer;
  close(): Promise<void>;
};

/**
 * 夹在代理和控制面之间的帧中继的入口。代理把它连的这个源报成 controlOrigin，
 * 模型网关、Hub、MCP 代理、账号代理的请求也都打到这个端口，所以这里像真实反代一样把普通 HTTP 原样转给控制面。
 * 中继掐断时只断 WebSocket，数据面不受影响：用例要的是报文丢在半路，不是模型请求失败。
 */
export async function startRelayEntry(controlPort: number): Promise<RelayEntry> {
  const server = createServer((incoming, outgoing) => {
    const forward = request(
      { host: "127.0.0.1", port: controlPort, method: incoming.method, path: incoming.url, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forward.on("error", () => outgoing.destroy());
    outgoing.on("close", () => forward.destroy());
    incoming.pipe(forward);
  });
  const agents = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    agents,
    close: async () => {
      for (const client of agents.clients) client.terminate();
      agents.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
