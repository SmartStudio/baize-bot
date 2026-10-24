import { OAuthPlatform, type Account, type OAuthResult, type User } from "@baize/shared";
import { Hono, type Context } from "hono";
import { log } from "../log.js";
import type { AgentHub } from "../agent/hub.js";
import { saveGrant, type CredentialCrypto } from "../credentials.js";
import type { Db } from "../db/client.js";
import { authorizeUrl, newPkce, notConfigured, requestToken, whoami, type OAuthEndpoints } from "../oauth-providers.js";
import { withAccountLock } from "../repo/account-lock.js";
import { connectOAuthAccount } from "../repo/accounts.js";
import { consumeOAuthState, createOAuthState } from "../repo/oauth-states.js";
import type { PushHub } from "../ws/hub.js";

export const OAUTH_PATH = "/api/oauth";

export type OAuthRouteDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly agents: Pick<AgentHub, "sendConfig">;
  readonly crypto: CredentialCrypto;
  readonly endpoints: OAuthEndpoints;
  /** 浏览器打开 Web 的地址。回调地址和授权完跳回的页面都拼在它上面，监听端口起来之后才定，所以现取。 */
  readonly webBaseUrl: () => string;
};

type Env = { Variables: { user: User } };

/**
 * 账号页「连 GitHub」「连 X」。两条都挂在 /api 下、要登录：回调还得是发起的那个人，
 * 不然别人发起的授权落到这个人的会话上，会把别人的平台号挂到他名下。
 */
export function createOAuthRoutes(deps: OAuthRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  // 配的地址末尾带 / 也拼不出 //：回调要和平台后台登记的一字不差。
  const web = () => deps.webBaseUrl().replace(/\/+$/, "");
  const redirectUri = (platform: OAuthPlatform) => `${web()}${OAUTH_PATH}/${platform}/callback`;
  const land = (c: Context<Env>, platform: OAuthPlatform, result: OAuthResult) =>
    c.redirect(`${web()}/?${new URLSearchParams({ oauth: platform, result }).toString()}`, 302);

  app.get("/:platform/start", async (c) => {
    const platform = OAuthPlatform.safeParse(c.req.param("platform"));
    if (!platform.success) return c.json({ error: "这个平台不走授权登录" }, 404);
    const missing = notConfigured(platform.data, deps.endpoints);
    if (missing !== null) return c.json({ error: missing }, 503);
    const pkce = newPkce();
    await createOAuthState(deps.db, {
      state: pkce.state,
      ownerId: c.get("user").id,
      platform: platform.data,
      verifier: pkce.verifier,
    });
    return c.redirect(authorizeUrl(platform.data, deps.endpoints, pkce, redirectUri(platform.data)), 302);
  });

  app.get("/:platform/callback", async (c) => {
    const parsed = OAuthPlatform.safeParse(c.req.param("platform"));
    if (!parsed.success) return c.json({ error: "这个平台不走授权登录" }, 404);
    const platform = parsed.data;
    const ownerId = c.get("user").id;
    const state = c.req.query("state");
    // 先取走 state 再看结果：用户在授权页点了拒绝，这个 state 也就作废了。
    const pending = state === undefined ? null : await consumeOAuthState(deps.db, { state, ownerId, platform });
    if (pending === null) return land(c, platform, "invalid_state");
    const code = c.req.query("code");
    if (c.req.query("error") !== undefined || code === undefined) return land(c, platform, "denied");

    let account: Account;
    try {
      const outcome = await requestToken(
        platform,
        deps.endpoints,
        { grant: "code", code, verifier: pending.verifier, redirectUri: redirectUri(platform) },
        new Date(),
      );
      if (outcome.kind === "rejected") return land(c, platform, "failed");
      const handle = await whoami(platform, deps.endpoints, outcome.grant.accessToken);
      account = await deps.db.transaction(async (tx) => {
        const connected = await connectOAuthAccount(tx, { ownerId, platform, handle });
        const saved = await withAccountLock(tx, connected.id, (lock) => saveGrant(lock, deps.crypto, outcome.grant));
        return saved.restored ?? connected;
      });
    } catch (error) {
      log.error("连账号出错", { platform, userId: ownerId, err: error });
      return land(c, platform, "failed");
    }
    // 凭据已经提交，账号就是连上了。之后的推送和 config 只是通知，出错只记日志，不改页面上的结论。
    deps.push.push(ownerId, { type: "account_updated", account });
    try {
      await deps.agents.sendConfig(ownerId);
    } catch (error) {
      log.error("账号已连上，重发 config 出错", { platform, userId: ownerId, err: error });
    }
    return land(c, platform, "connected");
  });

  return app;
}
