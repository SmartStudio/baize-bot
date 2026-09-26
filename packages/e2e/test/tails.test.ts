import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  BotListResponse,
  ComputerListResponse,
  CreateGroupResponse,
  GroupListResponse,
  GroupResponse,
  MessageListResponse,
  SendMessageResponse,
} from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import { isFollowUpTurn, startUpstream, type ScriptedTurn } from "../src/upstream.js";

const textTurn: ScriptedTurn = { textChunks: ["处理完成"], usage: { input: 20, output: 5 } };
const poll = { timeout: 10_000, interval: 25 };

function gate() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

async function withStack(
  script: Parameters<typeof startUpstream>[0],
  startComputer: boolean,
  run: (stack: Stack) => Promise<void>,
  options: { readonly disconnectGraceMs?: number; readonly agentProcess?: boolean } = {},
) {
  const upstream = await startUpstream(script);
  let stack: Stack | undefined;
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      startComputer,
      ...options,
    });
    await run(stack);
  } finally {
    await stack?.close();
    await upstream.close();
  }
}

async function serviceBot(stack: Stack) {
  const item = BotListResponse.parse(await stack.get("/api/bots")).items.find(
    (candidate) => candidate.bot.name === "小服",
  );
  if (item === undefined) throw new Error("seed 没建出小服");
  return item;
}

async function messages(stack: Stack, groupId: string) {
  return MessageListResponse.parse(await stack.get(`/api/groups/${groupId}/messages`));
}

async function runs(stack: Stack, groupId: string) {
  return stack.sql<{ id: string; trigger_message_id: string; ended_at: Date | null }[]>`
    SELECT id, trigger_message_id, ended_at FROM runs WHERE group_id = ${groupId}
  `;
}

it("离线留言只落 system、不建 run，重连不补派", async () => {
  await withStack(
    () => textTurn,
    false,
    async (stack) => {
      const { groupId } = await serviceBot(stack);
      const before = await messages(stack, groupId);
      const offline = SendMessageResponse.parse(
        await stack.post(`/api/groups/${groupId}/messages`, { text: "离线时留下这条消息" }),
      );
      await expect
        .poll(async () => (await messages(stack, groupId)).messages.length, poll)
        .toBe(before.messages.length + 2);
      expect((await messages(stack, groupId)).messages.slice(-2).map((message) => message.body)).toEqual([
        offline.message.body,
        { kind: "system", text: "电脑不在线，这条没派出去，电脑回来后再说一次", tone: "error" },
      ]);
      expect(await runs(stack, groupId), "离线留言不能创建 run").toHaveLength(0);

      await stack.startComputer();
      const online = SendMessageResponse.parse(
        await stack.post(`/api/groups/${groupId}/messages`, { text: "上线后只处理这条新消息" }),
      );
      await expect
        .poll(async () => (await runs(stack, groupId)).filter((run) => run.ended_at !== null).length, poll)
        .toBe(1);
      await delay(250);
      expect(
        stack.prompts().map((prompt) => prompt.text),
        "重连后仅新消息得到 prompt",
      ).toEqual(["上线后只处理这条新消息"]);
      const storedRuns = await runs(stack, groupId);
      expect(storedRuns, "完成新消息后仍不得为离线留言建 run").toHaveLength(1);
      expect(storedRuns[0]?.trigger_message_id).toBe(online.message.id);
    },
  );
});

