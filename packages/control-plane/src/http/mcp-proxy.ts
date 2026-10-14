import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  McpProxyCallRequest,
  ToolConnectionId,
  describeMcpFailure,
  redactCredential,
  type BotId,
  type GroupId,
  type UserId,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import type { ToolCrypto } from "../crypto.js";
import {
  McpClients,
  McpClientsClosedError,
  McpResultTooLargeError,
  MCP_CALL_TIMEOUT_MS,
  MCP_MAX_BODY_BYTES,
} from "../mcp/call.js";
import { findBot } from "../repo/bots.js";
import { findComputerByGatewayKey } from "../repo/computers.js";
import { findOwnedTool, toolAuthorization } from "../repo/tools.js";
import { bearerToken } from "./gateway.js";
import { LANE_FENCE_ERRORS, validateLaneFence } from "./lane-fence.js";

export const MCP_PROXY_PATH = "/mcp-proxy";

export function createMcpProxy(deps: { readonly db: Db; readonly crypto: ToolCrypto; readonly clients: McpClients }) {
  const app = new Hono<{ Variables: { ownerId: UserId; lane: { botId: BotId; groupId: GroupId; epoch: number } } }>();
  app.use("*", async (c, next) => {
    const key = bearerToken(c.req.header("authorization"));
    const computer = key === null ? null : await findComputerByGatewayKey(deps.db, key);
    if (computer === null) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
    const fence = await validateLaneFence(deps.db, computer, c.req.header("x-baize-lane"));
    if (fence.kind !== "ok") return c.json({ error: LANE_FENCE_ERRORS[fence.kind] }, 409);
    c.set("ownerId", computer.ownerId);
    c.set("lane", fence.lane);
    await next();
  });
  app.post(
    "/:connectionId/call",
    bodyLimit({
      maxSize: MCP_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "请求体超过 20 MiB 上限" }, 413),
    }),
    async (c) => {
      const ownerId = c.get("ownerId");
      const id = ToolConnectionId.safeParse(c.req.param("connectionId"));
      const connection = id.success ? await findOwnedTool(deps.db, ownerId, id.data) : null;
      if (connection === null) return c.json({ error: "没有这个插件" }, 404);
      if (connection.localOnly) return c.json({ error: "这个插件只在本机用" }, 409);
      if (connection.status !== "ready") return c.json({ error: "这个插件还没补授权" }, 409);
      const parsed = McpProxyCallRequest.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "工具调用参数格式不对" }, 400);
      const body = parsed.data;
      if (
        body.botId !== c.get("lane").botId ||
        !connection.assignedBotIds.includes(body.botId) ||
        (await findBot(deps.db, ownerId, body.botId)) === null
      ) {
        return c.json({ error: "没有分配给这个 Bot 的插件" }, 404);
      }
      if (!connection.operations.some((operation) => operation.name === body.tool)) {
        return c.json({ error: "没有这个插件操作" }, 404);
      }
      const authorization = await toolAuthorization(deps.db, ownerId, connection.id, deps.crypto);
      const timeout = AbortSignal.timeout(MCP_CALL_TIMEOUT_MS);
      try {
        const result = await deps.clients.call(
          connection,
          authorization,
          body.tool,
          body.arguments,
          AbortSignal.any([c.req.raw.signal, timeout]),
        );
        return c.json(result);
      } catch (error) {
        if (error instanceof McpClientsClosedError) return c.json({ error: "插件服务正在停机，请稍后再试" }, 502);
        if (error instanceof McpResultTooLargeError) return c.json({ error: "插件结果超过 20 MiB 上限" }, 502);
        const message = timeout.aborted
          ? "插件调用超过 60 秒，请稍后再试"
          : `插件调用失败：${describeMcpFailure(error)}`;
        // 不打印对端的错误对象：它可能把 Authorization 按任意编码放在 message、cause 或 stack。
        return c.json({ error: redactCredential(message, authorization) }, timeout.aborted ? 504 : 502);
      }
    },
  );
  return app;
}
