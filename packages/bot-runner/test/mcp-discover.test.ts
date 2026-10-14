import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_DISCOVERY_MAX_BYTES, MCP_DISCOVERY_MAX_OPERATIONS } from "@baize/shared";
import { discoverMcpTools } from "../src/mcp-discover.js";

interface McpReplyOptions {
  readonly pages?: Readonly<Record<string, { readonly tools: readonly unknown[]; readonly nextCursor?: string }>>;
  readonly delayMs?: number;
  readonly delayListCursorMs?: Readonly<Record<string, number>>;
  readonly status?: number;
  readonly rpcError?: { readonly code: number; readonly message: string };
}

interface LocalMcp {
  readonly url: string;
  readonly requests: string[];
  close(): Promise<void>;
}

const operation = (name: string, annotations?: { readonly readOnlyHint?: boolean }) => ({
  name,
  description: `工具 ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  ...(annotations === undefined ? {} : { annotations }),
});

async function startLocalMcp(options: McpReplyOptions = {}): Promise<LocalMcp> {
  const requests: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (body === "") {
        response.writeHead(400).end();
        return;
      }
      const rpc = JSON.parse(body) as {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: { readonly cursor?: string };
      };
      requests.push(rpc.method ?? "");
      const reply = (): void => {
        if (options.status !== undefined) {
          response.writeHead(options.status).end("not MCP");
          return;
        }
        if (rpc.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown;
        if (rpc.method === "initialize") {
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "local-test-mcp", version: "1.0.0" },
          };
        } else if (rpc.method === "tools/list") {
          if (options.rpcError !== undefined) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: options.rpcError }));
            return;
          }
          result = options.pages?.[rpc.params?.cursor ?? ""] ?? { tools: [] };
        } else {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      };
      const pageDelay = options.delayListCursorMs?.[rpc.params?.cursor ?? ""];
      const delayMs = options.delayMs ?? (rpc.method === "tools/list" ? pageDelay : undefined);
      if (delayMs === undefined) reply();
      else {
        const timer = setTimeout(() => {
          timers.delete(timer);
          reply();
        }, delayMs);
        timers.add(timer);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}

describe("discoverMcpTools", () => {
  const servers: LocalMcp[] = [];
  let clientClose: ReturnType<typeof vi.spyOn>;
  let transportClose: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clientClose = vi.spyOn(Client.prototype, "close");
    transportClose = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    vi.restoreAllMocks();
  });

  const local = async (options?: McpReplyOptions): Promise<LocalMcp> => {
    const server = await startLocalMcp(options);
    servers.push(server);
    return server;
  };

  const expectClosed = (): void => {
    expect(clientClose).toHaveBeenCalled();
    expect(transportClose).toHaveBeenCalled();
  };

  it("通过 Streamable HTTP 读取所有分页并按 readOnlyHint 标审批", async () => {
    const server = await local({
      pages: {
        "": { tools: [operation("lookup", { readOnlyHint: true })], nextCursor: "page-2" },
        "page-2": { tools: [operation("send")] },
      },
    });
    const result = await discoverMcpTools({ url: server.url, authorization: "Bearer fake-token" });
    expect(result).toEqual({
      ok: true,
      operations: [
        {
          name: "lookup",
          description: "工具 lookup",
          inputSchema: operation("lookup").inputSchema,
          needsApproval: false,
        },
        { name: "send", description: "工具 send", inputSchema: operation("send").inputSchema, needsApproval: true },
      ],
    });
    expect(server.requests.filter((method) => method === "tools/list")).toHaveLength(2);
    expectClosed();
  });

  it("总超时取消连接工作并返回固定分类", async () => {
    const server = await local({ delayMs: 100 });
    const result = await discoverMcpTools({ url: server.url }, { timeoutMs: 10 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expectClosed();
  });

  it("后续 tools/list 页也受连接开始后的总时限限制", async () => {
    const server = await local({
      pages: { "": { tools: [operation("first")], nextCursor: "page-2" }, "page-2": { tools: [operation("second")] } },
      delayListCursorMs: { "page-2": 5_000 },
    });
    const result = await discoverMcpTools({ url: server.url }, { timeoutMs: 1_000 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(server.requests.filter((method) => method === "tools/list")).toHaveLength(2);
    expectClosed();
  });

  it("操作描述回显授权凭据时拒绝整份操作表", async () => {
    const server = await local({
      pages: {
        "": { tools: [operation("safe", { readOnlyHint: true })], nextCursor: "page-2" },
        "page-2": { tools: [operation("Bearer fake-secret")] },
      },
    });
    const result = await discoverMcpTools({ url: server.url, authorization: "Bearer fake-secret" });
    expect(result).toEqual({ ok: false, reason: "echoes_credential" });
    expect(server.requests.filter((method) => method === "tools/list")).toHaveLength(2);
    expectClosed();
  });

  it("非 MCP HTTP 端点返回 not_mcp", async () => {
    const server = await local({ status: 404 });
    expect(await discoverMcpTools({ url: server.url })).toEqual({ ok: false, reason: "not_mcp" });
    expectClosed();
  });

  it.each([401, 403])("HTTP %i 返回 unauthorized", async (status) => {
    const server = await local({ status });
    expect(await discoverMcpTools({ url: server.url })).toEqual({ ok: false, reason: "unauthorized" });
    expectClosed();
  });

  it("HTTP 500 与 JSON-RPC 错误都返回 rejected", async () => {
    const httpFailure = await local({ status: 500 });
    expect(await discoverMcpTools({ url: httpFailure.url })).toEqual({ ok: false, reason: "rejected" });
    expectClosed();

    const clientCloseCalls = clientClose.mock.calls.length;
    const transportCloseCalls = transportClose.mock.calls.length;
    const rpcFailure = await local({ rpcError: { code: -32601, message: "fake failure" } });
    expect(await discoverMcpTools({ url: rpcFailure.url })).toEqual({ ok: false, reason: "rejected" });
    expect(clientClose.mock.calls.length).toBeGreaterThan(clientCloseCalls);
    expect(transportClose.mock.calls.length).toBeGreaterThan(transportCloseCalls);
  });

  it("不可达地址返回 unreachable", async () => {
    const probe = await local();
    const url = probe.url;
    await probe.close();
    servers.splice(servers.indexOf(probe), 1);
    expect(await discoverMcpTools({ url })).toEqual({ ok: false, reason: "unreachable" });
  });

  it("拒绝非 HTTP(S) URL", async () => {
    expect(await discoverMcpTools({ url: "file:///tmp/mcp" })).toEqual({ ok: false, reason: "not_mcp" });
  });

  it("累积操作数超过共享上限时提前拒绝", async () => {
    const server = await local({
      pages: {
        "": {
          tools: Array.from({ length: MCP_DISCOVERY_MAX_OPERATIONS + 1 }, (_, index) => operation(`tool-${index}`)),
        },
      },
    });
    expect(await discoverMcpTools({ url: server.url })).toEqual({ ok: false, reason: "invalid_operations" });
  });

  it("操作表超过 1 MiB 时拒绝", async () => {
    const largeOperation = { ...operation("large"), description: "x".repeat(MCP_DISCOVERY_MAX_BYTES) };
    const pages = { "": { tools: [largeOperation] } };
    const dataServer = await local({ pages });
    expect(await discoverMcpTools({ url: dataServer.url })).toEqual({ ok: false, reason: "invalid_operations" });
  });

  it("重复 cursor 返回 invalid_operations", async () => {
    const server = await local({
      pages: { "": { tools: [], nextCursor: "again" }, again: { tools: [], nextCursor: "again" } },
    });
    expect(await discoverMcpTools({ url: server.url })).toEqual({ ok: false, reason: "invalid_operations" });
    expect(server.requests.filter((method) => method === "tools/list")).toHaveLength(2);
  });

  it("已经 aborted 的 signal 不启动 MCP 请求", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await discoverMcpTools({ url: "http://127.0.0.1:1/mcp" }, { signal: controller.signal })).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(clientClose).not.toHaveBeenCalled();
  });

  it("处理中止 signal 会取消请求并关闭 client 与 transport", async () => {
    const server = await local({ delayMs: 100 });
    const controller = new AbortController();
    const pending = discoverMcpTools({ url: server.url }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    expectClosed();
  });

  it("client 与 transport 在成功路径都关闭", async () => {
    const server = await local({ pages: { "": { tools: [] } } });
    await discoverMcpTools({ url: server.url });
    expectClosed();
  });
});
