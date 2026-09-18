import type { Db } from "../../src/db/client.js";
import type { RuntimeConfig } from "../../src/env.js";
import { DEFAULT_RUNTIME_CONFIG, startServer, type RunningServer } from "../../src/server.js";

export type TestServer = { readonly server: RunningServer; client(): ApiClient; close(): Promise<void> };

export async function startTestServer(db: Db, config: Partial<RuntimeConfig> = {}): Promise<TestServer> {
  const server = await startServer({ db, port: 0, config: { ...DEFAULT_RUNTIME_CONFIG, ...config } });
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
