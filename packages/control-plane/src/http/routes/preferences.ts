import {
  BotId,
  BotProfileResponse,
  PreferenceId,
  PreferenceListResponse,
  PreferenceResponse,
  UpdatePreferenceRequest,
} from "@baize/shared";
import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import { botProfile, findBot } from "../../repo/bots.js";
import { deletePreference, listPreferences, setPreferencePrivate } from "../../repo/preferences.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

export type PreferenceRouteDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: Pick<AgentHub, "sendConfig">;
};

const NOT_FOUND = { error: "没有这个对象" } as const;

/** 挂在 /api 下、登录中间件之后。别人的 Bot 和偏好与不存在的一样回 404。 */
export function createPreferenceRoutes({ db, push, agents }: PreferenceRouteDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/bots/:id/preferences", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    if (!botId.success || (await findBot(db, c.get("user").id, botId.data)) === null) return c.json(NOT_FOUND, 404);
    return c.json(PreferenceListResponse.parse({ items: await listPreferences(db, botId.data) }));
  });

  app.patch("/preferences/:id", async (c) => {
    const id = PreferenceId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NOT_FOUND, 404);
    const body = UpdatePreferenceRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "请求体不合法" }, 400);
    const ownerId = c.get("user").id;
    const preference = await setPreferencePrivate(db, ownerId, id.data, body.data.private);
    if (preference === null) return c.json(NOT_FOUND, 404);
    // 写库一返回就推：sendConfig 读库可能拖到别的请求删掉它之后，那时再推更新会把已删的偏好推回页面。
    push.push(ownerId, { type: "preference_updated", preference });
    await agents.sendConfig(ownerId);
    return c.json(PreferenceResponse.parse({ preference }));
  });

  app.delete("/preferences/:id", async (c) => {
    const id = PreferenceId.safeParse(c.req.param("id"));
    if (!id.success) return c.json(NOT_FOUND, 404);
    const ownerId = c.get("user").id;
    const botId = await deletePreference(db, ownerId, id.data);
    if (botId === null) return c.json(NOT_FOUND, 404);
    await agents.sendConfig(ownerId);
    push.push(ownerId, { type: "preference_deleted", preferenceId: id.data, botId });
    return c.body(null, 204);
  });

  app.get("/bots/:id/profile", async (c) => {
    const botId = BotId.safeParse(c.req.param("id"));
    const profile = botId.success ? await botProfile(db, c.get("user").id, botId.data) : null;
    if (profile === null) return c.json(NOT_FOUND, 404);
    return c.json(BotProfileResponse.parse(profile));
  });

  return app;
}
