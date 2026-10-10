import { BrandResponse, UpdateBrandRequest, type BrandBook, type UserId } from "@baize/shared";
import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import { getBrand, replaceBrand } from "../../repo/brand.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

export type BrandRouteDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: Pick<AgentHub, "sendConfig">;
};

/** 手册变了：先推页面，再给电脑重发 config。PUT 和草稿批准两条路都走这里。 */
export async function announceBrand(deps: BrandRouteDeps, ownerId: UserId, brand: BrandBook): Promise<void> {
  deps.push.push(ownerId, { type: "brand_updated", brand });
  await deps.agents.sendConfig(ownerId);
}

/** 挂在 /api 下、登录中间件之后。一个用户一本，只按登录的人读写，碰不到别人的。 */
export function createBrandRoutes(deps: BrandRouteDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/brand", async (c) => {
    return c.json(BrandResponse.parse({ brand: await getBrand(deps.db, c.get("user").id) }));
  });

  app.put("/brand", async (c) => {
    const body = UpdateBrandRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "请求体不合法" }, 400);
    const ownerId = c.get("user").id;
    const written = await replaceBrand(deps.db, ownerId, body.data);
    if (written.kind === "invalid") return c.json({ error: written.error }, 400);
    if (written.kind === "stale") return c.json({ error: "手册刚被更新过，请刷新后再改" }, 409);
    await announceBrand(deps, ownerId, written.brand);
    return c.json(BrandResponse.parse({ brand: written.brand }));
  });

  return app;
}
