import { BotId, CreateBotResponse, ExportTemplateRequest, ImportTemplateRequest } from "@baize/shared";
import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import { findBot } from "../../repo/bots.js";
import { listPreferences } from "../../repo/preferences.js";
import { listSkills } from "../../repo/skills.js";
import { buildTemplate, importTemplate } from "../../repo/templates.js";
import { listToolsByOwner } from "../../repo/tools.js";
import type { Env } from "../app.js";

export type TemplateRouteDeps = {
  readonly db: Db;
  readonly agents: Pick<AgentHub, "sendConfig">;
};

const NOT_FOUND = { error: "没有这个对象" } as const;
const UNAUTHORIZED = { error: "请先登录" } as const;

/** 挂在 /api 下、登录中间件之后。分享包自包含（D11），导出和导入都不连任何外部地址。 */
export function createTemplateRoutes(deps: TemplateRouteDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.post("/bots/import", async (c) => {
    const body = ImportTemplateRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "分享包不合法" }, 400);
    const ownerId = c.get("user").id;
    const created = await importTemplate(deps.db, ownerId, body.data.template);
    if (created === null) return c.json(UNAUTHORIZED, 401);
    await deps.agents.sendConfig(ownerId);
    return c.json(CreateBotResponse.parse(created), 201);
  });

  app.post("/bots/:id/template", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success) return c.json(NOT_FOUND, 404);
    const ownerId = c.get("user").id;
    const bot = await findBot(deps.db, ownerId, botId.data);
    if (bot === null) return c.json(NOT_FOUND, 404);
    const choice = ExportTemplateRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!choice.success) return c.json({ error: choice.error.issues[0]?.message ?? "请求体不合法" }, 400);
    const [botSkills, tools, preferences] = await Promise.all([
      listSkills(deps.db, bot.id),
      listToolsByOwner(deps.db, ownerId),
      listPreferences(deps.db, bot.id),
    ]);
    return c.json(buildTemplate(bot, botSkills, tools, preferences, choice.data));
  });

  return app;
}
