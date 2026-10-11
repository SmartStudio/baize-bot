import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

const NOT_IMPLEMENTED = { error: "未实现" } as const;

export type PokerHintRouteDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AgentHub };

/**
 * 挂在 /api 下。问老白，单元 9 实现。
 * POST /poker/hands/:id/hint   HintRequest → PokerTableResponse。每个决策点一次（D31）：撞 poker_hints 主键就回原来那条。
 */
export function createPokerHintRoutes(deps: PokerHintRouteDeps): Hono<Env> {
  void deps;
  const app = new Hono<Env>();
  app.post("/poker/hands/:id/hint", (c) => c.json(NOT_IMPLEMENTED, 501));
  return app;
}
