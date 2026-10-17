import { DecideRoutineOfferRequest, DecideRoutineOfferResponse, MessageId } from "@baize/shared";
import { Hono } from "hono";
import type { Db } from "../../db/client.js";
import { decideRoutineOffer, findOwnedRoutineOffer } from "../../repo/routine-offers.js";
import { TABLE_GROUP_ERROR } from "../../repo/routines.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

export type RoutineOfferRouteDeps = { readonly db: Db; readonly push: PushHub };

const NOT_FOUND = { error: "没有这个对象" } as const;

/** 挂在 /api 下、登录中间件之后。例行不进 config，建了也不用重发。 */
export function createRoutineOfferRoutes(deps: RoutineOfferRouteDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.post("/messages/:id/routine-offer", async (c) => {
    const messageId = MessageId.safeParse(c.req.param("id"));
    if (!messageId.success) return c.json(NOT_FOUND, 404);
    const ownerId = c.get("user").id;
    const offer = await findOwnedRoutineOffer(deps.db, ownerId, messageId.data, { kind: "user" });
    if (offer === null) return c.json(NOT_FOUND, 404);
    const body = DecideRoutineOfferRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "请求体不合法" }, 400);

    const decided = await decideRoutineOffer(deps.db, ownerId, offer, body.data.decision);
    if (decided.kind === "already_decided") return c.json({ error: "这条卡已经有结论了" }, 409);
    if (decided.kind === "executor_gone") return c.json({ error: "执行这条例行的 Bot 已经不在了" }, 404);
    if (decided.kind === "executor_outside") return c.json({ error: "执行者不在那个项目群里" }, 400);
    if (decided.kind === "table_group") return c.json({ error: TABLE_GROUP_ERROR }, 400);

    deps.push.push(ownerId, { type: "message", message: decided.message });
    if (decided.routine !== null) deps.push.push(ownerId, { type: "routine_updated", routine: decided.routine });
    return c.json(DecideRoutineOfferResponse.parse({ message: decided.message, routine: decided.routine }));
  });

  return app;
}
