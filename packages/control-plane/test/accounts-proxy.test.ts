import { AccountId, type Account } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts } from "../src/db/schema.js";
import { newId } from "../src/ids.js";
import { nextOf } from "./helpers/content.js";
import { connectPlatform, makeOwner, oauthStack, proxyFetch, type OAuthStack, type Owner } from "./helpers/oauth.js";

let s: OAuthStack;
const owners: Owner[] = [];

beforeAll(async () => {
  s = await oauthStack();
});

afterAll(async () => {
  for (const owner of owners) owner.close();
  await s.close();
});

type Linked = { readonly owner: Owner; readonly linked: readonly Account[]; readonly config: Owner["config"] };

/** 一个有远程电脑的用户，逐个连上平台账号。config 是连完之后电脑收到的最后一份。 */
async function ownerWith(platforms: readonly ("github" | "x")[]): Promise<Linked> {
  const owner = await makeOwner(s, { remote: true });
  owners.push(owner);
  const linked: Account[] = [];
  let config = owner.config;
  for (const platform of platforms) {
    await connectPlatform(owner.client, platform);
    linked.push((await nextOf(owner.push, "account_updated")).account);
    config = await owner.agent.expect("config");
  }
  return { owner, linked, config };
}

const errorOf = async (response: Response): Promise<string> => ((await response.json()) as { error: string }).error;

describe("账号代理", () => {
  it("代理只认网关 key，别人的账号 404，过期的账号 409，非 GET 405", async () => {
    const { owner, linked } = await ownerWith(["github"]);
    const { owner: stranger, linked: strangersLinked } = await ownerWith(["github"]);
    const [mine] = linked;
    const [theirs] = strangersLinked;
    if (mine === undefined || theirs === undefined) throw new Error("没连上 GitHub");
    const expiredId = AccountId.parse(newId());
    await s.database.db.insert(accounts).values({
      id: expiredId,
      ownerId: owner.user.id,
      computerId: owner.remote?.computerId ?? owner.local.computerId,
      platform: "github",
      handle: "old-handle",
      login: "expired",
    });
    const placeholder = await owner.client.post("/api/accounts", {
      platform: "xiaohongshu",
      computerId: owner.local.computerId,
    });
    expect(placeholder.status).toBeLessThan(300);
    const xhsId = ((await placeholder.json()) as { account: Account }).account.id;
    const before = s.fake.requests().length;

    const base = owner.config.accountsProxy?.baseUrl ?? "";
    expect((await fetch(`${base}/${mine.id}/user`)).status, "不带 key").toBe(401);
    const wrongKey = await proxyFetch(owner, `/${mine.id}/user`, { headers: { authorization: "Bearer not-a-key" } });
    expect(wrongKey.status, "key 不对").toBe(401);
    const cookieOnly = await fetch(`${base}/${mine.id}/user`, { headers: { cookie: owner.client.cookie ?? "" } });
    expect(cookieOnly.status, "浏览器会话不算数，只认电脑的网关 key").toBe(401);

    const others = await proxyFetch(owner, `/${theirs.id}/user`);
    expect(others.status, "别人的账号").toBe(404);
    expect(await errorOf(others)).toBe("没有这个账号");
    expect((await proxyFetch(stranger, `/${mine.id}/user`)).status, "反过来也一样").toBe(404);
    expect((await proxyFetch(owner, `/${AccountId.parse(newId())}/user`)).status, "没有这一行").toBe(404);
    expect((await proxyFetch(owner, `/${xhsId}/user`)).status, "小红书不走代理").toBe(404);

    const expired = await proxyFetch(owner, `/${expiredId}/user`);
    expect(expired.status, "过期的账号").toBe(409);
    expect(await errorOf(expired)).toContain("重新");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const write = await proxyFetch(owner, `/${mine.id}/repos/baize/demo/issues`, { method });
      expect(write.status, `${method} 不放行`).toBe(405);
      expect(await errorOf(write)).toBe("代理只读，发东西走草稿");
    }

    expect(s.fake.requests().slice(before), "被拒的请求一条都没到平台").toEqual([]);
    expect((await proxyFetch(owner, `/${mine.id}/user`)).status, "自己的、已登录的放行").toBe(200);
  });

  it("代理转发时换上平台令牌，回包里没有令牌，电脑收到的 config 和代理回包里 grep 不到令牌", async () => {
    const before = s.fake.requests().length;
    const { owner, linked, config } = await ownerWith(["github", "x"]);
    const [github, x] = linked;
    if (github === undefined || x === undefined) throw new Error("没连上平台");
    const issued = s.fake
      .requests()
      .slice(before)
      .filter((request) => request.method === "GET")
      .map((request) => request.authorization?.replace(/^Bearer /, "") ?? "");
    expect(issued, "两个平台各发了一个访问令牌").toHaveLength(2);
    const [githubToken, xToken] = issued;
    const gatewayKey = owner.config.modelGateway.apiKey;
    expect(config.accountsProxy?.baseUrl).toBe(`${owner.client.origin}/accounts-proxy`);
    expect(config.accounts.map((account) => account.login)).toEqual(["valid", "valid"]);

    const issues = await proxyFetch(owner, `/${github.id}/repos/baize/demo/issues?state=open&per_page=5`, {
      headers: { accept: "application/vnd.github+json", cookie: "baize_session=leak" },
    });
    expect(issues.status).toBe(200);
    const issuesText = await issues.text();
    expect(JSON.parse(issuesText)).toEqual([
      { number: 7, title: "假 issue", html_url: "https://github.com/baize/demo/issues/7" },
    ]);
    expect(issues.headers.get("set-cookie"), "平台的 set-cookie 不透给电脑").toBeNull();
    expect(issues.headers.get("x-ratelimit-remaining"), "限流头透给电脑").toBe("4999");

    const tweets = await proxyFetch(owner, `/${x.id}/2/tweets/search/recent?query=baize`);
    expect(tweets.status).toBe(200);
    const tweetsText = await tweets.text();

    const forwarded = s.fake.requests().slice(-2);
    expect(
      forwarded.map(({ platform, method, path, authorization }) => ({ platform, method, path, authorization })),
    ).toEqual([
      {
        platform: "github",
        method: "GET",
        path: "/repos/baize/demo/issues?state=open&per_page=5",
        authorization: `Bearer ${githubToken}`,
      },
      { platform: "x", method: "GET", path: "/2/tweets/search/recent?query=baize", authorization: `Bearer ${xToken}` },
    ]);

    // 斜杠编码进一段里：代理先解码再拼、拼完又不核对根地址的话，..%2F 变回 ../，请求落到 X 上。
    const escaped = await proxyFetch(owner, `/${github.id}/..%2F..%2Fx%2F2%2Fusers%2Fme`);
    expect(escaped.ok, "跳不出 GitHub 的根地址").toBe(false);
    expect(s.fake.requests().findLast((request) => request.platform === "x")?.path, "X 那边没再收到请求").toBe(
      "/2/tweets/search/recent?query=baize",
    );

    const exposed = [
      JSON.stringify(config),
      issuesText,
      JSON.stringify([...issues.headers]),
      tweetsText,
      JSON.stringify([...tweets.headers]),
    ].join("\n");
    for (const token of [githubToken, xToken]) {
      expect(token).not.toBe("");
      expect(exposed, "config 和代理回包里 grep 不到平台令牌").not.toContain(token);
    }
    expect(exposed).not.toMatch(/(github|x)_(access|refresh)_\d/);
    expect(gatewayKey).not.toBe(githubToken);
  });
});
