import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AccountId, type Account } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addAccountWithToken, CredentialCrypto } from "../src/credentials.js";
import { accounts } from "../src/db/schema.js";
import { startFakePlatforms } from "../src/fake-platforms.js";
import { ACCOUNTS_PROXY_MAX_BYTES, readCapped, TRUNCATED_HEADER } from "../src/http/accounts-proxy.js";
import { newId } from "../src/ids.js";
import { startTestServer, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { nextOf } from "./helpers/content.js";
import { createTestDb } from "./helpers/db.js";
import { waitFor } from "./helpers/fixtures.js";
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

const isUser = (request: { platform: string; path: string }) =>
  request.platform === "github" && request.path === "/user";
const isRefresh = (request: { body: unknown }) =>
  (request.body as Record<string, unknown> | null)?.["grant_type"] === "refresh_token";

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

/** 手里已有令牌的账号，像 account-add 脚本那样挂上去，令牌里带什么字符由测试定。 */
async function ownerWithToken(stack: OAuthStack, token: string): Promise<{ owner: Owner; account: Account }> {
  const owner = await makeOwner(stack, { remote: true });
  owners.push(owner);
  const account = await addAccountWithToken(
    stack.database.db,
    new CredentialCrypto(TEST_CREDENTIALS_KEY),
    {
      ownerId: owner.user.id,
      computerId: owner.remote?.computerId ?? owner.local.computerId,
      platform: "github",
      via: "api",
      handle: "baize-dev",
    },
    token,
  );
  return { owner, account };
}

/** 斜杠、加号、等号、引号、反斜杠都有，URL 编码和 JSON 转义都会改它的样子。 */
const ODD_TOKEN = String.raw`ghu_p1/5+fix="two\three`;
const hex2 = (byte: number): string => byte.toString(16).padStart(2, "0");
const upperPct = encodeURIComponent(ODD_TOKEN);
const lowerPct = upperPct.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
/** 第 1、3、5… 个转义小写，其余大写。 */
const mixedPct = upperPct
  .split("%")
  .map((part, i) => (i % 2 === 1 ? part.slice(0, 2).toLowerCase() + part.slice(2) : part))
  .join("%");
const allBytesPct = [...Buffer.from(ODD_TOKEN)].map((byte) => `%${hex2(byte)}`).join("");
const jsonEscaped = JSON.stringify(ODD_TOKEN).slice(1, -1);
const jsonSlash = jsonEscaped.replaceAll("/", "\\/");
const jsonUnicode = [...ODD_TOKEN]
  .map((char, i) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${i % 2 === 0 ? code : code.toUpperCase()}`;
  })
  .join("");
/** 一把令牌里每个字符各用一种写法。 */
const perChar = String.raw`ghu_p1%2f5\u002Bfix%3D\"two%5cthree`;

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
      via: "api",
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

  it("平台在正文里回显收到的令牌：成功、出错、401 刷新后重试的回包里，这次用过的新旧令牌都换成 [已隐藏]", async () => {
    const before = s.fake.requests().length;
    const { owner, linked } = await ownerWith(["github"]);
    const [github] = linked;
    if (github === undefined) throw new Error("没连上 GitHub");
    const token = s.fake
      .requests()
      .slice(before)
      .find((request) => request.method === "GET")?.authorization;
    const oldToken = token?.replace(/^Bearer /, "") ?? "";
    expect(oldToken, "连 GitHub 时发出过访问令牌").not.toBe("");

    s.fake.failNext(200, isUser, { authorization: `Bearer ${oldToken}`, again: oldToken });
    const ok = await proxyFetch(owner, `/${github.id}/user`);
    const okText = await ok.text();
    expect(ok.status).toBe(200);
    expect(JSON.parse(okText), "成功回包里两处令牌都换掉").toEqual({
      authorization: "Bearer [已隐藏]",
      again: "[已隐藏]",
    });

    s.fake.failNext(502, isUser, { error: `Authorization: Bearer ${oldToken}` });
    const failed = await proxyFetch(owner, `/${github.id}/user`);
    expect(failed.status, "出错的状态码照旧透给电脑").toBe(502);
    expect(await failed.json(), "出错回包里的令牌也换掉").toEqual({ error: "Authorization: Bearer [已隐藏]" });

    // 旧令牌先挨一次 401，控制面强制刷新后拿新令牌重试。新令牌只有挂住第二条请求才看得到，看到再排回包。
    s.fake.failNext(401, (request) => isUser(request) && request.authorization === `Bearer ${oldToken}`);
    const retried = (request: { platform: string; path: string; authorization: string | null }) =>
      isUser(request) && request.authorization !== `Bearer ${oldToken}`;
    const release = s.fake.hold(retried);
    const retryFrom = s.fake.requests().length;
    const pending = proxyFetch(owner, `/${github.id}/user`);
    let newToken = "";
    await waitFor(async () => {
      newToken =
        s.fake
          .requests()
          .slice(retryFrom)
          .findLast(retried)
          ?.authorization?.replace(/^Bearer /, "") ?? "";
      return newToken !== "";
    }, "刷新后的重试挂在假平台上");
    s.fake.failNext(200, retried, { old: oldToken, fresh: `Bearer ${newToken}` });
    release();
    const refreshed = await pending;
    expect(refreshed.status).toBe(200);
    expect(newToken, "确实换了令牌").not.toBe(oldToken);
    expect(await refreshed.json(), "新旧两份令牌都换掉").toEqual({ old: "[已隐藏]", fresh: "Bearer [已隐藏]" });
  });

  it("正文超过上限就截在上限处并在响应头里标记，切在令牌中间也不留半截令牌", async () => {
    const before = s.fake.requests().length;
    const { owner, linked } = await ownerWith(["github"]);
    const [github] = linked;
    if (github === undefined) throw new Error("没连上 GitHub");
    const token =
      s.fake
        .requests()
        .slice(before)
        .find((request) => request.method === "GET")
        ?.authorization?.replace(/^Bearer /, "") ?? "";
    expect(token.length, "令牌够长才切得到它中间").toBeGreaterThan(10);

    const cut = ACCOUNTS_PROXY_MAX_BYTES - 10;
    s.fake.failNext(200, isUser, `${"a".repeat(cut)}${token}${"b".repeat(4096)}`);
    const straddled = await proxyFetch(owner, `/${github.id}/user`);
    expect(straddled.headers.get(TRUNCATED_HEADER), "超上限的回包在头里标记截断").toBe("true");
    expect(await straddled.text(), "上限处落在令牌中间，那半截令牌也去掉").toBe("a".repeat(cut));

    s.fake.failNext(200, isUser, "c".repeat(ACCOUNTS_PROXY_MAX_BYTES + 1));
    const over = await proxyFetch(owner, `/${github.id}/user`);
    expect(over.headers.get(TRUNCATED_HEADER)).toBe("true");
    expect((await over.text()).length, "截在上限处").toBe(ACCOUNTS_PROXY_MAX_BYTES);

    s.fake.failNext(200, isUser, "d".repeat(ACCOUNTS_PROXY_MAX_BYTES));
    const exact = await proxyFetch(owner, `/${github.id}/user`);
    expect(exact.headers.get(TRUNCATED_HEADER), "正好到上限不算截断").toBeNull();
    expect((await exact.text()).length).toBe(ACCOUNTS_PROXY_MAX_BYTES);
  });

  it("平台回显令牌的等价写法：大小写百分号编码、JSON 转义、逐字符混着写，同一把令牌出现多次，全都换成 [已隐藏]", async () => {
    const { owner, account } = await ownerWithToken(s, ODD_TOKEN);
    const forms = { upperPct, lowerPct, mixedPct, allBytesPct, jsonEscaped, jsonSlash, jsonUnicode, perChar };
    expect(lowerPct, "小写百分号编码").toBe("ghu_p1%2f5%2bfix%3d%22two%5cthree");
    expect(mixedPct, "大小写混写").toBe("ghu_p1%2f5%2Bfix%3d%22two%5cthree");
    expect(jsonEscaped, "标准 JSON 转义引号和反斜杠").toBe(String.raw`ghu_p1/5+fix=\"two\\three`);
    const body = [ODD_TOKEN, ...Object.values(forms)].map((form) => `<${form}>`).join(" ");
    const sent = (request: { authorization: string | null }) => request.authorization === `Bearer ${ODD_TOKEN}`;
    s.fake.failNext(200, (request) => isUser(request) && sent(request), body);

    const echoed = await proxyFetch(owner, `/${account.id}/user`);
    expect(echoed.status).toBe(200);
    expect(await echoed.text(), "每一处都整把换掉").toBe(Array.from({ length: 9 }, () => "<[已隐藏]>").join(" "));
    expect(s.fake.requests().findLast(isUser)?.authorization, "平台收到的是这把令牌").toBe(`Bearer ${ODD_TOKEN}`);
  });

  it("截断落在令牌的编码写法中间，连半个百分号转义或 \\u 转义也一起去掉", async () => {
    const { owner, account } = await ownerWithToken(s, ODD_TOKEN);
    for (const [form, kept] of [
      [lowerPct, 12],
      [jsonUnicode, 22],
    ] as const) {
      const head = "a".repeat(ACCOUNTS_PROXY_MAX_BYTES - kept);
      s.fake.failNext(200, isUser, `${head}${form}${"b".repeat(4096)}`);
      const cut = await proxyFetch(owner, `/${account.id}/user`);
      expect(cut.headers.get(TRUNCATED_HEADER)).toBe("true");
      expect(form.slice(0, kept), "上限处落在一个转义中间").toMatch(/%2$|\\u00$/);
      expect(await cut.text(), `切在「${form.slice(0, kept)}」后面，这一截都去掉`).toBe(head);
    }
  });

  it("截断处接不成令牌的不删：上限落在 %2 后、普通字符后、多字节字符中间，只有真接着令牌写下去的那一截才去掉", async () => {
    const token = "/ghu_lows";
    const { owner, account } = await ownerWithToken(s, token);
    for (const { name, form, kept, cut } of [
      { name: "%2 后面接的是空格", form: "%20plain", kept: 2, cut: false },
      { name: "%2 后面接的是这把令牌", form: "%2Fghu_lows", kept: 2, cut: true },
      { name: "/ 后面接的是别的字", form: "/xyz", kept: 1, cut: false },
      { name: "/ 后面接的是这把令牌", form: token, kept: 1, cut: true },
      { name: "上限落在「中」的第一个字节后", form: "中文", kept: 1, cut: false },
    ]) {
      const head = Buffer.from("a".repeat(ACCOUNTS_PROXY_MAX_BYTES - kept));
      const tail = Buffer.from(form).subarray(0, kept);
      s.fake.failNext(200, isUser, `${head.toString()}${form}${"b".repeat(4096)}`);
      const response = await proxyFetch(owner, `/${account.id}/user`);
      expect(response.headers.get(TRUNCATED_HEADER)).toBe("true");
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(cut ? head : Buffer.concat([head, tail])), `${name}：${cut ? "这一截去掉" : "原样留着"}`).toBe(
        true,
      );
    }
  });

  it("401 刷新后的新令牌以旧令牌开头，两把都回显在正文里：长的先匹配，替换后不留残片", async () => {
    const before = s.fake.requests().length;
    const { owner, linked } = await ownerWith(["github"]);
    const [github] = linked;
    if (github === undefined) throw new Error("没连上 GitHub");
    const oldToken =
      s.fake
        .requests()
        .slice(before)
        .find((request) => request.method === "GET")
        ?.authorization?.replace(/^Bearer /, "") ?? "";
    expect(oldToken, "连 GitHub 时发出过访问令牌").not.toBe("");
    const newToken = `${oldToken}_next`;
    const sentWith = (token: string) => (request: { platform: string; path: string; authorization: string | null }) =>
      isUser(request) && request.authorization === `Bearer ${token}`;

    s.fake.failNext(401, sentWith(oldToken));
    s.fake.failNext(200, isRefresh, {
      access_token: newToken,
      expires_in: 8 * 3600,
      refresh_token: "github_refresh_next",
      token_type: "bearer",
    });
    s.fake.failNext(200, sentWith(newToken), `<${oldToken}> <${newToken}>`);
    const response = await proxyFetch(owner, `/${github.id}/user`);

    expect(response.status).toBe(200);
    expect(await response.text(), "短的先匹配会把长的那把剩下 _next").toBe("<[已隐藏]> <[已隐藏]>");
    expect(s.fake.requests().findLast(isUser)?.authorization, "重试用的是刷出来的新令牌").toBe(`Bearer ${newToken}`);
  });

  /** 旧令牌挨一次 401，刷出 freshOf(旧令牌) 这把新令牌，拿新令牌重试时平台回 bodyOf(旧, 新)。 */
  async function afterRefresh(
    freshOf: (old: string) => string,
    bodyOf: (old: string, fresh: string) => string,
  ): Promise<{ readonly response: Response; readonly oldToken: string; readonly newToken: string }> {
    const before = s.fake.requests().length;
    const { owner, linked } = await ownerWith(["github"]);
    const [github] = linked;
    if (github === undefined) throw new Error("没连上 GitHub");
    const oldToken =
      s.fake
        .requests()
        .slice(before)
        .find((request) => request.method === "GET")
        ?.authorization?.replace(/^Bearer /, "") ?? "";
    expect(oldToken, "连 GitHub 时发出过访问令牌").not.toBe("");
    const newToken = freshOf(oldToken);
    const sentWith = (token: string) => (request: { platform: string; path: string; authorization: string | null }) =>
      isUser(request) && request.authorization === `Bearer ${token}`;
    s.fake.failNext(401, sentWith(oldToken));
    s.fake.failNext(200, isRefresh, {
      access_token: newToken,
      expires_in: 8 * 3600,
      refresh_token: "github_refresh_next",
      token_type: "bearer",
    });
    s.fake.failNext(200, sentWith(newToken), bodyOf(oldToken, newToken));
    const response = await proxyFetch(owner, `/${github.id}/user`);
    expect(response.status).toBe(200);
    expect(response.headers.get(TRUNCATED_HEADER)).toBe("true");
    return { response, oldToken, newToken };
  }

  it("截断落在以旧令牌开头的新令牌中间：在原始字节上算截断再替换，旧令牌不会先吞掉开头、把新令牌的后半截留下", async () => {
    let head = "";
    const { response, newToken } = await afterRefresh(
      (old) => `${old}_next`,
      (old, fresh) => {
        head = "a".repeat(ACCOUNTS_PROXY_MAX_BYTES - old.length - "_ne".length);
        return `${head}${fresh}${"b".repeat(4096)}`;
      },
    );
    const text = await response.text();
    expect(newToken.slice(0, ACCOUNTS_PROXY_MAX_BYTES - head.length), "上限落在新令牌的 _ne 后面").toMatch(/_ne$/);
    expect(text, "新令牌从开头起整截去掉，不剩 [已隐藏]_ne").toBe(head);
  });

  it("截断前整把写完的旧令牌，尾巴正好是跨过上限的新令牌的开头：旧令牌整把去掉，不留前半截", async () => {
    let head = "";
    const { response, oldToken } = await afterRefresh(
      (old) => `${old.slice(-1)}zz_next`,
      (old, fresh) => {
        head = "a".repeat(ACCOUNTS_PROXY_MAX_BYTES - old.length);
        return `${head}${old}${fresh.slice(1)}${"b".repeat(4096)}`;
      },
    );
    const text = await response.text();
    expect(text.startsWith(head), "上限之前的正文原样留着").toBe(true);
    expect(["", "[已隐藏]"], `截断处不留旧令牌的碎片，实际留下「${text.slice(head.length)}」`).toContain(
      text.slice(head.length),
    );
    expect(oldToken.length, "旧令牌够长，留下前半截就是泄露").toBeGreaterThan(10);
  });

  it("读到上限 cancel 之后放掉 reader lock，平台中途断连时也放掉", async () => {
    let canceled = false;
    const endless = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64).fill(0x61));
        },
        cancel() {
          canceled = true;
        },
      }),
    );
    const read = await readCapped(endless, 100);
    expect(read.truncated).toBe(true);
    expect(read.bytes.length).toBe(100);
    expect(canceled, "到上限就 cancel").toBe(true);
    expect(endless.body?.locked, "cancel 之后 reader lock 放掉了").toBe(false);

    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.error(new Error("平台断连"));
        },
      }),
    );
    await expect(readCapped(broken, 100)).rejects.toThrow("平台断连");
    expect(broken.body?.locked, "读出错时 reader lock 也放掉了").toBe(false);
  });

  it("读到上限 cancel 抛错：照样交出截断的正文，不让整条代理请求变 500", async () => {
    const throwing = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64).fill(0x61));
        },
        cancel() {
          throw new Error("cancel 出错");
        },
      }),
    );
    const read = await readCapped(throwing, 100);
    expect(read.truncated, "上限前的正文已经读齐，cancel 出错不影响它").toBe(true);
    expect(read.bytes.length).toBe(100);
    expect(throwing.body?.locked, "reader lock 照样放掉").toBe(false);
  });

  it("白名单响应头回显令牌：这个头整个丢掉，别的头和正文照常，请求成功", async () => {
    const database = await createTestDb();
    const fake = await startFakePlatforms();
    const platform = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-echo": ODD_TOKEN,
        link: `<https://api.github.com/user?access_token=${lowerPct}&page=2>; rel="next"`,
        etag: `W/"${jsonUnicode}"`,
      });
      response.end(JSON.stringify({ login: "baize-dev" }));
    });
    await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
    const server = await startTestServer(database.db, {
      githubApiBaseUrl: `http://127.0.0.1:${(platform.address() as AddressInfo).port}`,
    });
    const stack: OAuthStack = {
      database,
      fake,
      server,
      close: async () => {
        await server.close();
        await new Promise<void>((resolve) => platform.close(() => resolve()));
        await fake.close();
        await database.close();
      },
    };
    let owner: Owner | undefined;
    try {
      const linked = await ownerWithToken(stack, ODD_TOKEN);
      owner = linked.owner;
      const account = linked.account;
      const response = await proxyFetch(owner, `/${account.id}/user`);
      expect(response.status, "头里有令牌不影响这次读").toBe(200);
      expect(await response.json()).toEqual({ login: "baize-dev" });
      const headers = Object.fromEntries(response.headers);
      expect(headers["x-ratelimit-remaining"], "没命中的白名单头照常透").toBe("4999");
      expect(headers["content-type"]).toBe("application/json");
      for (const name of ["x-ratelimit-echo", "link", "etag"]) {
        expect(headers[name], `${name} 回显了令牌，整个丢掉`).toBeUndefined();
      }
      const serialized = JSON.stringify(headers);
      for (const form of [ODD_TOKEN, lowerPct, "ghu_p1"]) expect(serialized).not.toContain(form);
    } finally {
      owner?.close();
      await stack.close();
    }
  });
});
