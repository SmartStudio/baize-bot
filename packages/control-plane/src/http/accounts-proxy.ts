import { AccountId, OAuthPlatform } from "@baize/shared";
import { Hono } from "hono";
import { expireLogin } from "../account-expiry.js";
import type { AccessToken, AccountTokens } from "../credentials.js";
import { apiBaseUrl, apiHeaders, type OAuthEndpoints } from "../oauth-providers.js";
import type { SettleDeps } from "../publish/settle.js";
import { findAccount } from "../repo/accounts.js";
import { findComputerByGatewayKey } from "../repo/computers.js";
import { bearerToken } from "./gateway.js";

export const ACCOUNTS_PROXY_PATH = "/accounts-proxy";

export type AccountsProxyDeps = SettleDeps & { readonly tokens: AccountTokens; readonly endpoints: OAuthEndpoints };

// 和网关一样用白名单：平台的 set-cookie、会话标识这类头不该漏给电脑。
const FORWARDED_HEADERS = new Set(["content-type", "etag", "last-modified", "link", "cache-control"]);
const TIMEOUT_MS = 30_000;
const NO_ACCOUNT = { error: "没有这个账号" } as const;
const LOGIN_EXPIRED = { error: "这个账号登录过期了，到账号页重新连一下" } as const;

/**
 * Bot 读 GitHub、X 走这里：电脑拿网关 key 认身份，控制面换上平台令牌转出去。令牌只在控制面解密，
 * 电脑上跑的是 Bot 写的命令，令牌落到那边就等于交给了模型。只放读，写一律走草稿和审批。
 */
export function createAccountsProxy(deps: AccountsProxyDeps): Hono {
  const app = new Hono();

  app.all("/:accountId/*", async (c) => {
    const key = bearerToken(c.req.header("authorization"));
    const computer = key === null ? null : await findComputerByGatewayKey(deps.db, key);
    if (computer === null) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
    if (c.req.method !== "GET") return c.json({ error: "代理只读，发东西走草稿" }, 405);

    const accountId = AccountId.safeParse(c.req.param("accountId"));
    const account = accountId.success ? await findAccount(deps.db, computer.ownerId, accountId.data) : null;
    const platform = OAuthPlatform.safeParse(account?.platform);
    if (account === null || !platform.success) return c.json(NO_ACCOUNT, 404);
    if (account.login !== "valid") return c.json(LOGIN_EXPIRED, 409);

    // 拼完再核对 origin 和根路径前缀，Bot 用 .. 跳不出平台根地址。路径用原样的，%2F 留在一段里原样交给平台。
    const url = new URL(c.req.url);
    const rest = url.pathname.slice(`${ACCOUNTS_PROXY_PATH}/${c.req.param("accountId")}`.length);
    const base = new URL(apiBaseUrl(platform.data, deps.endpoints));
    const root = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    const target = new URL(`${base.origin}${root}${rest.replace(/^\//, "")}${url.search}`);
    if (target.origin !== base.origin || !target.pathname.startsWith(root)) {
      return c.json({ error: "路径不对" }, 400);
    }
    const accept = c.req.header("accept");

    let rejected: string | null = null;
    for (;;) {
      let token: AccessToken;
      try {
        token = await deps.tokens.accessToken(account.id, rejected);
      } catch (error) {
        console.error(`账号 ${account.id} 取令牌出错`, error);
        return c.json({ error: "连不上平台换令牌，稍后再试" }, 502);
      }
      if (token.kind === "login_expired") {
        await expireLogin(deps, computer.ownerId, account.id, { generation: token.generation });
        return c.json(LOGIN_EXPIRED, 409);
      }

      const headers: Record<string, string> = { ...apiHeaders(platform.data), authorization: `Bearer ${token.token}` };
      if (accept !== undefined) headers["accept"] = accept;
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          headers,
          signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
      } catch (error) {
        if (c.req.raw.signal.aborted) throw error;
        return c.json({ error: `连不上平台，${String(error)}` }, 502);
      }

      // 401 是平台不认这个令牌：强制刷新一次再试，还不认才记过期。403 多半是这个号没权限读那个资源，原样交给 Bot。
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        if (rejected !== null) {
          await expireLogin(deps, computer.ownerId, account.id, { generation: token.generation });
          return c.json(LOGIN_EXPIRED, 409);
        }
        rejected = token.token;
        continue;
      }
      return forward(upstream);
    }
  });

  return app;
}

function forward(upstream: Response): Response {
  const forwarded = new Headers();
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (FORWARDED_HEADERS.has(lower) || lower.startsWith("x-ratelimit-")) forwarded.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: forwarded });
}
