import { Hono } from "hono";
import type { Env } from "../app.js";

const NOT_IMPLEMENTED = { error: "未实现" } as const;

/** 第 2 期形状占位，挂在 /api 下，p2-brand-cp 把 501 换成真实现。 */
export function createBrandRoutes(): Hono<Env> {
  const app = new Hono<Env>();
  app.get("/brand", (c) => c.json(NOT_IMPLEMENTED, 501));
  app.put("/brand", (c) => c.json(NOT_IMPLEMENTED, 501));
  return app;
}
