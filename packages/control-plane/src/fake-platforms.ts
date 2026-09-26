import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// 假 GitHub 和假 X。控制面测试、e2e 和实机验证都把平台根地址指到这里，真仓库和真令牌一律不用。
// 只认发布器、授权、令牌刷新、「我是谁」和账号代理会打的那几条路径，别的回 404，多打一条没见过的请求会在断言里露出来。

export type FakePlatformRequest = {
  readonly platform: "github" | "x";
  readonly method: string;
  /** 带查询串。 */
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
};

export type FakePlatforms = {
  /** 交给 GITHUB_API_BASE_URL。 */
  readonly githubBaseUrl: string;
  /** 交给 X_API_BASE_URL。X 的令牌端点也在这下面。 */
  readonly xBaseUrl: string;
  /** 交给 GITHUB_OAUTH_BASE_URL：授权页和令牌端点。 */
  readonly githubOauthBaseUrl: string;
  /** 交给 X_OAUTH_BASE_URL：授权页。 */
  readonly xOauthBaseUrl: string;
  /** 「我是谁」回的名字。 */
  readonly handles: { readonly github: string; readonly x: string };
  /** 到达的请求，按到达顺序。授权页是浏览器打的，不记。 */
  requests(): readonly FakePlatformRequest[];
  /**
   * 接下来的一条请求回这个状态码，不落地。给了 match 就只算对得上的那条。
   * body 是字符串就原样当纯文本回，给对象就回 JSON，不给回一段通用的 JSON。
   */
  failNext(status: number, match?: RequestMatch, body?: unknown): void;
  /** 从现在起到达的请求先挂着，调返回的函数才放行。给了 match 就只挂对得上的。 */
  hold(match?: RequestMatch): () => void;
  /** 之后发出的访问令牌多少秒过期。 */
  setTokenLifetime(seconds: number): void;
  /** 用户在平台上撤了授权：已发出的刷新令牌全部作废，再拿来刷新会被拒。 */
  revoke(): void;
  close(): Promise<void>;
};

export type RequestMatch = (request: FakePlatformRequest) => boolean;

const everything: RequestMatch = () => true;

