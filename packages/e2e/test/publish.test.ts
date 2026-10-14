import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentHandle } from "@baize/computer-agent";
import {
  AccountResponse,
  BotListResponse,
  DecideDraftResponse,
  LoginAccountResponse,
  LoginAttemptId,
  MessageListResponse,
  TodayResponse,
  type AccountId,
  type Draft,
} from "@baize/shared";
import { startFakePlatforms } from "@baize/control-plane/testing";
import { fakeChrome } from "../acceptance/fake-chrome.js";
import { pushUntil, startRemoteComputer } from "../src/live.js";
import { startStack, type Stack } from "../src/stack.js";
import { isFollowUpTurn, startUpstream, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

const ASK = "起草一条周报 issue";
const TOKEN = "ghp_e2e_publish_token";
const USAGE = { input: 100, output: 10 };

async function draftPushed(stack: Stack): Promise<Draft> {
  for (;;) {
    const push = await stack.nextPush();
    if (push.type === "draft_updated") return push.draft;
  }
}

describe("端到端：草稿批准后发到假 GitHub", () => {
  it("Bot 调 create_draft，批准后假 GitHub 收到 issue，publications 有链接", async () => {
    let accountId: AccountId | null = null;
    const script = (request: ChatRequest): ScriptedTurn => {
      const asked = request.messages.some(
        (message) => message.role === "user" && JSON.stringify(message.content).includes(ASK),
      );
      if (!asked || accountId === null) return { textChunks: ["收到"], usage: USAGE };
      if (isFollowUpTurn(request)) return { textChunks: ["草稿在等你批"], usage: USAGE };
      return {
        textChunks: [],
        toolCall: {
          id: "draft-1",
          name: "create_draft",
          args: {
            accountId,
            content: {
              kind: "post",
              title: "白泽周报",
              text: "这周做完了草稿和发布",
              github: { repo: "baize/demo", as: "issue" },
            },
          },
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

      const created = await draftPushed(stack);
      const trace = `电脑代理日志：\n${stack.agentLog()}`;
      expect(created, trace).toMatchObject({
        groupId: first.groupId,
        accountId,
        status: "pending",
        platform: "github",
      });

      const decided = DecideDraftResponse.parse(await stack.post(`/api/drafts/${created.id}`, { decision: "approve" }));
      expect(decided.draft.status).toBe("approved");
      expect(fake.requests(), "批之前什么都没发").toEqual([]);

      await stack.publishTick();

      expect(fake.requests()).toEqual([
        {
          platform: "github",
          method: "POST",
          path: "/repos/baize/demo/issues",
          authorization: `Bearer ${TOKEN}`,
          body: { title: "白泽周报", body: "这周做完了草稿和发布" },
        },
      ]);
      const page = MessageListResponse.parse(await stack.get(`/api/groups/${first.groupId}/messages`));
      expect(page.drafts.find((draft) => draft.id === created.id)?.status).toBe("published");
      expect(page.publications.map(({ draftId, url }) => ({ draftId, url }))).toEqual([
        { draftId: created.id, url: "https://github.com/baize/demo/issues/101" },
      ]);
      const today = TodayResponse.parse(await stack.get("/api/today"));
      expect(today.done.filter((item) => item.kind === "publication").map((item) => item.url)).toEqual([
        "https://github.com/baize/demo/issues/101",
      ]);
      expect(stack.agentLog()).not.toContain(TOKEN);
    } finally {
      await stack?.close();
      await upstream.close();
      await fake.close();
    }
  });
});

describe("端到端：远程电脑上的小红书草稿", () => {
  it("批准后远程电脑认领草稿，发布器在这台电脑的助理 Chrome 里开发布页，撞上登录页记登录过期，账号跟着过期", async () => {
    const XHS_ASK = "起一条小红书笔记";
    // 1x1 的 PNG。发布器在打开发布页那一步就因登录过期停下，图的内容不重要，只要是工作目录里的真文件。
    const COVER = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    let accountId: AccountId | null = null;
    const script = (request: ChatRequest): ScriptedTurn => {
      const asked = request.messages.some(
        (message) => message.role === "user" && JSON.stringify(message.content).includes(XHS_ASK),
      );
      if (!asked || accountId === null) return { textChunks: ["收到"], usage: USAGE };
      if (isFollowUpTurn(request)) return { textChunks: ["草稿在等你批"], usage: USAGE };
      return {
        textChunks: [],
        toolCall: {
          id: "draft-xhs",
          name: "create_draft",
          args: {
            accountId,
            content: {
              kind: "post",
              title: "我用 5 个 AI 做推广",
              text: "它们各管一摊：写稿、回评论、排计划。",
              images: [{ path: "cover.png" }],
            },
          },
        },
        usage: USAGE,
      };
    };

    const chrome = fakeChrome({ kind: "remote" });
    const fake = await startFakePlatforms();
    const upstream = await startUpstream(script);
    let stack: Stack | undefined;
    let agent: AgentHandle | undefined;
    let agentLog = "";
    try {
      stack = await startStack({
        upstreamBaseUrl: upstream.baseUrl,
        priceInputPerM: 3,
        priceOutputPerM: 15,
        githubApiBaseUrl: fake.githubBaseUrl,
        xApiBaseUrl: fake.xBaseUrl,
        startComputer: false,
      });
      const remote = await startRemoteComputer(stack, {
        makeChrome: chrome.factory,
        log: (line) => {
          agentLog += `${line}\n`;
        },
      });
      agent = remote.agent;
      const trace = () => `远程电脑代理日志：\n${agentLog}`;

      const { account } = AccountResponse.parse(
        await stack.post("/api/accounts", { platform: "xiaohongshu", computerId: remote.computerId }),
      );
      accountId = account.id;
      const attempt = LoginAttemptId.parse(randomUUID());
      LoginAccountResponse.parse(await stack.post(`/api/accounts/${account.id}/login`, { attempt }));
      await pushUntil(stack, (push) =>
        push.type === "live_session" && push.session.purpose.kind === "login" ? push.session : undefined,
      );
      chrome.scan("白泽工厂日记");
      await pushUntil(stack, (push) =>
        push.type === "account_updated" && push.account.id === account.id && push.account.login === "valid"
          ? push.account
          : undefined,
      );

      const bot = BotListResponse.parse(await stack.get("/api/bots")).items[0];
      if (bot === undefined) throw new Error("seed 没建出 Bot");
      const work = join(stack.dataDir, bot.bot.id, "work");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "cover.png"), COVER);
      await stack.post(`/api/groups/${bot.groupId}/messages`, { text: XHS_ASK });

      const created = await draftPushed(stack);
      expect(created, trace()).toMatchObject({ accountId, status: "pending", platform: "xiaohongshu" });
      const decided = DecideDraftResponse.parse(await stack.post(`/api/drafts/${created.id}`, { decision: "approve" }));
      expect(decided.draft.status).toBe("approved");

      const before = chrome.cdpCalls().length;
      await stack.publishTick();
      const live = stack;
      const updates = (status: Draft["status"]) =>
        pushUntil(live, (push) =>
          push.type === "draft_updated" && push.draft.id === created.id && push.draft.status !== status
            ? push.draft
            : undefined,
        );
      const claimed = await updates("approved");
      expect(claimed.status, `远程电脑在线、账号登录有效，这条草稿被认领去发。${trace()}`).toBe("publishing");
      const settled = await updates("publishing");
      expect(
        { status: settled.status, failure: settled.failure },
        `改之前远程电脑的发布器拿不到浏览器，回 error「这台电脑没有助理浏览器」，草稿记 error，账号不动。${trace()}`,
      ).toEqual({ status: "failed", failure: "login_expired" });
      const expired = await pushUntil(live, (push) =>
        push.type === "account_updated" && push.account.id === account.id ? push.account : undefined,
      );
      expect(expired.login, "登录过期了，账号页和首页引用户去画面上重新扫码").toBe("expired");
      expect(chrome.cdpCalls().slice(before), "发布器开自己的后台标签页去发布页，看到登录页就关掉这一页").toEqual([
        "Target.createTarget",
        "Target.attachToTarget",
        "Emulation.setFocusEmulationEnabled",
        "Page.navigate",
        "Runtime.evaluate",
        "Target.closeTarget",
      ]);
      expect(fake.requests(), "小红书不走平台接口，假 GitHub、假 X 什么都没收到").toEqual([]);
    } finally {
      await agent?.stop();
      await stack?.close();
      await upstream.close();
      await fake.close();
    }
  });
});
