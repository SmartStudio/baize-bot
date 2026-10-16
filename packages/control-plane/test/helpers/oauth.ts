import { ComputerTokenResponse, type OAuthPlatform, type User } from "@baize/shared";
import { expect } from "vitest";
import type { OAuthConfig, RuntimeConfig } from "../../src/env.js";
import { startFakePlatforms, type FakePlatforms } from "../../src/fake-platforms.js";
import { helloAgent, type AgentClient, type HelloResult } from "./agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./client.js";
import { createTestDb, type TestDb } from "./db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./fixtures.js";
import { connectPush, type PushClient } from "./ws.js";

export const GITHUB_APP = { clientId: "gh-app-client", clientSecret: "gh-app-secret" } as const;
/** X 的公共客户端：没有 secret，只靠 PKCE。 */
export const X_APP = { clientId: "x-public-client", clientSecret: null } as const;
export const SHORT_LIFETIME_S = 30;
export const LONG_LIFETIME_S = 8 * 3600;

export type OAuthStack = {
  readonly database: TestDb;
  readonly fake: FakePlatforms;
  readonly server: TestServer;
  close(): Promise<void>;
};

export async function oauthStack(
  apps: Partial<Pick<OAuthConfig, "github" | "x">> = {},
  config: Partial<Pick<RuntimeConfig, "webBaseUrl">> = {},
  /** 发布循环的时钟，钉住它能让「这一轮开始的时刻」和认领那一刻拉开。 */
  clock?: () => Date,
): Promise<OAuthStack> {
  const database = await createTestDb();
  const fake = await startFakePlatforms();
  const server = await startTestServer(
    database.db,
    {
      ...config,
      githubApiBaseUrl: fake.githubBaseUrl,
      xApiBaseUrl: fake.xBaseUrl,
      oauth: {
        github: GITHUB_APP,
        x: X_APP,
        ...apps,
        githubOauthBaseUrl: fake.githubOauthBaseUrl,
        xOauthBaseUrl: fake.xOauthBaseUrl,
      },
    },
    undefined,
    undefined,
    clock === undefined ? undefined : { now: clock },
  );
  return {
    database,
    fake,
    server,
    close: async () => {
      await server.close();
      await fake.close();
      await database.close();
    },
  };
}

export type Owner = {
  readonly user: User;
  readonly client: ApiClient;
  readonly push: PushClient;
  readonly local: TestComputer;
  readonly remote: TestComputer | null;
  /** 连上来的那台电脑：有远程电脑就是远程电脑。 */
  readonly agent: AgentClient;
  readonly config: HelloResult["config"];
  close(): void;
};

export async function makeOwner(s: OAuthStack, options: { readonly remote: boolean }): Promise<Owner> {
  const user = await makeUser(s.database.db);
  const local = await makeComputer(s.database.db, user.id);
  const client = s.server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const remote = options.remote
    ? ComputerTokenResponse.parse(await (await client.post("/api/computers/remote")).json())
    : null;
  const online = remote ?? local;
  const { agent, config } = await helloAgent(s.server.server.port, online.computerId, online.token);
  // 电脑上线的那条 computer_updated 紧跟 config 同步推完，推送连接等 config 到了才连，收到的第一条就是这次要看的。
  const push = await connectPush(s.server.server.port, client.cookie ?? "");
  return {
    user,
    client,
    push,
    local,
    remote,
    agent,
    config,
    close: () => {
      agent.close();
      push.close();
    },
  };
}

/** 浏览器那样打一个地址：不自动跟跳转，cookie 只带给控制面自己。 */
export function browse(client: ApiClient, url: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (new URL(url).origin === client.origin && client.cookie !== null) headers["cookie"] = client.cookie;
  return fetch(url, { redirect: "manual", headers });
}

export function redirectOf(response: Response): URL {
  expect(response.status, "本应是一次 302 跳转").toBe(302);
  const location = response.headers.get("location");
  if (location === null) throw new Error("302 没带 location");
  return new URL(location, response.url);
}

export type Walk = { readonly authorize: URL; readonly callback: URL; readonly landed: URL };

/** 账号页点「连 GitHub」或「连 X」，在假平台上点同意，一路跳回 Web。 */
export async function connectPlatform(client: ApiClient, platform: OAuthPlatform): Promise<Walk> {
  const authorize = redirectOf(await browse(client, `${client.origin}/api/oauth/${platform}/start`));
  const callback = redirectOf(await browse(client, authorize.href));
  const landed = redirectOf(await browse(client, callback.href));
  return { authorize, callback, landed };
}

export type ProxyRequest = { readonly method?: string; readonly headers?: Record<string, string> };

/** 电脑那样打账号代理：地址取自 config.accountsProxy，Bearer 是 config 里的网关 key。 */
export function proxyFetch(owner: Pick<Owner, "config">, path: string, request: ProxyRequest = {}): Promise<Response> {
  const base = owner.config.accountsProxy?.baseUrl;
  if (base === undefined) throw new Error("config 里没有 accountsProxy");
  return fetch(`${base}${path}`, {
    method: request.method ?? "GET",
    headers: { authorization: `Bearer ${owner.config.modelGateway.apiKey}`, ...request.headers },
  });
}