it("工具调用后断连必须收尾 run 并在群里提示失败", async () => {
  const followUp = gate();
  let waitingForModel = false;
  await withStack(
    async (request) => {
      if (!isFollowUpTurn(request)) {
        return {
          textChunks: [],
          toolCall: { id: "disconnect-tool", name: "bash", args: { command: "pwd" } },
          usage: { input: 20, output: 5 },
        };
      }
      waitingForModel = true;
      await followUp.promise;
      return textTurn;
    },
    true,
    async (stack) => {
      let stopping: Promise<void> | undefined;
      try {
        const { groupId } = await serviceBot(stack);
        await stack.post(`/api/groups/${groupId}/messages`, { text: "查看工作目录" });
        await expect.poll(() => waitingForModel, poll).toBe(true);
        await expect
          .poll(
            async () =>
              (await messages(stack, groupId)).messages.some(
                (message) =>
                  message.body.kind === "tool_call" && message.body.tool === "bash" && message.body.status === "ok",
              ),
            poll,
          )
          .toBe(true);
        const before = await runs(stack, groupId);
        expect(before).toHaveLength(1);
        expect(before[0]?.ended_at, "工具已执行，模型下一轮尚未返回，run 仍在进行").toBeNull();

        // 进程被杀，运行器来不及发 run_done；模型闸门保持关闭，排除正常收尾。
        stopping = stack.killComputer();
        await expect
          .poll(async () => ComputerListResponse.parse(await stack.get("/api/computers")).computers[0]?.status, poll)
          .toBe("sleeping");
        await expect
          .poll(
            async () => {
              const storedRuns = await runs(stack, groupId);
              const stored = await messages(stack, groupId);
              return {
                ended: storedRuns.length === 1 && storedRuns[0]?.ended_at !== null,
                failureNotice: stored.messages.some(
                  (message) => message.body.kind === "system" && message.body.text === "电脑断过线，这次活没做完",
                ),
              };
            },
            { timeout: 2_000, interval: 50, message: "断连后不能留下未结束的 run，群里必须有失败提示" },
          )
          .toEqual({ ended: true, failureNotice: true });
      } finally {
        followUp.release();
        if (stopping !== undefined) {
          await expect
            .poll(async () => ComputerListResponse.parse(await stack.get("/api/computers")).computers[0]?.status, poll)
            .toBe("sleeping");
          await stopping;
        }
      }
    },
    { disconnectGraceMs: 100, agentProcess: true },
  );
});

it("同 token 新连接关闭旧连接，welcome/config/运行状态之后只向新连接派活", async () => {
  await withStack(
    () => textTurn,
    false,
    async (stack) => {
      const { groupId, bot } = await serviceBot(stack);
      const handshake = [
        "welcome",
        "config",
        ...BotListResponse.parse(await stack.get("/api/bots")).items.map(() => "resume"),
      ];
      const first = await stack.connectComputer();
      await expect.poll(() => first.frames().map((frame) => frame.type), poll).toEqual(handshake);
      const second = await stack.connectComputer();
      await expect.poll(() => second.frames().map((frame) => frame.type), poll).toEqual(handshake);
      await expect.poll(() => first.closed(), poll).toEqual({ code: 4000, reason: "同一台电脑有了新连接" });
      expect(
        ComputerListResponse.parse(await stack.get("/api/computers")).computers[0]?.status,
        "旧连接关闭不能把新连接标成休眠",
      ).toBe("online");

      await stack.post(`/api/groups/${groupId}/messages`, { text: "交给新的连接" });
      await expect.poll(() => second.frames().filter((frame) => frame.type === "prompt").length, poll).toBe(1);
      expect(second.frames().find((frame) => frame.type === "prompt")).toMatchObject({
        type: "prompt",
        groupId,
        botId: bot.id,
        text: "交给新的连接",
      });
      expect(
        first.frames().filter((frame) => frame.type === "prompt"),
        "旧连接不得收到后续派活",
      ).toHaveLength(0);
      expect(await runs(stack, groupId)).toHaveLength(1);
    },
  );
});

