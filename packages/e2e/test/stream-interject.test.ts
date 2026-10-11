import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BotListResponse, CreateGroupResponse } from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import {
  type ChatRequest,
  type FakeUpstream,
  isFollowUpTurn,
  type ScriptedTurn,
  startUpstream,
} from "../src/upstream.js";

// 多 Bot 群里小采话说到一半，用户插话 @小服。小服这一轮看得到半截，下一轮要拿到小采说完的那句，
// 并且两轮合起来每条群消息只看到一次（半截那条除外，它的前半截可以看两次）。

const usage = { input: 20, output: 5 };
const say = (...textChunks: ScriptedTurn["textChunks"]): ScriptedTurn => ({ textChunks, usage });
const pwd: ScriptedTurn["toolCall"] = { id: "call-pwd", name: "bash", args: { command: "pwd" } };

function gate(): { open(): void; wait(): Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, wait: () => opened };
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: unknown }) => (typeof part.text === "string" ? part.text : "")).join("")
      : "";

const isBot = (req: ChatRequest, name: string): boolean =>
  req.messages.some((m) => m.role === "system" && text(m.content).includes(`你叫 ${name}`));

type Round = { readonly context: readonly string[]; readonly current: string };

/** 小服每次 prompt 头一轮请求里最后那条 user，就是运行器拼好的这一轮，拆成「群里刚才说的」和「当前这条」。 */
function roundsOf(upstream: FakeUpstream, name: string): Round[] {
  return upstream
    .requests()
    .filter((req) => isBot(req, name) && !isFollowUpTurn(req))
    .map((req) => {
      const prompt = text(req.messages.findLast((m) => m.role === "user")?.content);
      const context = /群里刚才说的：\n([\s\S]*?)\n\n当前这条：/.exec(prompt)?.[1];
      const current = /当前这条：\n([\s\S]*)$/.exec(prompt)?.[1] ?? "";
      return { context: context === undefined ? [] : context.split("\n"), current };
    });
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等不到：${what}`);
}

type Team = {
  readonly upstream: FakeUpstream;
  readonly stack: Stack;
  readonly groupId: string;
  readonly fuId: string;
  readonly caiId: string;
  /** 用户在群里说一句。 */
  post(text: string): Promise<void>;
  /** 等这个 Bot 在这个群里一共收尾 count 个 run。 */
  runsDone(botId: string, count: number): Promise<void>;
  /** 小采说的、正文含 fragment 的那条，在库里现在的样子。 */
  caiSaid(fragment: string): Promise<{ text: string; streaming: boolean } | undefined>;
  /**
   * 等小采这次工具调用的卡在库里收尾。工具之后那一轮到了上游不代表卡已落库：工具卡走代理报文，
   * 后一轮走网关，两条路在控制面上不排队，插话抢在卡前面落库的话卡就排到插话后面。
   */
  caiToolSettled(): Promise<void>;
  close(): Promise<void>;
};

async function team(script: (req: ChatRequest) => ScriptedTurn | Promise<ScriptedTurn>): Promise<Team> {
  const upstream = await startUpstream(script);
  const stack = await startStack({ upstreamBaseUrl: upstream.baseUrl, priceInputPerM: 3, priceOutputPerM: 15 });
  const bots = BotListResponse.parse(await stack.get("/api/bots")).items;
  const fu = bots.find((item) => item.bot.name === "小服");
  const cai = bots.find((item) => item.bot.name === "小采");
  if (fu === undefined || cai === undefined) throw new Error("seed 缺少小服或小采");
  const { group } = CreateGroupResponse.parse(
    await stack.post("/api/groups", { title: "库存", botIds: [fu.bot.id, cai.bot.id] }),
  );
  return {
    upstream,
    stack,
    groupId: group.id,
    fuId: fu.bot.id,
    caiId: cai.bot.id,
    post: async (message) => {
      await stack.post(`/api/groups/${group.id}/messages`, { text: message });
    },
    runsDone: (botId, count) =>
      until(async () => {
        const rows = await stack.sql<{ ended_at: Date | null }[]>`
          SELECT ended_at FROM runs WHERE group_id = ${group.id} AND bot_id = ${botId}`;
        return rows.length === count && rows.every((row) => row.ended_at !== null);
      }, `${botId} 在群里收尾 ${count} 个 run`),
    caiSaid: async (fragment) => {
      const rows = await stack.sql<{ body: { text: string; streaming: boolean } }[]>`
        SELECT body FROM messages
        WHERE group_id = ${group.id} AND body->>'kind' = 'bot' AND body->>'botId' = ${cai.bot.id}
          AND body->>'text' LIKE ${`%${fragment}%`}`;
      return rows[0]?.body;
    },
    caiToolSettled: () =>
      until(async () => {
        const rows = await stack.sql<{ status: string }[]>`
          SELECT body->>'status' AS status FROM messages
          WHERE group_id = ${group.id} AND body->>'kind' = 'tool_call' AND body->>'botId' = ${cai.bot.id}`;
        return rows.length === 1 && rows[0]?.status === "ok";
      }, "小采的工具卡在库里收尾"),
    close: async () => {
      await stack.close();
      await upstream.close();
    },
  };
}

describe("端到端：Bot 话说到一半时插话", () => {
  it("P1 小采流到一半用户 @小服，小服这轮看半截，下轮看到整句，触发消息不再出现", async () => {
    const hold = gate();
    const t = await team((req) =>
      isBot(req, "小采") ? say("库存我先查一下，", hold.wait, "还剩 30 件。") : say("收到"),
    );
    try {
      await t.post("@小采 查一下库存");
      await until(async () => (await t.caiSaid("库存我先查一下"))?.streaming === true, "小采那句流到一半");
      await t.post("@小服 你看下排产");
      await t.runsDone(t.fuId, 1);
      hold.open();
      await t.runsDone(t.caiId, 1);
      await t.post("@小服 再对一下");
      await t.runsDone(t.fuId, 2);

      expect(roundsOf(t.upstream, "小服"), "两轮合起来每条只看一次，半截那条第二轮给整句").toEqual([
        {
          context: ["你：@小采 查一下库存", "小采 · 采购：库存我先查一下，"],
          current: "用户：@小服 你看下排产",
        },
        { context: ["小采 · 采购：库存我先查一下，还剩 30 件。", "小服：收到"], current: "用户：@小服 再对一下" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("P2 小采说一句、调工具，工具之后那句还没来时插话，下一轮看到工具之后那句", async () => {
    const hold = gate();
    const t = await team(async (req) => {
      if (!isBot(req, "小采")) return say("收到");
      if (!isFollowUpTurn(req)) return { ...say("库存我先查一下，"), toolCall: pwd };
      await hold.wait();
      return say("还剩 30 件。");
    });
    try {
      await t.post("@小采 查一下库存");
      await until(
        async () => t.upstream.requests().some((req) => isBot(req, "小采") && isFollowUpTurn(req)),
        "小采工具之后那一轮到了上游",
      );
      await t.caiToolSettled();
      await t.post("@小服 你看下排产");
      await t.runsDone(t.fuId, 1);
      hold.open();
      await t.runsDone(t.caiId, 1);
      await t.post("@小服 再对一下");
      await t.runsDone(t.fuId, 2);

      expect(roundsOf(t.upstream, "小服"), "工具前后是两条消息，每条只看一次").toEqual([
        {
          context: ["你：@小采 查一下库存", "小采 · 采购：库存我先查一下，", "小采 · 采购：要执行 `pwd`，跑完了"],
          current: "用户：@小服 你看下排产",
        },
        { context: ["小服：收到", "小采 · 采购：还剩 30 件。"], current: "用户：@小服 再对一下" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("P3 工具之后那句流到一半时第二次插话，第三轮看到整句，前两轮的触发都不重来", async () => {
    const afterTool = gate();
    const midStream = gate();
    const t = await team(async (req) => {
      if (!isBot(req, "小采")) return say("收到");
      if (!isFollowUpTurn(req)) return { ...say("库存我先查一下，"), toolCall: pwd };
      await afterTool.wait();
      return say("还剩 30 件，", midStream.wait, "明天补货。");
    });
    try {
      await t.post("@小采 查一下库存");
      await until(
        async () => t.upstream.requests().some((req) => isBot(req, "小采") && isFollowUpTurn(req)),
        "小采工具之后那一轮到了上游",
      );
      await t.caiToolSettled();
      await t.post("@小服 你看下排产");
      await t.runsDone(t.fuId, 1);
      afterTool.open();
      await until(async () => (await t.caiSaid("还剩 30 件"))?.streaming === true, "工具之后那句流到一半");
      await t.post("@小服 再看看");
      await t.runsDone(t.fuId, 2);
      midStream.open();
      await t.runsDone(t.caiId, 1);
      await t.post("@小服 最后对一下");
      await t.runsDone(t.fuId, 3);

      expect(await t.caiSaid("库存我先查一下"), "工具之前那句定稿后没再被接上别的字").toEqual({
        kind: "bot",
        botId: t.caiId,
        text: "库存我先查一下，",
        streaming: false,
      });
      expect(roundsOf(t.upstream, "小服"), "三轮合起来每条只看一次，流到一半那条第三轮给整句").toEqual([
        {
          context: ["你：@小采 查一下库存", "小采 · 采购：库存我先查一下，", "小采 · 采购：要执行 `pwd`，跑完了"],
          current: "用户：@小服 你看下排产",
        },
        { context: ["小服：收到", "小采 · 采购：还剩 30 件，"], current: "用户：@小服 再看看" },
        { context: ["小采 · 采购：还剩 30 件，明天补货。", "小服：收到"], current: "用户：@小服 最后对一下" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("R1 小采有一条永远停在半截的老消息，它的 run 开着时小服照常看到新消息，老半截不重复，之后也不丢", async () => {
    const hold = gate();
    const t = await team(async (req) => {
      if (!isBot(req, "小采")) return say("收到");
      await hold.wait();
      return say("库存还剩 30 件。");
    });
    try {
      await t.post("@小服 早");
      await t.runsDone(t.fuId, 1);
      // 电脑掉线或流到一半被中止留下的那种：streaming 一直是 true，再也不会长。
      await t.stack.sql`
        INSERT INTO messages (id, group_id, body, created_at)
        VALUES (${randomUUID()}, ${t.groupId},
                ${JSON.stringify({ kind: "bot", botId: t.caiId, text: "断在半截", streaming: true })}::jsonb, now())`;
      await t.post("@小采 查下库存");
      await until(async () => t.upstream.requests().some((req) => isBot(req, "小采")), "小采的 run 开着");
      for (const [index, line] of ["@小服 第一句", "@小服 第二句", "@小服 第三句"].entries()) {
        await t.post(line);
        await t.runsDone(t.fuId, index + 2);
      }
      hold.open();
      await t.runsDone(t.caiId, 1);
      await t.post("@小服 第四句");
      await t.runsDone(t.fuId, 5);

      expect(roundsOf(t.upstream, "小服"), "小采的 run 开着时不冻结，老半截只看一次，收尾后那句照样送到").toEqual([
        { context: [], current: "用户：@小服 早" },
        {
          context: ["小服：收到", "小采 · 采购：断在半截", "你：@小采 查下库存"],
          current: "用户：@小服 第一句",
        },
        { context: ["小服：收到"], current: "用户：@小服 第二句" },
        { context: ["小服：收到"], current: "用户：@小服 第三句" },
        { context: ["小服：收到", "小采 · 采购：库存还剩 30 件。"], current: "用户：@小服 第四句" },
      ]);
    } finally {
      await t.close();
    }
  });
});
