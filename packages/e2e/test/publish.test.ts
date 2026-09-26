import { describe, expect, it } from "vitest";
import {
  BotListResponse,
  DecideDraftResponse,
  MessageListResponse,
  TodayResponse,
  type AccountId,
  type Draft,
} from "@baize/shared";
import { startFakePlatforms } from "@baize/control-plane/testing";
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