it("小服 handoff_task 到小采 accept_handoff，待接手计数和当前经手一致", async () => {
  const accept = gate();
  let recipientWaiting = false;
  await withStack(
    async (request) => {
      if (isFollowUpTurn(request)) return textTurn;
      const isRecipient = request.messages.some(
        (message) => message.role === "user" && JSON.stringify(message.content)?.includes("先调用 accept_handoff"),
      );
      if (isRecipient) {
        recipientWaiting = true;
        await accept.promise;
        return {
          textChunks: [],
          toolCall: { id: "accept-tool", name: "accept_handoff", args: {} },
          usage: { input: 20, output: 5 },
        };
      }
      return {
        textChunks: [],
        toolCall: {
          id: "handoff-tool",
          name: "handoff_task",
          args: { to: "小采", done: "需求已整理", notDone: "尚未询价", next: "向供应商询价" },
        },
        usage: { input: 20, output: 5 },
      };
    },
    true,
    async (stack) => {
      try {
        const bots = BotListResponse.parse(await stack.get("/api/bots")).items;
        const source = bots.find((item) => item.bot.name === "小服")?.bot;
        const target = bots.find((item) => item.bot.name === "小采")?.bot;
        if (source === undefined || target === undefined) throw new Error("seed 缺少小服或小采");
        const { group } = CreateGroupResponse.parse(
          await stack.post("/api/groups", {
            title: "采购交接",
            botIds: [source.id, target.id],
          }),
        );
        await stack.post(`/api/groups/${group.id}/messages`, { text: "@小服 整理需求后交给小采询价" });
        await expect.poll(() => stack.prompts().filter((prompt) => prompt.groupId === group.id).length, poll).toBe(2);
        const pending = await messages(stack, group.id);
        expect(pending.handoffs).toHaveLength(1);
        const handoff = pending.handoffs[0];
        if (handoff === undefined) throw new Error("交接记录未落库");
        expect(handoff).toMatchObject({
          fromBotId: source.id,
          toBotId: target.id,
          status: "pending",
          acceptedAt: null,
          done: "需求已整理",
          notDone: "尚未询价",
          next: "向供应商询价",
        });
        expect(
          pending.messages.filter((message) => message.body.kind === "handoff").map((message) => message.body),
        ).toEqual([{ kind: "handoff", handoffId: handoff.id }]);
        expect(
          GroupListResponse.parse(await stack.get("/api/groups")).items.find((item) => item.group.id === group.id)
            ?.pendingHandoffs,
        ).toBe(1);
        expect(
          GroupResponse.parse(await stack.get(`/api/groups/${group.id}`)).task.currentBotId,
          "确认前仍由小服经手",
        ).toBe(source.id);
        expect(
          stack
            .prompts()
            .filter((prompt) => prompt.groupId === group.id)
            .map((prompt) => ({ botId: prompt.botId, handoffId: prompt.handoffId })),
        ).toEqual([
          { botId: source.id, handoffId: undefined },
          { botId: target.id, handoffId: handoff.id },
        ]);

        await expect.poll(() => recipientWaiting, poll).toBe(true);
        accept.release();
        await expect.poll(async () => (await messages(stack, group.id)).handoffs[0]?.status, poll).toBe("accepted");
        await expect
          .poll(async () => GroupResponse.parse(await stack.get(`/api/groups/${group.id}`)).task.currentBotId, poll)
          .toBe(target.id);
        expect(
          GroupListResponse.parse(await stack.get("/api/groups")).items.find((item) => item.group.id === group.id)
            ?.pendingHandoffs,
        ).toBe(0);
        await expect
          .poll(async () => (await runs(stack, group.id)).filter((run) => run.ended_at !== null).length, poll)
          .toBe(2);
        const stored = await messages(stack, group.id);
        expect(stored.handoffs[0]?.acceptedAt).not.toBeNull();
        expect(
          stored.messages.flatMap((message) =>
            message.body.kind === "tool_call" ? [{ tool: message.body.tool, status: message.body.status }] : [],
          ),
        ).toEqual([
          { tool: "handoff_task", status: "ok" },
          { tool: "accept_handoff", status: "ok" },
        ]);
      } finally {
        accept.release();
      }
    },
  );
});
