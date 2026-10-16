import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL,
  MIN_AGENT_PROTOCOL,
  AgentToControl,
  BareUplinkFrame,
  ControlToAgent,
  CreateToolRequest,
  DownlinkFrame,
  MCP_DISCOVERY_MAX_BYTES,
  MCP_DISCOVERY_MAX_OPERATIONS,
  McpHttpUrl,
  UplinkFrame,
  classifyMcpDiscoveryFailure,
  validateMcpDiscoveryOperations,
} from "../src/index.js";

const operation = { name: "lookup", description: "查询", inputSchema: { type: "object" }, needsApproval: false };
describe("MCP 发现协议", () => {
  it("协议号和下限同步抬到基线加一", () => {
    expect(AGENT_PROTOCOL).toBe(4);
    expect(MIN_AGENT_PROTOCOL).toBe(AGENT_PROTOCOL);
  });
  it("带凭据的发现请求和结果仅能走 bare，不能伪装成可靠帧", () => {
    const requestId = randomUUID();
    const request = { type: "mcp_discover", requestId, url: "http://127.0.0.1/mcp", authorization: "Bearer fixture" };
    const reply = { type: "mcp_discovered", requestId, result: { ok: true, operations: [operation] } };
    expect(ControlToAgent.safeParse(request).success).toBe(true);
    expect(AgentToControl.safeParse(reply).success).toBe(true);
    expect(BareUplinkFrame.safeParse({ conn: 1, body: reply }).success).toBe(true);
    expect(DownlinkFrame.safeParse({ type: "downlink", seq: 1, body: request }).success).toBe(false);
    expect(UplinkFrame.safeParse({ type: "uplink", conn: 1, stream: "test", seq: 1, body: reply }).success).toBe(false);
  });
  it.each(["file:///tmp/mcp", "ftp://127.0.0.1/mcp", "ws://127.0.0.1/mcp", "not a URL", ""])(
    "HTTP 和代理边界都拒绝 %s",
    (url) => {
      expect(CreateToolRequest.safeParse({ name: "连接", url }).success).toBe(false);
      expect(ControlToAgent.safeParse({ type: "mcp_discover", requestId: randomUUID(), url }).success).toBe(false);
      expect(McpHttpUrl.safeParse(url).success).toBe(false);
    },
  );
  it.each(["http://127.0.0.1/mcp", "https://example.test/mcp"])("支持 %s", (url) => {
    expect(McpHttpUrl.safeParse(url).success).toBe(true);
  });
  it("个数、UTF-8 整表大小和操作形状都有限制", () => {
    expect(validateMcpDiscoveryOperations([operation], null)).toEqual({ ok: true, operations: [operation] });
    expect(
      validateMcpDiscoveryOperations(
        Array.from({ length: MCP_DISCOVERY_MAX_OPERATIONS + 1 }, () => operation),
        null,
      ),
    ).toEqual({ ok: false, reason: "invalid_operations" });
    expect(
      validateMcpDiscoveryOperations(
        [{ ...operation, description: "中".repeat(Math.ceil(MCP_DISCOVERY_MAX_BYTES / 3)) }],
        null,
      ),
    ).toEqual({ ok: false, reason: "invalid_operations" });
    expect(validateMcpDiscoveryOperations([{ ...operation, needsApproval: "true" }], null)).toEqual({
      ok: false,
      reason: "invalid_operations",
    });
  });
  it.each(["name", "description", "inputSchema"])("凭据出现在 %s 就拒绝整份操作表", (field) => {
    const authorization = "Bearer secret-fixture";
    const value =
      field === "inputSchema" ? { type: "object", description: encodeURIComponent(authorization) } : authorization;
    expect(validateMcpDiscoveryOperations([{ ...operation, [field]: value }], authorization)).toEqual({
      ok: false,
      reason: "echoes_credential",
    });
  });
  it("失败只收固定枚举，不接受电脑提供的自由文字", () => {
    expect(
      AgentToControl.safeParse({
        type: "mcp_discovered",
        requestId: randomUUID(),
        result: { ok: false, reason: "上游原文" },
      }).success,
    ).toBe(false);
  });
  it.each([
    ["AbortError", undefined, "timeout"],
    ["TimeoutError", undefined, "timeout"],
    ["McpError", -32001, "timeout"],
    ["McpError", -32603, "rejected"],
    ["ZodError", undefined, "not_mcp"],
    ["StreamableHTTPError", 404, "not_mcp"],
    ["StreamableHTTPError", 405, "not_mcp"],
    ["StreamableHTTPError", 401, "unauthorized"],
    ["StreamableHTTPError", 403, "unauthorized"],
    ["StreamableHTTPError", 500, "rejected"],
  ])("只按 SDK 错误类别 %s 和代码 %s 分类为 %s", (name, code, reason) => {
    const error = Object.assign(new Error("不可上传的上游正文"), { name, code });
    expect(classifyMcpDiscoveryFailure(error)).toBe(reason);
  });
  it("网络 TypeError 与非 MCP JSON SyntaxError 分开，未知错误也不透传正文", () => {
    expect(classifyMcpDiscoveryFailure(new TypeError())).toBe("unreachable");
    expect(classifyMcpDiscoveryFailure(new SyntaxError())).toBe("not_mcp");
    expect(classifyMcpDiscoveryFailure(new Error("fixture"))).toBe("not_mcp");
  });
});
