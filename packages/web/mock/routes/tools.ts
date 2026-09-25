import { randomUUID } from "node:crypto";
import { CreateToolRequest, ToolConnection, UpdateToolRequest } from "@baize/shared";
import { bots, tools, user } from "../state.js";
import { defined, readBody, send, type Route } from "./http.js";

export const toolRoutes: Route = async ({ req, res, path, method }) => {
  if (method === "GET" && path === "/api/tools") {
    send(res, 200, { items: [...tools.values()] });
    return true;
  }

  if (method === "POST" && path === "/api/tools") {
    const parsed = CreateToolRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "工具字段不对" });
    else if ([...tools.values()].some((tool) => tool.name === parsed.data.name)) {
      send(res, 409, { error: "已有同名工具连接" });
    } else {
      const host = new URL(parsed.data.url).host;
      if (host.includes("bad")) send(res, 400, { error: "连不上 MCP：ECONNREFUSED" });
      else {
        const tool = ToolConnection.parse({
          id: `tool_${randomUUID()}`,
          ownerId: user.id,
          name: parsed.data.name,
          url: parsed.data.url,
          operations: [
            {
              name: "do_thing",
              description: "执行操作",
              inputSchema: { type: "object", properties: {} },
              needsApproval: true,
            },
            {
              name: "list_things",
              description: "列出事项",
              inputSchema: { type: "object", properties: {} },
              needsApproval: false,
            },
          ],
          assignedBotIds: [],
        });
        tools.set(tool.id, tool);
        send(res, 201, { tool });
      }
    }
    return true;
  }

  const match = /^\/api\/tools\/([^/]+)$/.exec(path);
  if (match === null) return false;
  const rawToolId = match[1];
  const toolId = rawToolId === undefined ? "" : decodeURIComponent(rawToolId);
  const tool = tools.get(toolId);
  if (tool === undefined) send(res, 404, { error: "没有这个工具" });
  else if (method === "PATCH") {
    const parsed = UpdateToolRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "工具字段不对" });
    else if (
      parsed.data.assignedBotIds?.some((botId) => {
        const bot = bots.get(botId);
        return bot === undefined || bot.ownerId !== user.id;
      })
    ) {
      send(res, 400, { error: "只能分配给自己的 Bot" });
    } else {
      const operations =
        parsed.data.operations === undefined
          ? tool.operations
          : parsed.data.operations.map((operation) => {
              const existing = tool.operations.find((candidate) => candidate.name === operation.name);
              return existing === undefined ? null : { ...existing, needsApproval: operation.needsApproval };
            });
      if (operations.some((operation) => operation === null)) send(res, 400, { error: "工具操作不存在" });
      else {
        const next = ToolConnection.parse({ ...tool, ...defined(parsed.data), operations });
        tools.set(next.id, next);
        send(res, 200, { tool: next });
      }
    }
  } else if (method === "DELETE") {
    tools.delete(tool.id);
    send(res, 204);
  } else return false;
  return true;
};
