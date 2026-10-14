import { expect, it } from "vitest";
import { BotListResponse, CreateGroupResponse, MessageListResponse, type UplinkFrame } from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import { isFollowUpTurn, startUpstream, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

const poll = { timeout: 30_000, interval: 25 };
const usage = { input: 30, output: 8 };

async function messages(stack: Stack, groupId: string) {
  return MessageListResponse.parse(await stack.get(`/api/groups/${groupId}/messages`));
}

function cutOn(stackRef: { current?: Stack }, type: UplinkFrame["body"]["type"]) {
  let cut = false;
  let signal!: () => void;
  const injected = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return {
    injected,
    beforeReliableSend: (frame: UplinkFrame) => {
      if (!cut && frame.body.type === type) {
        cut = true;
        stackRef.current?.cutAgentLink();
        signal();
      }
    },
  };
}

it("断线发生在 approval_request fsync 后：重连后审批卡只落一张", async () => {
  const upstream = await startUpstream((request: ChatRequest): ScriptedTurn => {
    if (isFollowUpTurn(request)) return { textChunks: ["等待审批"], usage };
    return {
      textChunks: [],
      toolCall: {
        id: "approval-tool",
        name: "bash",
        args: { command: "echo envelope > /tmp/baize-envelope-approval.txt" },
      },
      usage,
    };
  });
  let stack: Stack | undefined;
  const stackRef: { current?: Stack } = {};
  const injection = cutOn(stackRef, "approval_request");
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      cuttableAgentLink: true,
      beforeReliableSend: injection.beforeReliableSend,
    });
    stackRef.current = stack;
    const bot = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === "小服");
    if (bot === undefined) throw new Error("seed 没建出小服");
    await stack.post(`/api/groups/${bot.groupId}/messages`, { text: "执行需要审批的写入" });
    await injection.injected;
    stack.restoreAgentLink();
    await expect.poll(async () => (await messages(stack!, bot.groupId)).approvals.length, poll).toBe(1);
    const page = await messages(stack, bot.groupId);
    expect(page.approvals).toHaveLength(1);
    expect(page.approvals[0]?.status).toBe("pending");
  } finally {
    await stack?.close();
    await upstream.close();
  }
});

it("断线发生在 handoff fsync 后：重连后交接卡只落一张", async () => {
  const upstream = await startUpstream((request: ChatRequest): ScriptedTurn => {
    if (isFollowUpTurn(request)) return { textChunks: ["交接已提交"], usage };
    return {
      textChunks: [],
      toolCall: {
        id: "handoff-tool",
        name: "handoff_task",
        args: { to: "小采", done: "已整理需求", notDone: "尚未询价", next: "开始询价" },
      },
      usage,
    };
  });
  let stack: Stack | undefined;
  const stackRef: { current?: Stack } = {};
  const injection = cutOn(stackRef, "handoff");
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      cuttableAgentLink: true,
      beforeReliableSend: injection.beforeReliableSend,
    });
    stackRef.current = stack;
    const bots = BotListResponse.parse(await stack.get("/api/bots")).items;
    const source = bots.find((item) => item.bot.name === "小服")?.bot;
    const target = bots.find((item) => item.bot.name === "小采")?.bot;
    if (source === undefined || target === undefined) throw new Error("seed 缺少小服或小采");
    const { group } = CreateGroupResponse.parse(
      await stack.post("/api/groups", {
        title: "信封交接验收",
        botIds: [source.id, target.id],
      }),
    );
    await stack.post(`/api/groups/${group.id}/messages`, { text: "@小服 整理后交给小采" });
    await injection.injected;
    stack.restoreAgentLink();
    await expect.poll(async () => (await messages(stack!, group.id)).handoffs.length, poll).toBe(1);
    expect((await messages(stack, group.id)).handoffs).toHaveLength(1);
  } finally {
    await stack?.close();
    await upstream.close();
  }
});

it("断线发生在 publish_result fsync 后：重连后失败发布结果只结算一次", async () => {
  let accountId: string | undefined;
  const upstream = await startUpstream((request: ChatRequest): ScriptedTurn => {
    const asked = request.messages.some(
      (message) => message.role === "user" && JSON.stringify(message.content).includes("起草验收帖"),
    );
    if (!asked || accountId === undefined || isFollowUpTurn(request)) return { textChunks: ["收到"], usage };
    return {
      textChunks: [],
      toolCall: {
        id: "draft-tool",
        name: "create_draft",
        args: {
          accountId,
          content: { kind: "post", title: "信封验收", text: "只在本地验证失败补发" },
        },
      },
      usage,
    };
  });
  let stack: Stack | undefined;
  const stackRef: { current?: Stack } = {};
  const injection = cutOn(stackRef, "publish_result");
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      cuttableAgentLink: true,
      startComputer: false,
      beforeReliableSend: injection.beforeReliableSend,
      makeChrome: () => ({
        kind: "local",
        profileDir: "/tmp/baize-envelope-no-chrome",
        connection: () => Promise.reject(new Error("验收禁止连接真实平台或 Chrome")),
        onExit: () => () => {},
        reveal: async () => {},
        conceal: async () => {},
        pid: () => null,
        stop: async () => {},
      }),
    });
    stackRef.current = stack;
    accountId = (await stack.addAccount({ platform: "xiaohongshu", handle: "e2e-envelope", token: "not-used" })).id;
    await stack.startComputer();
    const bot = BotListResponse.parse(await stack.get("/api/bots")).items[0];
    if (bot === undefined) throw new Error("seed 没建出 Bot");
    await stack.post(`/api/groups/${bot.groupId}/messages`, { text: "起草验收帖" });
    let draft = (await messages(stack, bot.groupId)).drafts[0];
    await expect.poll(async () => (await messages(stack!, bot.groupId)).drafts.length, poll).toBe(1);
    draft = (await messages(stack, bot.groupId)).drafts[0];
    if (draft === undefined) throw new Error("没收到草稿");
    await stack.post(`/api/drafts/${draft.id}`, { decision: "approve" });
    const publishing = stack.publishTick();
    await injection.injected;
    stack.restoreAgentLink();
    await publishing;
    await expect.poll(async () => (await messages(stack!, bot.groupId)).drafts[0]?.status, poll).toBe("failed");
    const page = await messages(stack, bot.groupId);
    expect(page.drafts.filter((item) => item.id === draft?.id)).toHaveLength(1);
    expect(page.drafts.find((item) => item.id === draft?.id)?.status).toBe("failed");
    expect(page.publications.filter((item) => item.draftId === draft?.id)).toHaveLength(0);
  } finally {
    await stack?.close();
    await upstream.close();
  }
});
