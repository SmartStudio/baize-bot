import { z } from "zod";
import { ToolOperation } from "./domain.js";
import { mentionsCredential } from "./secret.js";

export const McpHttpUrl = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        return ["http:", "https:"].includes(new URL(url).protocol);
      } catch {
        return false;
      }
    },
    { message: "MCP 地址只支持 http 和 https" },
  );

export const MCP_DISCOVERY_MAX_OPERATIONS = 256;
export const MCP_DISCOVERY_MAX_BYTES = 1024 * 1024;
export const McpDiscoveryReason = z.enum([
  "unreachable",
  "timeout",
  "not_mcp",
  "unauthorized",
  "rejected",
  "echoes_credential",
  "invalid_operations",
]);
export type McpDiscoveryReason = z.infer<typeof McpDiscoveryReason>;

export const McpDiscoveryOperations = z
  .array(ToolOperation.strict())
  .max(MCP_DISCOVERY_MAX_OPERATIONS)
  .refine((operations) => new TextEncoder().encode(JSON.stringify(operations)).byteLength <= MCP_DISCOVERY_MAX_BYTES, {
    message: "MCP 操作表过大",
  });

export const McpDiscoveryResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), operations: McpDiscoveryOperations }).strict(),
  z.object({ ok: z.literal(false), reason: McpDiscoveryReason }).strict(),
]);
export type McpDiscoveryResult = z.infer<typeof McpDiscoveryResult>;

export function validateMcpDiscoveryOperations(operations: unknown, authorization: string | null): McpDiscoveryResult {
  const serialized = JSON.stringify(operations);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MCP_DISCOVERY_MAX_BYTES) {
    return { ok: false, reason: "invalid_operations" };
  }
  if (mentionsCredential(serialized, authorization)) return { ok: false, reason: "echoes_credential" };
  const parsed = McpDiscoveryOperations.safeParse(operations);
  return parsed.success ? { ok: true, operations: parsed.data } : { ok: false, reason: "invalid_operations" };
}

/** 只看 SDK 错误类别和数字代码，错误正文可能带凭据，不能上行。 */
export function classifyMcpDiscoveryFailure(error: unknown): McpDiscoveryReason {
  if (!(error instanceof Error)) return "not_mcp";
  const code: unknown = "code" in error ? error.code : undefined;
  if (error.name === "AbortError" || error.name === "TimeoutError" || (error.name === "McpError" && code === -32001)) {
    return "timeout";
  }
  if (error.constructor.name === "UnauthorizedError" || code === 401 || code === 403) return "unauthorized";
  if (error instanceof SyntaxError || error.name === "ZodError" || code === 404 || code === 405) return "not_mcp";
  if (error.name === "McpError" || (typeof code === "number" && code >= 400 && code < 600)) return "rejected";
  if (error instanceof TypeError) return "unreachable";
  return "not_mcp";
}
