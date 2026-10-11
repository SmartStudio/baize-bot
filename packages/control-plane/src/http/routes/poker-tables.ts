import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

const NOT_IMPLEMENTED = { error: "未实现" } as const;

export type PokerTableRouteDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AgentHub };

/**
 * 挂在 /api 下。建桌、看桌、换牌友，单元 8 实现。
 * POST /poker/tables            CreatePokerTableRequest → PokerTableResponse，requestId 幂等
 * GET  /poker/tables/:groupId   PokerTableResponse，手牌那截用 poker/store.ts#currentHandOf
 * POST /poker/tables/:groupId/seats/:seat   SwapSeatRequest → PokerTableResponse，筹码跟座位走（D27）
 */
export function createPokerTableRoutes(deps: PokerTableRouteDeps): Hono<Env> {
  void deps;
  const app = new Hono<Env>();
  app.post("/poker/tables", (c) => c.json(NOT_IMPLEMENTED, 501));
  app.get("/poker/tables/:groupId", (c) => c.json(NOT_IMPLEMENTED, 501));
  app.post("/poker/tables/:groupId/seats/:seat", (c) => c.json(NOT_IMPLEMENTED, 501));
  return app;
}
