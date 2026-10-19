import { randomUUID } from "node:crypto";
import { CliTool, CliToolId, CreateCliToolRequest, UpdateCliToolRequest } from "@baize/shared";
import { bots, cliTools, user } from "../state.js";
import { readBody, send, type Route } from "./http.js";

const last4 = (value: string): string => (value.length >= 8 ? value.slice(-4) : "");

const ownsAll = (ids: readonly string[] | null | undefined): boolean =>
  ids === null || ids === undefined || ids.every((id) => bots.get(id)?.ownerId === user.id);

const firstIssue = (error: { issues: { message: string }[] }): string => error.issues[0]?.message ?? "请求体不合法";

export const cliToolRoutes: Route = async ({ req, res, path, method }) => {
  if (method === "GET" && path === "/api/cli-tools") {
    send(res, 200, { items: [...cliTools.values()] });
    return true;
  }

  if (method === "POST" && path === "/api/cli-tools") {
    const parsed = CreateCliToolRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: firstIssue(parsed.error) });
    else if ([...cliTools.values()].some((tool) => tool.command === parsed.data.command))
      send(res, 409, { error: "这个命令已经登记过了，去改原来那条" });
    else if (!ownsAll(parsed.data.bots)) send(res, 400, { error: "只能给自己的 Bot 用" });
    else {
      const tool = CliTool.parse({
        id: CliToolId.parse(`cli_${randomUUID()}`),
        command: parsed.data.command,
        install: parsed.data.install,
        env: parsed.data.env.map((one) => ({ name: one.name, last4: last4(one.value) })),
        computers: [...new Set(parsed.data.computers)],
        bots: parsed.data.bots,
        createdAt: new Date().toISOString(),
      });
      cliTools.set(tool.id, tool);
      send(res, 201, { tool });
    }
    return true;
  }

  const match = /^\/api\/cli-tools\/([^/]+)$/.exec(path);
  if (match === null) return false;
  const tool = cliTools.get(decodeURIComponent(match[1] ?? ""));
  if (tool === undefined) send(res, 404, { error: "没有这个命令行工具" });
  else if (method === "DELETE") {
    cliTools.delete(tool.id);
    send(res, 204);
  } else if (method === "PATCH") {
    const parsed = UpdateCliToolRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: firstIssue(parsed.error) });
    else if (!ownsAll(parsed.data.bots)) send(res, 400, { error: "只能给自己的 Bot 用" });
    else {
      const { set = [], remove = [] } = parsed.data;
      const env = new Map(tool.env.filter((one) => !remove.includes(one.name)).map((one) => [one.name, one]));
      for (const one of set) env.set(one.name, { name: one.name, last4: last4(one.value) });
      const next = CliTool.parse({
        ...tool,
        ...(parsed.data.install === undefined ? {} : { install: parsed.data.install }),
        ...(parsed.data.computers === undefined ? {} : { computers: [...new Set(parsed.data.computers)] }),
        ...(parsed.data.bots === undefined ? {} : { bots: parsed.data.bots }),
        env: [...env.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
      });
      cliTools.set(next.id, next);
      send(res, 200, { tool: next });
    }
  } else send(res, 405, { error: "不支持" });
  return true;
};
