import type { Db } from "../../src/db/client.js";
import type { RuntimeConfig } from "../../src/env.js";
import type { NotificationOptions } from "../../src/notifications.js";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer, type StartOptions } from "../../src/server.js";

/** 测试专用的凭据钥匙。account-add 脚本和测试都用 CredentialCrypto 拿它加密令牌。 */
export const TEST_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");

// 没指到假平台的用例万一发了，也只会连不上，不会打到真 GitHub 和 X。
const UNREACHABLE_PLATFORMS = { githubApiBaseUrl: "http://127.0.0.1:9/github", xApiBaseUrl: "http://127.0.0.1:9/x" };
const DAY_MS = 24 * 60 * 60 * 1000;

export type TestServer = { readonly server: RunningServer; client(): ApiClient; close(): Promise<void> };

export async function startTestServer(
  db: Db,
  config: Partial<RuntimeConfig> = {},
  scheduler?: StartOptions["scheduler"],
  notificationScheduler?: NotificationOptions,
  publisher?: StartOptions["publisher"],
  agentOptions: Pick<StartOptions, "mcpDiscoveryTimeoutMs"> = {},
): Promise<TestServer> {
  const server = await startServer({
    db,
    ...agentOptions,
    port: 0,
    toolSecretKey: "a".repeat(64),
    credentialsKey: TEST_CREDENTIALS_KEY,
    config: { ...DEFAULT_RUNTIME_CONFIG, ...UNREACHABLE_PLATFORMS, ...config },
    ...(scheduler === undefined ? {} : { scheduler }),
    ...(notificationScheduler === undefined ? {} : { notificationScheduler }),
    // 发布循环只在测试手动 tick 时跑，不让它自己到点抢走别的用例留下的已批草稿。
    publisher: { intervalMs: DAY_MS, ...publisher },
  });
  return {
    server,
    client: () => new ApiClient(server.port),
    close: () => server.close(),
  };
}

/** 带 cookie 罐的最小客户端。测试只通过 HTTP 和 WebSocket 碰控制面。 */
export class ApiClient {
  #cookie: string | null = null;

  constructor(readonly port: number) {}

  get cookie(): string | null {
    return this.#cookie;
  }

  get origin(): string {
    return `http://localhost:${this.port}`;
  }

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.#cookie !== null) headers["cookie"] = this.#cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.getSetCookie();
    for (const raw of setCookie) {
      const pair = raw.split(";")[0];
      if (pair !== undefined) this.#cookie = pair;
    }
    return response;
  }

  get(path: string): Promise<Response> {
    return this.request("GET", path);
  }
  post(path: string, body?: unknown): Promise<Response> {
    return this.request("POST", path, body ?? {});
  }
  patch(path: string, body: unknown): Promise<Response> {
    return this.request("PATCH", path, body);
  }
  delete(path: string): Promise<Response> {
    return this.request("DELETE", path);
  }

  async login(email: string, password: string): Promise<Response> {
    return this.post("/api/auth/login", { email, password });
  }
}
