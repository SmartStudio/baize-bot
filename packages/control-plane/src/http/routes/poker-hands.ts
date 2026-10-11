import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

const NOT_IMPLEMENTED = { error: "未实现" } as const;

export type PokerHandRouteDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AgentHub };

/**
 * 挂在 /api 下。开一手和用户出牌，单元 7 实现。
 * POST /poker/tables/:groupId/hands   StartHandRequest → PokerTableResponse，桌上已有在打的手回 409
 * POST /poker/hands/:id/act           PokerActRequest → PokerTableResponse，seq 过期回 409，非法动作回 400 带引擎的中文原因
 */
export function createPokerHandRoutes(deps: PokerHandRouteDeps): Hono<Env> {
  void deps;
  const app = new Hono<Env>();
  app.post("/poker/tables/:groupId/hands", (c) => c.json(NOT_IMPLEMENTED, 501));
  app.post("/poker/hands/:id/act", (c) => c.json(NOT_IMPLEMENTED, 501));
  return app;
}
