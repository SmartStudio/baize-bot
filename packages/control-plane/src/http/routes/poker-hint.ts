import { HintRequest, PokerTableResponse } from "@baize/shared";
import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import { askHint } from "../../poker/hint.js";
import { PokerError } from "../../poker/store.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

export type PokerHintRouteDeps = { readonly db: Db; readonly push: PushHub; readonly agents: AgentHub };

/**
 * 挂在 /api 下。问老白，单元 9 实现。
 * POST /poker/hands/:id/hint   HintRequest → PokerTableResponse。每个决策点一次（D31）：撞 poker_hints 主键就回原来那条。
 */
export function createPokerHintRoutes(deps: PokerHintRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  app.post("/poker/hands/:id/hint", async (c) => {
    const body = HintRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "问牌参数不对" }, 400);
    try {
      const table = await askHint(deps, c.get("user").id, c.req.param("id"), body.data.seq);
      return c.json(PokerTableResponse.parse({ table }));
    } catch (error) {
      if (error instanceof PokerError) return c.json({ error: error.message }, error.status);
      console.error("问老白失败", "hint_failed");
      return c.json({ error: "服务端出错" }, 500);
    }
  });
  return app;
}
