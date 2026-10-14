import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { hubAuth, type HubEnv } from "./hub-auth.js";
import { createAttachmentRoutes } from "./routes/attachments.js";

export const HUB_PATH = "/hub/v1";

export function createHub(deps: { readonly db: Db }): Hono<HubEnv> {
  const app = new Hono<HubEnv>();
  app.use("*", hubAuth(deps.db));
  // P3-10 的租约头校验接在认证之后、业务路由之前，身份从 ownerId 和 computerId 取。
  app.route("/", createAttachmentRoutes(deps));
  return app;
}
