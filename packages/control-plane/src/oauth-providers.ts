import { createHash, randomBytes } from "node:crypto";
import type { OAuthPlatform } from "@baize/shared";
import type { OAuthConfig } from "./env.js";

/** 授权、换令牌、刷新、「我是谁」和账号代理要的全部地址和客户端。 */
export type OAuthEndpoints = OAuthConfig & { readonly githubApiBaseUrl: string; readonly xApiBaseUrl: string };

export type TokenGrant = {
  readonly accessToken: string;
  /** null 是平台没给刷新令牌（GitHub App 关了令牌过期），访问令牌也就不过期。 */
  readonly refreshToken: string | null;
  readonly accessExpiresAt: Date | null;
  readonly refreshExpiresAt: Date | null;
  readonly scope: string;
};

/**
 * rejected 是平台明确不认这个授权码或刷新令牌；连不上、5xx、限流这类抛异常，不算不认。
 * 刷新的 rejected 会让调用方清掉刷新令牌，所以只认能证明刷新令牌失效的错误码，见 refreshRefused。
 */
export type TokenOutcome = { readonly kind: "granted"; readonly grant: TokenGrant } | { readonly kind: "rejected" };

export type TokenRequest =
  | { readonly grant: "code"; readonly code: string; readonly verifier: string; readonly redirectUri: string }
  | { readonly grant: "refresh"; readonly refreshToken: string };

type Client = { readonly clientId: string; readonly clientSecret: string | null };

type Provider = {
  readonly notConfigured: string;
  client(endpoints: OAuthEndpoints): Client | null;
  authorizeUrl(endpoints: OAuthEndpoints): string;
  /** 授权页上额外的参数。 */
  readonly authorizeParams: Record<string, string>;
  tokenUrl(endpoints: OAuthEndpoints): string;
  apiBaseUrl(endpoints: OAuthEndpoints): string;
  readonly apiHeaders: Record<string, string>;
  readonly whoamiPath: string;
  handleOf(json: unknown): string | null;
};

const GITHUB_API_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "baize-bot",
  "x-github-api-version": "2022-11-28",
};

const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined,
    value,
  );

const PROVIDERS: Record<OAuthPlatform, Provider> = {
  github: {
    notConfigured: "管理员还没配 GitHub 应用，连不了 GitHub",
    client: (endpoints) => endpoints.github,
    authorizeUrl: (endpoints) => `${endpoints.githubOauthBaseUrl}/login/oauth/authorize`,
    // GitHub App 的权限在应用上定，授权页不带 scope。
    authorizeParams: {},
    tokenUrl: (endpoints) => `${endpoints.githubOauthBaseUrl}/login/oauth/access_token`,
    apiBaseUrl: (endpoints) => endpoints.githubApiBaseUrl,
    apiHeaders: GITHUB_API_HEADERS,
    whoamiPath: "/user",
    handleOf: (json) => {
      const login = at(json, "login");
      return typeof login === "string" && login !== "" ? login : null;
    },
  },
  x: {
    notConfigured: "管理员还没配 X 应用，连不了 X",
    client: (endpoints) => endpoints.x,
    authorizeUrl: (endpoints) => `${endpoints.xOauthBaseUrl}/i/oauth2/authorize`,
    // offline.access 才给刷新令牌。
    authorizeParams: { scope: "tweet.read users.read tweet.write offline.access" },
    tokenUrl: (endpoints) => `${endpoints.xApiBaseUrl}/2/oauth2/token`,
    apiBaseUrl: (endpoints) => endpoints.xApiBaseUrl,
    apiHeaders: { "user-agent": "baize-bot" },
    whoamiPath: "/2/users/me",
    handleOf: (json) => {
      const username = at(json, "data", "username");
      return typeof username === "string" && username !== "" ? username : null;
    },
  },
};

