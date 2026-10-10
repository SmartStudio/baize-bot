import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  startFakePlatforms as startBasePlatforms,
  type FakePlatformRequest,
  type FakePlatforms as BasePlatforms,
} from "@baize/control-plane/testing";

export type FakePlatforms = BasePlatforms & {
  setGithubStars(repo: string, value: number): void;
};

/** 只在 e2e 扩展仓库星数，其他 GitHub 路径仍交给现有假平台。 */
export async function startFakePlatforms(): Promise<FakePlatforms> {
  const base = await startBasePlatforms();
  const stars = new Map<string, number>();
  const requests: FakePlatformRequest[] = [];
  let collected = 0;
  const collect = () => {
    const inherited = base.requests();
    requests.push(...inherited.slice(collected));
    collected = inherited.length;
  };
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const repo = /^\/repos\/([^/]+\/[^/?]+)$/.exec(path)?.[1];
    if (req.method === "GET" && repo !== undefined) {
      collect();
      requests.push({
        platform: "github",
        method: "GET",
        path,
        authorization: req.headers.authorization ?? null,
        body: null,
      });
      const value = stars.get(repo);
      res.writeHead(value === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(value === undefined ? { message: "Not Found" } : { stargazers_count: value }));
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await fetch(`${base.githubBaseUrl}${path}`, {
        method: req.method ?? "GET",
        headers: {
          ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }),
          ...(req.headers["content-type"] === undefined ? {} : { "content-type": req.headers["content-type"] }),
        },
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(error) }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    await base.close();
    throw error;
  }
  return {
    ...base,
    githubBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setGithubStars: (repo, value) => stars.set(repo, value),
    requests: () => {
      collect();
      return requests;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      await base.close();
    },
  };
}
