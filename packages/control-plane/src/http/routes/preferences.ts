import { Hono } from "hono";
import type { Env } from "../app.js";

const NOT_IMPLEMENTED = { error: "未实现" } as const;

/** 第 2 期形状占位，挂在 /api 下，p2-pref-cp 把 501 换成真实现。 */
export function createPreferenceRoutes(): Hono<Env> {
  const app = new Hono<Env>();
  app.get("/bots/:id/preferences", (c) => c.json(NOT_IMPLEMENTED, 501));
  app.patch("/preferences/:id", (c) => c.json(NOT_IMPLEMENTED, 501));
  app.delete("/preferences/:id", (c) => c.json(NOT_IMPLEMENTED, 501));
  app.get("/bots/:id/profile", (c) => c.json(NOT_IMPLEMENTED, 501));
  return app;
}
