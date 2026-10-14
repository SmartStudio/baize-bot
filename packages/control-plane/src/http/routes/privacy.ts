import { DeleteAccountRequest } from "@baize/shared";
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import { deleteAccount, exportUserData } from "../../repo/export.js";
import { SESSION_COOKIE } from "../../repo/sessions.js";
import type { Env } from "../app.js";

export type PrivacyRouteDeps = {
  readonly db: Db;
  readonly agents: Pick<AgentHub, "disconnectOwner">;
};

/** 挂在 /api 下、登录中间件之后。导出和删账号都只碰登录的这个人。 */
export function createPrivacyRoutes(deps: PrivacyRouteDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/export", async (c) => {
    const now = new Date();
    const exported = await exportUserData(deps.db, c.get("user"), now);
    const filename = `baize-export-${now.toISOString().slice(0, 10)}.json`;
    c.header("content-disposition", `attachment; filename="${filename}"`);
    return c.json(exported);
  });

  app.delete("/me", async (c) => {
    const body = DeleteAccountRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "请输入邮箱确认" }, 400);
    const user = c.get("user");
    if (body.data.email !== user.email) return c.json({ error: "邮箱和当前账号不符" }, 400);
    const finalFrames = await deleteAccount(deps.db, user.id);
    // 库里的电脑行已经没了，代理再连会卡在握手；这里关掉的是删之前就连着的那几条。
    deps.agents.disconnectOwner(user.id, finalFrames);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  return app;
}
