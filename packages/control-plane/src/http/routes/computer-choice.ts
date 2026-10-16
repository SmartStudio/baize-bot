import { BotId, GroupId, PutComputerChoiceRequest } from "@baize/shared";
import { Hono } from "hono";
import { computerAvailability, type AvailabilityAgents } from "../../agent/computer-availability.js";
import { CHOICE_REFUSED, chooseComputer, listComputerChoices } from "../../agent/computer-choice.js";
import type { Db } from "../../db/client.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

export type ComputerChoiceRouteDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AvailabilityAgents };

const NOT_FOUND = { error: "没有这个对象" } as const;

/** 挂在 /api 下、登录中间件之后。别人的群、不在群里的 Bot 和不存在的一样回 404。 */
export function createComputerChoiceRoutes({ db, push, agents }: ComputerChoiceRouteDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.put("/groups/:groupId/bots/:botId/computer", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("groupId"));
    const botId = BotId.safeParse(c.req.param("botId"));
    if (!groupId.success || !botId.success) return c.json(NOT_FOUND, 404);
    const body = PutComputerChoiceRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "请求体不合法" }, 400);
    const ownerId = c.get("user").id;
    const outcome = await db.transaction((tx) =>
      chooseComputer(
        tx,
        { ownerId, groupId: groupId.data, botId: botId.data, kind: body.data.kind, by: "user" },
        { availability: () => computerAvailability(tx, agents, ownerId) },
      ),
    );
    if (outcome.kind === "not_found") return c.json(NOT_FOUND, 404);
    if (outcome.kind === "refused") return c.json({ error: CHOICE_REFUSED[outcome.reason][body.data.kind] }, 409);
    if (outcome.kind === "changed") for (const one of outcome.pushes) push.push(ownerId, one);
    return c.body(null, 204);
  });

  app.get("/groups/:groupId/computer-choices", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("groupId"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const choices = await listComputerChoices(db, c.get("user").id, groupId.data);
    if (choices === null) return c.json(NOT_FOUND, 404);
    return c.json(choices);
  });

  return app;
}
