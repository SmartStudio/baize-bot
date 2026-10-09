import { describe, expect, it } from "vitest";
import {
  BotListResponse,
  DecideProjectOfferResponse,
  GroupResponse,
  type BotId,
  type GroupId,
  type Message,
} from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import { type ChatRequest, type ScriptedTurn, startUpstream } from "../src/upstream.js";

const ASK = "推广白泽的开源仓库，年底 1000 星";

const PROPOSAL = {
  name: "推广白泽",
  goal: "白泽的开源仓库年底 1000 星",
  team: [
    { name: "小内", tags: ["内容"], description: "写小红书笔记和 X 帖子，不回评论" },
    { name: "小社", tags: ["社区"], description: "回 GitHub issue 和评论，不写长文" },
  ],
  platforms: [
    { kind: "supported", platform: "github" },
    { kind: "unsupported", name: "抖音" },
  ],
  cadence: "每周小红书 2 篇",
  firstStep: "先把 README 改成一句话讲清楚白泽是什么",
};

const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("");
};

const lastUserText = (request: ChatRequest): string =>
  text(request.messages.toReversed().find((m) => m.role === "user")?.content);

/** 首页那句话让主助理调 propose_project，工具回来后说一句；其余一律回「收到」。
 * 主助理的会话历史里一直留着那次工具结果，所以看最后一条是不是工具结果，不用 isFollowUpTurn。 */
function script(request: ChatRequest): ScriptedTurn {
  if (request.messages.at(-1)?.role === "tool")
    return { textChunks: ["方案卡发好了，等你点开始"], usage: { input: 30, output: 8 } };
  if (lastUserText(request).includes(`用户：${ASK}`)) {
    return {
      textChunks: [],
      toolCall: { id: "call-propose", name: "propose_project", args: PROPOSAL },
      usage: { input: 40, output: 20 },
    };
  }
  return { textChunks: ["收到"], usage: { input: 20, output: 5 } };
}

/** 等到某个群的花费卡，说明这一次活从头到尾跑完了。沿途推过来的消息都收着。 */
async function settle(stack: Stack, groupId: string): Promise<Message[]> {
  const seen: Message[] = [];
  for (;;) {
    const push = await stack.nextPush();
    if (push.type !== "message") continue;
    seen.push(push.message);
    if (push.message.groupId === groupId && push.message.body.kind === "cost") return seen;
  }
}

describe("端到端：一句话建项目", () => {
  it("主助理调 propose_project 后群里出现方案卡，点开始后新群能收到派活", async () => {
    const upstream = await startUpstream(script);
    const stack = await startStack({ upstreamBaseUrl: upstream.baseUrl, priceInputPerM: 3, priceOutputPerM: 15 });
    try {
      const assistant = BotListResponse.parse(await stack.get("/api/bots")).items.find(
        (item) => item.bot.role === "assistant",
      );
      if (assistant === undefined) throw new Error("seed 没建出主助理");

      await stack.post(`/api/groups/${assistant.groupId}/messages`, { text: ASK });
      const seen = await settle(stack, assistant.groupId);
      const card = seen.findLast((message) => message.body.kind === "project_offer");
      expect(card, `群里要出现方案卡。电脑代理日志：\n${stack.agentLog()}`).toBeDefined();
      if (card === undefined) return;
      expect(card.groupId).toBe(assistant.groupId);
      expect(card.body).toMatchObject({
        kind: "project_offer",
        botId: assistant.bot.id,
        ...PROPOSAL,
        status: "offered",
        groupId: null,
      });

      const started = DecideProjectOfferResponse.parse(
        await stack.post(`/api/messages/${card.id}/project-offer`, { decision: "start" }),
      );
      const project = started.group;
      if (project === null) throw new Error("点开始却没回项目群");
      const detail = GroupResponse.parse(await stack.get(`/api/groups/${project.id}`));
      expect(detail.task.cadence).toBe(PROPOSAL.cadence);
      const member = detail.bots.find((bot) => bot.name === "小内");
      if (member === undefined) throw new Error("项目群里没有小内");

      await expectDispatched(stack, project.id, "这周先做什么", assistant.bot.id);
      await expectDispatched(stack, project.id, "@小内 先写一篇小红书", member.id);
    } finally {
      await stack.close();
      await upstream.close();
    }
  });
});

/** 在项目群里说一句，派给 `botId`，它在这个群里答了话。队员答得上来说明新 config 已经到了运行器。 */
async function expectDispatched(stack: Stack, groupId: GroupId, said: string, botId: BotId): Promise<void> {
  await stack.post(`/api/groups/${groupId}/messages`, { text: said });
  const seen = await settle(stack, groupId);
  expect(stack.prompts().at(-1), "派活落在项目群").toMatchObject({ groupId, botId });
  const replies = seen.filter((message) => message.groupId === groupId && message.body.kind === "bot");
  expect(
    replies.map((message) => (message.body.kind === "bot" ? message.body.botId : null)),
    `电脑代理日志：\n${stack.agentLog()}`,
  ).toContain(botId);
}
