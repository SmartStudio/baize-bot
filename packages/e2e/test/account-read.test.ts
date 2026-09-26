import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotListResponse, type AccountId } from "@baize/shared";
import { startFakePlatforms } from "@baize/control-plane/testing";
import { startStack, type Stack } from "../src/stack.js";
import { isFollowUpTurn, startUpstream, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

const ASK = "看看 baize/demo 有哪些 issue";
const TOKEN = "ghp_e2e_account_read_token_7f3a";
const isUser = (request: { platform: string; path: string }) =>
  request.platform === "github" && request.path === "/user";

const USAGE = { input: 100, output: 10 };

/** 数据目录下所有含令牌的文件，按字节找，二进制文件也不放过。 */
function filesContaining(root: string, needle: string): string[] {
  const bytes = Buffer.from(needle, "utf8");
  return readdirSync(root, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const file = join(entry.parentPath, entry.name);
    try {
      return readFileSync(file).includes(bytes) ? [file] : [];
    } catch {
      // Chrome 之类跑完就删的临时文件，读不到就不算。
      return [];
    }
  });
}

async function runSettled(stack: Stack): Promise<void> {
  for (;;) {
    const push = await stack.nextPush();
    if (push.type === "message" && push.message.body.kind === "cost") return;
  }
}

describe("端到端：Bot 经账号代理读假 GitHub", () => {
  it("account_read 读回假 issue，令牌只在控制面，运行器的数据目录和模型那端都没有", async () => {
    let accountId: AccountId | null = null;
    const toolResults: string[] = [];
    const modelSaw: string[] = [];
    const script = (request: ChatRequest): ScriptedTurn => {
      modelSaw.push(JSON.stringify(request));
      const asked = request.messages.some(
        (message) => message.role === "user" && JSON.stringify(message.content).includes(ASK),
      );
      if (!asked || accountId === null) return { textChunks: ["收到"], usage: USAGE };
      if (isFollowUpTurn(request)) {
        toolResults.push(JSON.stringify(request.messages.filter((message) => message.role === "tool")));
        return { textChunks: ["有一条 issue"], usage: USAGE };
      }
      return {
        textChunks: [],
        toolCall: {
          id: "read-1",
          name: "account_read",
          args: { accountId, path: "repos/baize/demo/issues?state=open" },
        },
        usage: USAGE,
      };
    };

    const fake = await startFakePlatforms();
    const upstream = await startUpstream(script);
    let stack: Stack | undefined;
    try {
      stack = await startStack({
        upstreamBaseUrl: upstream.baseUrl,
        priceInputPerM: 3,
        priceOutputPerM: 15,
        githubApiBaseUrl: fake.githubBaseUrl,
        xApiBaseUrl: fake.xBaseUrl,
        startComputer: false,
      });
      accountId = (await stack.addAccount({ platform: "github", handle: "baize-dev", token: TOKEN })).id;
      await stack.startComputer();

      const bots = BotListResponse.parse(await stack.get("/api/bots"));
      const first = bots.items[0];
      if (first === undefined) throw new Error("seed 没建出 Bot");
      await stack.post(`/api/groups/${first.groupId}/messages`, { text: ASK });
      await runSettled(stack);
      const trace = `电脑代理日志：\n${stack.agentLog()}`;

      expect(
        fake.requests().map(({ platform, method, path, authorization }) => ({ platform, method, path, authorization })),
        trace,
      ).toEqual([
        {
          platform: "github",
          method: "GET",
          path: "/repos/baize/demo/issues?state=open",
          authorization: `Bearer ${TOKEN}`,
        },
      ]);
      expect(toolResults.join(""), `假 issue 要一路回到模型那一轮。${trace}`).toContain("假 issue");

      expect(filesContaining(stack.dataDir, "假 issue").length, "扫描本身看得见数据目录里的会话记录").toBeGreaterThan(
        0,
      );
      expect(filesContaining(stack.dataDir, TOKEN), "运行器的数据目录里没有平台令牌").toEqual([]);
      expect(stack.agentLog()).not.toContain(TOKEN);
      expect(modelSaw.join("\n"), "模型那端也看不到平台令牌").not.toContain(TOKEN);
    } finally {
      await stack?.close();
      await upstream.close();
      await fake.close();
    }
  });

  it("平台把收到的 Authorization 原样回显，成功一次、502 一次：模型、代理日志、数据目录里都只有 [已隐藏]", async () => {
    const ECHO_ASK = "看看我在 GitHub 上是谁";
    let accountId: AccountId | null = null;
    const toolResults: string[] = [];
    const modelSaw: string[] = [];
    const script = (request: ChatRequest): ScriptedTurn => {
      modelSaw.push(JSON.stringify(request));
      const asked = request.messages.some(
        (message) => message.role === "user" && JSON.stringify(message.content).includes(ECHO_ASK),
      );
      if (!asked || accountId === null) return { textChunks: ["收到"], usage: USAGE };
      const results = request.messages.filter((message) => message.role === "tool");
      if (results.length >= 2) {
        toolResults.push(JSON.stringify(results));
        return { textChunks: ["读完了"], usage: USAGE };
      }
      return {
        textChunks: [],
        toolCall: { id: `echo-${results.length + 1}`, name: "account_read", args: { accountId, path: "user" } },
        usage: USAGE,
      };
    };

    const fake = await startFakePlatforms();
    const upstream = await startUpstream(script);
    let stack: Stack | undefined;
    try {
      stack = await startStack({
        upstreamBaseUrl: upstream.baseUrl,
        priceInputPerM: 3,
        priceOutputPerM: 15,
        githubApiBaseUrl: fake.githubBaseUrl,
        xApiBaseUrl: fake.xBaseUrl,
        startComputer: false,
      });
      accountId = (await stack.addAccount({ platform: "github", handle: "baize-dev", token: TOKEN })).id;
      await stack.startComputer();
      fake.failNext(200, isUser, { login: "baize-dev", authorization: `Bearer ${TOKEN}` });
      fake.failNext(502, isUser, { message: `Bad gateway, you sent Authorization: Bearer ${TOKEN}` });

      const bots = BotListResponse.parse(await stack.get("/api/bots"));
      const first = bots.items[0];
      if (first === undefined) throw new Error("seed 没建出 Bot");
      await stack.post(`/api/groups/${first.groupId}/messages`, { text: ECHO_ASK });
      await runSettled(stack);
      const trace = `电脑代理日志：\n${stack.agentLog()}`;

      expect(
        fake.requests().map(({ platform, path, authorization }) => ({ platform, path, authorization })),
        `假平台两次都收到了真令牌，它回显的就是这个。${trace}`,
      ).toEqual([
        { platform: "github", path: "/user", authorization: `Bearer ${TOKEN}` },
        { platform: "github", path: "/user", authorization: `Bearer ${TOKEN}` },
      ]);
      const seen = toolResults.join("");
      expect(seen, `成功那次回到模型的是换过的令牌。${trace}`).toContain("Bearer [已隐藏]");
      expect(seen, "502 那次的错误文案也到了模型那一轮").toContain("账号代理回 502");
      expect(seen, "502 那次错误文案里的令牌也换掉").toContain("you sent Authorization: Bearer [已隐藏]");

      expect(modelSaw.join("\n"), "模型那端看不到平台令牌").not.toContain(TOKEN);
      expect(stack.agentLog(), "电脑代理日志里没有平台令牌").not.toContain(TOKEN);
      expect(filesContaining(stack.dataDir, "[已隐藏]").length, "扫描看得见会话记录里那两次读").toBeGreaterThan(0);
      expect(filesContaining(stack.dataDir, TOKEN), "运行器的数据目录里没有平台令牌").toEqual([]);
    } finally {
      await stack?.close();
      await upstream.close();
      await fake.close();
    }
  });

  it("平台回显的是令牌的编码写法（小写百分号、JSON 斜杠转义）：模型、代理日志、数据目录里都只有 [已隐藏]", async () => {
    const ENCODED_ASK = "看看下一页在哪";
    const ODD_TOKEN = "gho_e2e/echo+tok_9b";
    const lowerPct = encodeURIComponent(ODD_TOKEN).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
    const jsonSlash = ODD_TOKEN.replaceAll("/", "\\/");
    let accountId: AccountId | null = null;
    const toolResults: string[] = [];
    const modelSaw: string[] = [];
    const script = (request: ChatRequest): ScriptedTurn => {
      modelSaw.push(JSON.stringify(request));
      const asked = request.messages.some(
        (message) => message.role === "user" && JSON.stringify(message.content).includes(ENCODED_ASK),
      );
      if (!asked || accountId === null) return { textChunks: ["收到"], usage: USAGE };
      const results = request.messages.filter((message) => message.role === "tool");
      if (results.length >= 2) {
        toolResults.push(JSON.stringify(results));
        return { textChunks: ["读完了"], usage: USAGE };
      }
      return {
        textChunks: [],
        toolCall: { id: `encoded-${results.length + 1}`, name: "account_read", args: { accountId, path: "user" } },
        usage: USAGE,
      };
    };

    const fake = await startFakePlatforms();
    const upstream = await startUpstream(script);
    let stack: Stack | undefined;
    try {
      stack = await startStack({
        upstreamBaseUrl: upstream.baseUrl,
        priceInputPerM: 3,
        priceOutputPerM: 15,
        githubApiBaseUrl: fake.githubBaseUrl,
        xApiBaseUrl: fake.xBaseUrl,
        startComputer: false,
      });
      accountId = (await stack.addAccount({ platform: "github", handle: "baize-dev", token: ODD_TOKEN })).id;
      await stack.startComputer();
      expect(lowerPct, "小写十六进制的百分号编码").toBe("gho_e2e%2fecho%2btok_9b");
      fake.failNext(200, isUser, { next: `https://api.github.com/user?access_token=${lowerPct}&page=2` });
      fake.failNext(502, isUser, `{"message":"you sent ${jsonSlash}"}`);

      const bots = BotListResponse.parse(await stack.get("/api/bots"));
      const first = bots.items[0];
      if (first === undefined) throw new Error("seed 没建出 Bot");
      await stack.post(`/api/groups/${first.groupId}/messages`, { text: ENCODED_ASK });
      await runSettled(stack);
      const trace = `电脑代理日志：\n${stack.agentLog()}`;

      expect(
        fake.requests().map(({ platform, path, authorization }) => ({ platform, path, authorization })),
        `假平台两次都收到了原样令牌，回显的是它的编码写法。${trace}`,
      ).toEqual([
        { platform: "github", path: "/user", authorization: `Bearer ${ODD_TOKEN}` },
        { platform: "github", path: "/user", authorization: `Bearer ${ODD_TOKEN}` },
      ]);
      const seen = toolResults.join("");
      expect(seen, `代理回包到了模型那一轮，编码写法整把换掉。${trace}`).toContain("access_token=[已隐藏]&page=2");
      expect(seen, "502 那次 JSON 转义的写法也换掉").toContain("you sent [已隐藏]");

      // 令牌两头这两段在每种写法里都原样出现，JSON 再转义一层也还在，拿它们扫比拿整把写法扫更不容易漏。
      const fragments = ["gho_e2e", "tok_9b", lowerPct, ODD_TOKEN];
      expect(filesContaining(stack.dataDir, "access_token=[已隐藏]").length, "扫描看得见会话记录").toBeGreaterThan(0);
      for (const fragment of fragments) {
        expect(seen, `代理回包里没有「${fragment}」`).not.toContain(fragment);
        expect(modelSaw.join("\n"), `模型那端没有「${fragment}」`).not.toContain(fragment);
        expect(stack.agentLog(), `电脑代理日志里没有「${fragment}」`).not.toContain(fragment);
        expect(filesContaining(stack.dataDir, fragment), `数据目录里没有「${fragment}」`).toEqual([]);
      }
    } finally {
      await stack?.close();
      await upstream.close();
      await fake.close();
    }
  });
});