const HANDLES = { github: "baize-dev", x: "baize_x" } as const;
const DEFAULT_LIFETIME = { github: 8 * 3600, x: 2 * 3600 } as const;
const GITHUB_REFRESH_LIFETIME = 180 * 24 * 3600;

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        if (raw === "") resolve(null);
        else if ((req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
          resolve(Object.fromEntries(new URLSearchParams(raw)));
        } else resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

type Grant = { readonly redirectUri: string; readonly challenge: string | null };

export async function startFakePlatforms(): Promise<FakePlatforms> {
  const requests: FakePlatformRequest[] = [];
  const failures: { readonly status: number; readonly match: RequestMatch; readonly body: unknown }[] = [];
  let gate: { readonly opened: Promise<void>; readonly match: RequestMatch } | null = null;
  let counter = 100;
  let tokenCounter = 0;
  let lifetime: number | null = null;
  // 建 discussion 的那条 mutation 只带仓库的节点 id，仓库名记在前一条查仓库的请求上。
  let discussionRepo = "o/r";
  const codes = new Map<string, Grant & { readonly platform: "github" | "x" }>();
  // 两家的刷新令牌都只能用一次，用过就从这里删掉。
  const refreshTokens = new Map<string, "github" | "x">();
  const accessTokens = new Map<string, "github" | "x">();

  const issueTokens = (platform: "github" | "x"): Record<string, unknown> => {
    tokenCounter += 1;
    const access = `${platform}_access_${tokenCounter}`;
    const refresh = `${platform}_refresh_${tokenCounter}`;
    accessTokens.set(access, platform);
    refreshTokens.set(refresh, platform);
    const expiresIn = lifetime ?? DEFAULT_LIFETIME[platform];
    return platform === "github"
      ? {
          access_token: access,
          expires_in: expiresIn,
          refresh_token: refresh,
          refresh_token_expires_in: GITHUB_REFRESH_LIFETIME,
          scope: "",
          token_type: "bearer",
        }
      : {
          access_token: access,
          expires_in: expiresIn,
          refresh_token: refresh,
          scope: "tweet.read users.read tweet.write offline.access",
          token_type: "bearer",
        };
  };

  /** 授权码或刷新令牌不认，照两家的实际回法：GitHub 回 200 带 error，X 回 400 invalid_request 带固定描述。 */
  const refuse = (platform: "github" | "x", res: ServerResponse): void => {
    if (platform === "github") reply(res, 200, { error: "bad_refresh_token", error_description: "fake" });
    else reply(res, 400, { error: "invalid_request", error_description: "Value passed for the token was invalid." });
  };

  const token = (platform: "github" | "x", body: unknown, res: ServerResponse): void => {
    const grantType = field(body, "grant_type") ?? "authorization_code";
    if (grantType === "refresh_token") {
      const refresh = String(field(body, "refresh_token") ?? "");
      if (refreshTokens.get(refresh) !== platform) {
        refuse(platform, res);
        return;
      }
      refreshTokens.delete(refresh);
      reply(res, 200, issueTokens(platform));
      return;
    }
    const code = String(field(body, "code") ?? "");
    const grant = codes.get(code);
    codes.delete(code);
    const verifier = field(body, "code_verifier");
    if (
      grant === undefined ||
      grant.platform !== platform ||
      grant.redirectUri !== field(body, "redirect_uri") ||
      (grant.challenge !== null && (typeof verifier !== "string" || s256(verifier) !== grant.challenge))
    ) {
      refuse(platform, res);
      return;
    }
    reply(res, 200, issueTokens(platform));
  };

  /** 浏览器打开授权页，假装用户点了同意，直接带授权码跳回去。 */
  const authorize = (platform: "github" | "x", url: URL, res: ServerResponse): void => {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (redirectUri === null || state === null) {
      reply(res, 400, { error: "缺 redirect_uri 或 state" });
      return;
    }
    tokenCounter += 1;
    const code = `${platform}_code_${tokenCounter}`;
    const challenge = url.searchParams.get("code_challenge");
    codes.set(code, { platform, redirectUri, challenge });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    res.writeHead(302, { location: back.href });
    res.end();
  };

  const bearerPlatform = (authorization: string | null): "github" | "x" | undefined =>
    accessTokens.get(authorization?.replace(/^Bearer /, "") ?? "");

  // 读接口回包里故意带 set-cookie，账号代理要把它挡掉。
  const READ_HEADERS = { "set-cookie": "fake_session=1; Path=/", "x-ratelimit-remaining": "4999" };

  const githubGet = (path: string, authorization: string | null, res: ServerResponse): void => {
    if (path === "/user") {
      if (bearerPlatform(authorization) !== "github") reply(res, 401, { message: "Bad credentials" });
      else reply(res, 200, { login: HANDLES.github, id: 1 }, READ_HEADERS);
      return;
    }
    const issues = /^\/repos\/([^/]+)\/([^/]+)\/issues(?:\?.*)?$/.exec(path);
    if (issues !== null) {
      reply(
        res,
        200,
        [{ number: 7, title: "假 issue", html_url: `https://github.com/${issues[1]}/${issues[2]}/issues/7` }],
        {
          ...READ_HEADERS,
        },
      );
      return;
    }
    reply(res, 404, { message: "Not Found" });
  };

  const xGet = (path: string, authorization: string | null, res: ServerResponse): void => {
    if (path === "/2/users/me") {
      if (bearerPlatform(authorization) !== "x") reply(res, 401, { title: "Unauthorized" });
      else reply(res, 200, { data: { id: "42", name: "白泽", username: HANDLES.x } }, READ_HEADERS);
      return;
    }
    if (path.startsWith("/2/tweets/search/recent")) {
      reply(res, 200, { data: [{ id: "1801", text: "假推文" }], meta: { result_count: 1 } }, READ_HEADERS);
      return;
    }
    reply(res, 404, { title: "Not Found" });
  };

  const github = (path: string, body: unknown, res: ServerResponse): void => {
    const issue = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path);
    if (issue !== null) {
      counter += 1;
      reply(res, 201, {
        id: counter * 1000,
        number: counter,
        html_url: `https://github.com/${issue[1]}/${issue[2]}/issues/${counter}`,
      });
      return;
    }
    const comment = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (comment !== null) {
      counter += 1;
      reply(res, 201, {
        id: counter * 1000,
        html_url: `https://github.com/${comment[1]}/${comment[2]}/issues/${comment[3]}#issuecomment-${counter * 1000}`,
      });
      return;
    }
    if (path === "/graphql") {
      const query = String(field(body, "query") ?? "");
      const variables = field(body, "variables");
      if (query.includes("createDiscussion")) {
        counter += 1;
        const repo = discussionRepo;
        reply(res, 200, {
          data: {
            createDiscussion: {
              discussion: { id: `D_${counter}`, url: `https://github.com/${repo}/discussions/${counter}` },
            },
          },
        });
        return;
      }
      discussionRepo = `${String(field(variables, "owner") ?? "o")}/${String(field(variables, "name") ?? "r")}`;
      reply(res, 200, {
        data: {
          repository: {
            id: "R_fake",
            discussionCategories: {
              nodes: [
                { id: "DIC_announce", name: "Announcements" },
                { id: "DIC_general", name: "General" },
              ],
            },
          },
        },
      });
      return;
    }
    reply(res, 404, { message: "Not Found" });
  };

  const x = (path: string, body: unknown, res: ServerResponse): void => {
    if (path === "/2/tweets") {
      counter += 1;
      reply(res, 201, { data: { id: `18${counter}`, text: String(field(body, "text") ?? "") } });
      return;
    }
    if (path === "/2/oauth2/token") {
      token("x", body, res);
      return;
    }
    reply(res, 404, { title: "Not Found" });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://fake");
    const [, prefix, ...rest] = url.pathname.split("/");
    const tail = `/${rest.join("/")}`;
    if (req.method === "GET" && prefix === "github-oauth" && tail === "/login/oauth/authorize") {
      authorize("github", url, res);
      return;
    }
    if (req.method === "GET" && prefix === "x-oauth" && tail === "/i/oauth2/authorize") {
      authorize("x", url, res);
      return;
    }
    const platform = prefix === "github" || prefix === "github-oauth" ? "github" : prefix === "x" ? "x" : null;
    if (platform === null || (req.method !== "POST" && req.method !== "GET")) {
      reply(res, 404, {});
      return;
    }
    const path = `${tail}${url.search}`;
    const body = await readBody(req);
    const authorization = req.headers.authorization ?? null;
    const request = { platform, method: req.method, path, authorization, body } as const;
    requests.push(request);
    if (gate?.match(request) === true) await gate.opened;
    const index = failures.findIndex((one) => one.match(request));
    const failure = index === -1 ? undefined : failures.splice(index, 1)[0];
    if (failure !== undefined) {
      if (typeof failure.body === "string") {
        res.writeHead(failure.status, { "content-type": "text/plain" });
        res.end(failure.body);
      } else reply(res, failure.status, failure.body ?? { message: `fake ${failure.status}` });
      return;
    }
    if (prefix === "github-oauth") {
      if (req.method === "POST" && tail === "/login/oauth/access_token") token("github", body, res);
      else reply(res, 404, {});
    } else if (req.method === "GET") {
      if (platform === "github") githubGet(path, authorization, res);
      else xGet(path, authorization, res);
    } else if (platform === "github") github(path, body, res);
    else x(path, body, res);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    githubBaseUrl: `${origin}/github`,
    xBaseUrl: `${origin}/x`,
    githubOauthBaseUrl: `${origin}/github-oauth`,
    xOauthBaseUrl: `${origin}/x-oauth`,
    handles: HANDLES,
    requests: () => requests,
    failNext: (status, match = everything, body) => {
      failures.push({ status, match, body });
    },
    hold: (match = everything) => {
      let resolve: (() => void) | undefined;
      gate = {
        opened: new Promise<void>((done) => {
          resolve = done;
        }),
        match,
      };
      return () => {
        gate = null;
        resolve?.();
      };
    },
    setTokenLifetime: (seconds) => {
      lifetime = seconds;
    },
    revoke: () => {
      refreshTokens.clear();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
