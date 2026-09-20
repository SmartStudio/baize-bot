import { describe, expect, it } from "vitest";
import { BotListResponse, CreateGroupResponse, type ServerPush } from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import { type ChatRequest, startUpstream, type ScriptedTurn } from "../src/upstream.js";

const textTurn: ScriptedTurn = { textChunks: ["收到"], usage: { input: 20, output: 5 } };

/** Pi 把内容发成 `[{ type: "text", text }]` 片段数组，把文本片段原样拼起来，断言里才能写换行。 */
const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : JSON.stringify(part),
    )
    .join("");
};

/** 一次 prompt 只发给模型一轮，所以等到群里的 cost 消息就等于这一轮的请求已经到了假上游。 */
async function sendAndSettle(stack: Stack, groupId: string, message: string): Promise<void> {
  await stack.post(`/api/groups/${groupId}/messages`, { text: message });
  for (;;) {
    const push: ServerPush = await stack.nextPush();
    if (push.type === "message" && push.message.groupId === groupId && push.message.body.kind === "cost") return;
  }
}

const lastUserText = (request: ChatRequest): string => {
  const user = request.messages.toReversed().find((m) => m.role === "user");
  if (user === undefined) throw new Error("请求里没有 user 报文");
  return text(user.content);
};

const systemText = (request: ChatRequest): string => {
  const system = request.messages.find((m) => m.role === "system");
  if (system === undefined) throw new Error("请求里没有 system 报文");
  return text(system.content);
};

describe("端到端：模型实际收到的 prompt 头部", () => {
  it("单聊标单聊，多 Bot 群标群编号、标题、成员，系统提示带身份", async () => {
    const upstream = await startUpstream(() => textTurn);
    const stack = await startStack({ upstreamBaseUrl: upstream.baseUrl, priceInputPerM: 3, priceOutputPerM: 15 });
    try {
      const bots = BotListResponse.parse(await stack.get("/api/bots")).items;
      const service = bots.find((item) => item.bot.name === "小服");
      const buyer = bots.find((item) => item.bot.name === "小采");
      if (service === undefined || buyer === undefined) throw new Error("seed 缺少小服或小采");

      await sendAndSettle(stack, service.groupId, "今天有哪些工单");
      const solo = upstream.requests().at(-1);
      if (solo === undefined) throw new Error("单聊没有到达假上游");
      expect(lastUserText(solo)).toContain("[这是你和用户的单聊]");
      expect(lastUserText(solo)).toContain("用户：今天有哪些工单");
      expect(lastUserText(solo), "单聊不带任务卡").not.toContain("群成员：");
      expect(systemText(solo)).toContain("你是白泽 Bot");
      expect(systemText(solo)).toContain("你叫 小服，标签 客服");
      expect(systemText(solo)).toContain("协作规则：");
      expect(stack.prompts().at(-1)?.reason, "单聊的派活原因").toBe("solo");

      const { group, task } = CreateGroupResponse.parse(
        await stack.post("/api/groups", { title: "采购交接", botIds: [service.bot.id, buyer.bot.id] }),
      );
      const before = upstream.requests().length;
      await sendAndSettle(stack, group.id, "@小服 整理需求");
      const team = upstream.requests().at(-1);
      if (team === undefined || upstream.requests().length === before) throw new Error("群消息没有到达假上游");
      const prompt = lastUserText(team);
      expect(prompt).toContain(`[群 ${task.number} 采购交接 · 成员 小服、小采]`);
      expect(prompt, "任务卡上的成员各占一行，带标签和描述").toContain(
        "群成员：\n- 小服（客服）：客服方向的活先找我。\n- 小采（采购）：采购方向的活先找我。",
      );
      expect(prompt).toContain("用户：@小服 整理需求");
      expect(prompt, "用户发的不该被当成队友说的").not.toContain("这是队友说的");
      const teamPrompts = stack.prompts().filter((item) => item.groupId === group.id);
      expect(
        teamPrompts.map((item) => item.origin),
        "控制面标的来源是用户",
      ).toEqual([{ kind: "user" }]);
      expect(
        teamPrompts.map((item) => item.reason),
        "被 @ 的派活原因",
      ).toEqual(["mentioned"]);
      expect(
        teamPrompts[0]?.members.map((member) => member.role),
        "没设首席时人人都是普通成员",
      ).toEqual(["member", "member"]);
    } finally {
      await stack.close();
      await upstream.close();
    }
  });
});
