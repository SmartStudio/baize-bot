import {
  CreatePokerTableRequest,
  GroupId,
  PokerSeatNo,
  PokerTableResponse,
  SwapSeatRequest,
  type PokerTableView,
  type UserId,
} from "@baize/shared";
import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import { findGroup } from "../../repo/groups.js";
import { ensurePokerPresets } from "../../repo/poker-presets.js";
import { createPokerTable, listPokerTableIds, loadPokerTableView, swapPokerSeat } from "../../repo/poker-tables.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

const NOT_FOUND = { error: "没有这张桌" } as const;

export type PokerTableRouteDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AgentHub };

/**
 * 挂在 /api 下。建桌、看桌、换牌友。
 * POST /poker/tables                       CreatePokerTableRequest → PokerTableResponse，requestId 幂等，新建 201、重复 200
 * GET  /poker/tables                       { tables: PokerTableView[] }
 * GET  /poker/tables/:groupId              PokerTableResponse
 * POST /poker/tables/:groupId/seats/:seat  SwapSeatRequest → PokerTableResponse，手之间才能换，筹码跟座位走（D27）
 */
export function createPokerTableRoutes({ db, push, agents }: PokerTableRouteDeps): Hono<Env> {
  const app = new Hono<Env>();

  const pushTable = (ownerId: UserId, table: PokerTableView) =>
    push.push(ownerId, { type: "poker_table_updated", table });

  app.post("/poker/tables", async (c) => {
    const body = CreatePokerTableRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "请求体不合法" }, 400);
    const ownerId = c.get("user").id;

    // 牌友和老白要进 config 电脑代理才认得，新建了就发一次；已经有的不重发。
    const presets = await ensurePokerPresets(db, ownerId);
    if (presets.length > 0) await agents.sendConfig(ownerId);

    const created = await createPokerTable(db, ownerId, body.data.requestId);
    const table = await loadPokerTableView(db, ownerId, created.groupId);
    if (table === null) return c.json(NOT_FOUND, 404);
    if (created.opened !== null) {
      push.push(ownerId, { type: "group_created", group: created.opened.group, task: created.opened.task });
      pushTable(ownerId, table);
    }
    return c.json(PokerTableResponse.parse({ table }), created.opened === null ? 200 : 201);
  });

  app.get("/poker/tables", async (c) => {
    const ownerId = c.get("user").id;
    const tables: PokerTableView[] = [];
    for (const groupId of await listPokerTableIds(db, ownerId)) {
      const table = await loadPokerTableView(db, ownerId, groupId);
      if (table !== null) tables.push(table);
    }
    return c.json({ tables });
  });

  app.get("/poker/tables/:groupId", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("groupId"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const table = await loadPokerTableView(db, c.get("user").id, groupId.data);
    if (table === null) return c.json(NOT_FOUND, 404);
    return c.json(PokerTableResponse.parse({ table }));
  });

  app.post("/poker/tables/:groupId/seats/:seat", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("groupId"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const seat = PokerSeatNo.safeParse(Number(c.req.param("seat")));
    if (!seat.success) return c.json({ error: "座位号只有 1 到 4" }, 400);
    const body = SwapSeatRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "换人只能换成五位牌友之一，老白不入座" }, 400);
    const ownerId = c.get("user").id;

    const swapped = await swapPokerSeat(db, ownerId, groupId.data, seat.data, body.data.persona);
    switch (swapped.kind) {
      case "not_found":
        return c.json(NOT_FOUND, 404);
      case "not_a_bot_seat":
        return c.json({ error: "这个座位是你自己的，只能换牌友的座位" }, 400);
      case "in_hand":
        return c.json({ error: "这一手还没打完，打完再换人" }, 409);
      case "already_seated":
        return c.json({ error: "这位牌友已经在桌上了" }, 400);
      case "ok":
        break;
    }
    const table = await loadPokerTableView(db, ownerId, groupId.data);
    if (table === null) return c.json(NOT_FOUND, 404);
    const detail = await findGroup(db, ownerId, groupId.data);
    if (detail !== null) push.push(ownerId, { type: "group_updated", group: detail.group });
    pushTable(ownerId, table);
    return c.json(PokerTableResponse.parse({ table }));
  });

  return app;
}
