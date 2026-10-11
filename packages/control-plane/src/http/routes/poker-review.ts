import { GroupId, LeaveTableRequest, PokerTableResponse } from "@baize/shared";
import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import { leaveTable, NO_SUCH_TABLE } from "../../poker/leave.js";
import { PokerError } from "../../poker/store.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

export type PokerReviewRouteDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AgentHub };

/**
 * 挂在 /api 下。散场看复盘（单元 10）。
 * POST /poker/tables/:groupId/leave   LeaveTableRequest → PokerTableResponse。手进行中回 409（D33），
 * 散场后给老白派一条 reviewer prompt，复盘回来走 poker_review 上行（agent/events/poker-review.ts）。
 */
export function createPokerReviewRoutes(deps: PokerReviewRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  app.post("/poker/tables/:groupId/leave", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("groupId"));
    if (!groupId.success) return c.json({ error: NO_SUCH_TABLE }, 404);
    if (!LeaveTableRequest.safeParse(await c.req.json().catch(() => undefined)).success)
      return c.json({ error: "散场不带参数" }, 400);
    try {
      const table = await leaveTable(deps, c.get("user").id, groupId.data);
      return c.json(PokerTableResponse.parse({ table }));
    } catch (error) {
      if (error instanceof PokerError) return c.json({ error: error.message }, error.status);
      // 数据库错误可能带整行（含种子），不把原异常交给公共日志。
      console.error("牌桌散场失败");
      return c.json({ error: "服务端出错" }, 500);
    }
  });
  return app;
}
