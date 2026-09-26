import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// 假 GitHub 和假 X。控制面测试、e2e 和实机验证都把平台根地址指到这里，真仓库和真令牌一律不用。
// 只认发布器会打的那几条路径，别的回 404，发布器多打一条没见过的请求会在断言里露出来。

export type FakePlatformRequest = {
  readonly platform: "github" | "x";
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
};

export type FakePlatforms = {
  /** 交给 GITHUB_API_BASE_URL。 */
  readonly githubBaseUrl: string;
  /** 交给 X_API_BASE_URL。 */
  readonly xBaseUrl: string;
  /** 到达的请求，按到达顺序。 */
  requests(): readonly FakePlatformRequest[];
  /** 接下来的一条请求回这个状态码，不落地。 */
  failNext(status: number): void;
  /** 从现在起到达的请求先挂着，调返回的函数才放行。 */
  hold(): () => void;
  close(): Promise<void>;
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw === "" ? null : JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakePlatforms(): Promise<FakePlatforms> {
  const requests: FakePlatformRequest[] = [];
  const failures: number[] = [];
  let gate: Promise<void> | null = null;
  let counter = 100;
  // 建 discussion 的那条 mutation 只带仓库的节点 id，仓库名记在前一条查仓库的请求上。
  let discussionRepo = "o/r";

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
    reply(res, 404, { title: "Not Found" });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://fake");
    const [, prefix, ...rest] = url.pathname.split("/");
    const platform = prefix === "github" ? "github" : prefix === "x" ? "x" : null;
    if (platform === null || req.method !== "POST") {
      reply(res, 404, {});
      return;
    }
    const path = `/${rest.join("/")}`;
    const body = await readBody(req);
    requests.push({ platform, method: req.method, path, authorization: req.headers.authorization ?? null, body });
    if (gate !== null) await gate;
    const failure = failures.shift();
    if (failure !== undefined) {
      reply(res, failure, { message: `fake ${failure}` });
      return;
    }
    if (platform === "github") github(path, body, res);
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
    requests: () => requests,
    failNext: (status) => {
      failures.push(status);
    },
    hold: () => {
      let resolve: (() => void) | undefined;
      gate = new Promise<void>((done) => {
        resolve = done;
      });
      return () => {
        gate = null;
        resolve?.();
      };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
