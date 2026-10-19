import {
  CliToolId,
  CliToolListResponse,
  CliToolResponse,
  CreateCliToolRequest,
  UpdateCliToolRequest,
} from "@baize/shared";
import { Hono, type Context } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { ToolCrypto } from "../../crypto.js";
import type { Db } from "../../db/client.js";
import { createCliTool, deleteCliTool, listCliTools, updateCliTool, type CliToolResult } from "../../repo/cli-tools.js";
import type { Env } from "../app.js";

export type CliToolRouteDeps = {
  readonly db: Db;
  readonly crypto: ToolCrypto;
  readonly agents: Pick<AgentHub, "sendConfig">;
};

const NOT_FOUND = { error: "没有这个命令行工具" };

function refused(c: Context<Env>, result: Exclude<CliToolResult, { kind: "ok" }>) {
  switch (result.kind) {
    case "gone":
      return c.json(NOT_FOUND, 404);
    case "command_taken":
      return c.json({ error: "这个命令已经登记过了，去改原来那条" }, 409);
    case "invalid_bot":
      return c.json({ error: "只能给自己的 Bot 用" }, 400);
    case "too_many_env":
      return c.json({ error: "一个工具最多登记 10 个变量" }, 400);
  }
}

/** 挂在 /api 下、登录中间件之后。值只进不出：响应里只有变量名和末四位，值随 config 解密下发给电脑。 */
export function createCliToolRoutes(deps: CliToolRouteDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/cli-tools", async (c) =>
    c.json(CliToolListResponse.parse({ items: await listCliTools(deps.db, c.get("user").id) })),
  );

  app.post("/cli-tools", async (c) => {
    const parsed = CreateCliToolRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "请求体不合法" }, 400);
    const ownerId = c.get("user").id;
    const result = await createCliTool(deps.db, ownerId, parsed.data, deps.crypto);
    if (result.kind !== "ok") return refused(c, result);
    await deps.agents.sendConfig(ownerId);
    return c.json(CliToolResponse.parse({ tool: result.tool }), 201);
  });

  app.patch("/cli-tools/:id", async (c) => {
    const id = CliToolId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NOT_FOUND, 404);
    const parsed = UpdateCliToolRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "请求体不合法" }, 400);
    const removed = new Set(parsed.data.remove ?? []);
    if ((parsed.data.set ?? []).some((entry) => removed.has(entry.name)))
      return c.json({ error: "同一个变量不能既改又删" }, 400);
    const ownerId = c.get("user").id;
    const result = await updateCliTool(deps.db, ownerId, id.data, parsed.data, deps.crypto);
    if (result.kind !== "ok") return refused(c, result);
    await deps.agents.sendConfig(ownerId);
    return c.json(CliToolResponse.parse({ tool: result.tool }));
  });

  app.delete("/cli-tools/:id", async (c) => {
    const id = CliToolId.safeParse(c.req.param("id"));
    const ownerId = c.get("user").id;
    if (!id.success || !(await deleteCliTool(deps.db, ownerId, id.data))) return c.json(NOT_FOUND, 404);
    await deps.agents.sendConfig(ownerId);
    return c.body(null, 204);
  });

  return app;
}
