import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

const NOT_IMPLEMENTED = { error: "未实现" } as const;

export type PokerReviewRouteDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AgentHub };

/**
 * 挂在 /api 下。散场看复盘，单元 10 实现。
 * POST /poker/tables/:groupId/leave   LeaveTableRequest → PokerTableResponse。手进行中回 409（D33），
 * 散场后给老白派一条 reviewer prompt，复盘回来走 poker_review 上行。
 */
export function createPokerReviewRoutes(deps: PokerReviewRouteDeps): Hono<Env> {
  void deps;
  const app = new Hono<Env>();
  app.post("/poker/tables/:groupId/leave", (c) => c.json(NOT_IMPLEMENTED, 501));
  return app;
}