const TIMEOUT_MS = 30_000;
/**
 * 令牌端点单独短一些：刷新时控制面拿着这个账号的凭据行锁和一条数据库连接等它，
 * 等久了同账号的请求全在后面排着。令牌端点只回一小段 JSON，10 秒还没回就当这次连不上。
 */
const TOKEN_TIMEOUT_MS = 10_000;
/**
 * 两家发的访问令牌只有字母数字和少量标点。反斜杠、百分号、控制字符和非 ASCII 都不收：账号代理替换回显令牌时，
 * 一串连续的反斜杠或百分号会让匹配正则灾难性回溯，Latin-1 字符在线路上是单字节、匹配器只认 UTF-8 写法。
 */
const UNSAFE_TOKEN_CHAR = /[\\%]|[^\x20-\x7e]/;

export function notConfigured(platform: OAuthPlatform, endpoints: OAuthEndpoints): string | null {
  const provider = PROVIDERS[platform];
  return provider.client(endpoints) === null ? provider.notConfigured : null;
}

export function apiBaseUrl(platform: OAuthPlatform, endpoints: OAuthEndpoints): string {
  return PROVIDERS[platform].apiBaseUrl(endpoints);
}

export function apiHeaders(platform: OAuthPlatform): Record<string, string> {
  return PROVIDERS[platform].apiHeaders;
}

export type Pkce = { readonly state: string; readonly verifier: string };

