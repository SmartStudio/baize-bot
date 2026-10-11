import { PokerActRequest, StartHandRequest, type Message, type PokerTableView } from "@baize/shared";
import { Hono } from "hono";
import { apply } from "../../poker/engine.js";
import { converge, pushMessages, pushTable, type PokerDeps } from "../../poker/converge.js";
import {
  appendEvents,
  loadHand,
  loadTable,
  PokerError,
  snapshot,
  startHand,
  tableView,
  withTableLock,
} from "../../poker/store.js";
import type { Env } from "../app.js";

export type PokerHandRouteDeps = PokerDeps & { readonly seed?: () => string };

// 提交成功后只做尽力推进。事务内的视图作兜底，避免读库或推送失败把已落库动作报成 500。
async function afterCommit(
  deps: PokerDeps,
  groupId: string,
  handId: string,
  committed: { ownerId: string; messages: Message[]; view: PokerTableView },
): Promise<PokerTableView> {
  try {
    pushMessages(deps, committed.ownerId, committed.messages);
  } catch {
    console.error("牌桌提交后消息推送失败", handId, "message_push_failed");
  }
  try {
    await converge(deps, handId);
  } catch {
    console.error("牌桌提交后推进失败", handId, "converge_failed");
  }
  try {
    await pushTable(deps, groupId);
  } catch {
    console.error("牌桌提交后视图推送失败", handId, "table_push_failed");
  }
  try {
    return (await snapshot(deps.db, groupId)) ?? committed.view;
  } catch {
    console.error("牌桌提交后读取视图失败", handId, "snapshot_failed");
    return committed.view;
  }
}

export function createPokerHandRoutes(deps: PokerHandRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  app.post("/poker/tables/:groupId/hands", async (c) => {
    const request = StartHandRequest.safeParse(await c.req.json().catch(() => null));
    if (!request.success) return c.json({ error: "开手参数不对" }, 400);
    try {
      const result = await withTableLock(deps.db, c.req.param("groupId"), async (db, table) => {
        if (table.ownerId !== c.get("user").id) throw new PokerError(404, "没有这张牌桌");
        const started = await startHand(db, table, deps.seed?.());
        return {
          ...started,
          ownerId: table.ownerId,
          view: await tableView(db, (await loadTable(db, table.groupId))!, (await loadHand(db, started.handId))!),
        };
      });
      if (!result) return c.json({ error: "没有这张牌桌" }, 404);
      return c.json({ table: await afterCommit(deps, c.req.param("groupId"), result.handId, result) }, 201);
    } catch (error) {
      if (error instanceof PokerError) return c.json({ error: error.message }, error.status);
      // 数据库插入错误可能带整行（含种子），不能把原异常交给公共日志。
      console.error("牌桌开手失败");
      return c.json({ error: "服务端出错" }, 500);
    }
  });
  app.post("/poker/hands/:id/act", async (c) => {
    const initial = await loadHand(deps.db, c.req.param("id"));
    if (!initial) return c.json({ error: "没有这手牌" }, 404);
    const request = PokerActRequest.safeParse(await c.req.json().catch(() => null));
    if (!request.success) return c.json({ error: "出牌参数不对" }, 400);
    try {
      const result = await withTableLock(deps.db, initial.row.groupId, async (db, table) => {
        if (table.ownerId !== c.get("user").id) throw new PokerError(404, "没有这手牌");
        const hand = await loadHand(db, initial.row.id);
        if (
          !hand ||
          hand.row.status !== "playing" ||
          hand.state.phase.kind !== "betting" ||
          hand.state.phase.pending[0] !== "4"
        )
          throw new PokerError(409, "还没轮到你出牌");
        if (request.data.seq !== hand.state.events.length) throw new PokerError(409, "出牌序号已过期");
        let state;
        try {
          state = apply(hand.state, "4", request.data.action);
        } catch (error) {
          throw new PokerError(400, error instanceof Error ? error.message : "出牌无效");
        }
        const messages = await appendEvents(db, table, hand, state);
        return {
          ownerId: table.ownerId,
          messages,
          view: await tableView(db, (await loadTable(db, table.groupId))!, (await loadHand(db, hand.row.id))!),
        };
      });
      if (!result) return c.json({ error: "没有这手牌" }, 404);
      return c.json({ table: await afterCommit(deps, initial.row.groupId, initial.row.id, result) }, 200);
    } catch (error) {
      if (error instanceof PokerError) return c.json({ error: error.message }, error.status);
      console.error("牌桌出牌失败");
      return c.json({ error: "服务端出错" }, 500);
    }
  });
  return app;
}