export function newPkce(): Pkce {
  return { state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url") };
}

export function authorizeUrl(
  platform: OAuthPlatform,
  endpoints: OAuthEndpoints,
  pkce: Pkce,
  redirectUri: string,
): string {
  const provider = PROVIDERS[platform];
  const client = provider.client(endpoints);
  if (client === null) throw new Error(provider.notConfigured);
  const url = new URL(provider.authorizeUrl(endpoints));
  const params: Record<string, string> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    state: pkce.state,
    code_challenge: createHash("sha256").update(pkce.verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...provider.authorizeParams,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

/**
 * 换令牌和刷新走同一个端点。有 secret 的走机密客户端：GitHub 放表单里，X 用 Basic；X 没 secret 就是公共客户端，
 * client_id 放表单里，只靠 PKCE。
 */
export async function requestToken(
  platform: OAuthPlatform,
  endpoints: OAuthEndpoints,
  request: TokenRequest,
  now: Date,
): Promise<TokenOutcome> {
  const provider = PROVIDERS[platform];
  const client = provider.client(endpoints);
  if (client === null) throw new Error(provider.notConfigured);
  const form = new URLSearchParams(
    request.grant === "code"
      ? {
          grant_type: "authorization_code",
          code: request.code,
          redirect_uri: request.redirectUri,
          code_verifier: request.verifier,
        }
      : { grant_type: "refresh_token", refresh_token: request.refreshToken },
  );
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (platform === "x" && client.clientSecret !== null) {
    headers["authorization"] = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.clientSecret !== null) form.set("client_secret", client.clientSecret);
  }

  const response = await fetch(provider.tokenUrl(endpoints), {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const json: unknown = await response.json().catch(() => null);
  const error = at(json, "error");
  // GitHub 不认授权码或刷新令牌时回 200，错误写在 error 里。
  if (!response.ok || typeof error === "string") {
    const code = typeof error === "string" ? error : null;
    if (request.grant === "code") return codeRefused(response.status, code);
    const description = at(json, "error_description");
    return refreshRefused(platform, {
      status: response.status,
      code,
      description: typeof description === "string" ? description : null,
    });
  }
  const accessToken = at(json, "access_token");
  if (typeof accessToken !== "string" || accessToken === "") throw new Error("令牌端点的回应里没有 access_token");
  if (UNSAFE_TOKEN_CHAR.test(accessToken)) {
    throw new Error("令牌端点发来的访问令牌含反斜杠、百分号、控制字符或非 ASCII 字符，不收");
  }
  const refreshToken = at(json, "refresh_token");
  const scope = at(json, "scope");
  return {
    kind: "granted",
    grant: {
      accessToken,
      refreshToken: typeof refreshToken === "string" && refreshToken !== "" ? refreshToken : null,
      accessExpiresAt: after(now, at(json, "expires_in")),
      refreshExpiresAt: after(now, at(json, "refresh_token_expires_in")),
      scope: typeof scope === "string" ? scope : "",
    },
  };
}

/** 授权码换不到令牌：用户回账号页再点一次就是新的授权码，不必细分是哪一种不认。 */
function codeRefused(status: number, code: string | null): TokenOutcome {
  if (status === 400 || status === 401 || (status < 300 && code !== null)) return { kind: "rejected" };
  throw new Error(`令牌端点回 ${status}`);
}

type RefreshRefusal = { readonly status: number; readonly code: string | null; readonly description: string | null };

const X_DEAD_TOKEN_DESCRIPTION = "Value passed for the token was invalid";

/**
 * 哪些回应能证明刷新令牌本身死了。判成死了会清掉刷新令牌、账号记过期，用户只能重新授权，所以宁窄勿宽。
 *
 * GitHub：bad_refresh_token，见 GitHub App「刷新用户访问令牌」一文。GitHub 不认时回 200，错误写在正文里。
 * X，都要求 HTTP 400：
 * - invalid_grant。RFC 6749 §5.2 定义它覆盖刷新令牌无效、过期、被撤销或不属于这个客户端。
 * - invalid_request，且 error_description 含「Value passed for the token was invalid」。RFC 6749 §5.2 里
 *   invalid_request 是通用的请求格式错误，单凭错误码证明不了令牌死了；X 官方 TypeScript SDK 的 issue #54
 *   （xdevplatform/twitter-api-typescript-sdk#54）记着 X 对无效刷新令牌实际回的是 400、这个错误码加这句描述。
 * invalid_client、unauthorized_client 这类是应用配置错了，清掉刷新令牌的话管理员修好配置，用户也只能重新授权。
 */
const DEAD_REFRESH_TOKEN: Record<OAuthPlatform, (refusal: RefreshRefusal) => boolean> = {
  github: ({ code }) => code === "bad_refresh_token",
  x: ({ status, code, description }) =>
    status === 400 &&
    (code === "invalid_grant" ||
      (code === "invalid_request" && description?.includes(X_DEAD_TOKEN_DESCRIPTION) === true)),
};

/**
 * 不能证明刷新令牌死了的一律当运维错误：抛出去，密文和账号状态都不动，下一次请求再刷。
 * 5xx 是平台自己出了事，错误体里写什么都不作数。
 */
function refreshRefused(platform: OAuthPlatform, refusal: RefreshRefusal): TokenOutcome {
  if (refusal.status < 500 && DEAD_REFRESH_TOKEN[platform](refusal)) return { kind: "rejected" };
  const what = `令牌端点回 ${refusal.status}，错误码 ${refusal.code ?? "无"}`;
  console.error(`${platform} 刷新令牌没换到，${what}`);
  throw new Error(`${platform} ${what}`);
}

function after(now: Date, seconds: unknown): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(now.getTime() + seconds * 1000) : null;
}

/** 授权回来的那个号叫什么，拿平台自己的「我是谁」问，不信回调里带的任何东西。 */
export async function whoami(platform: OAuthPlatform, endpoints: OAuthEndpoints, accessToken: string): Promise<string> {
  const provider = PROVIDERS[platform];
  const response = await fetch(`${provider.apiBaseUrl(endpoints)}${provider.whoamiPath}`, {
    headers: { ...provider.apiHeaders, authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`「我是谁」回 ${response.status}`);
  const handle = provider.handleOf(await response.json().catch(() => null));
  if (handle === null) throw new Error("「我是谁」的回应里没有账号名");
  return handle;
}
