import { describe, expect, it, vi } from "vitest";
import { BotListResponse, MessageListResponse, ToolListResponse, ToolResponse } from "@baize/shared";
import { startTestMcp, type McpCall, type TestMcp } from "../src/mcp.js";
import { startStack, type Stack } from "../src/stack.js";
import { isFollowUpTurn, startUpstream, type ScriptedTurn } from "../src/upstream.js";

const POLL = { timeout: 30_000, interval: 25 };
const USAGE = { input: 120, output: 20 };
const AUTHORIZATION = "Bearer e2e-token";
const EMAIL_ARGS = { to: "lisa@example.com", subject: "报价", body: "请确认报价" };

type RunRow = { readonly ended_at: Date | null };

async function withStack(
  script: Parameters<typeof startUpstream>[0],
  test: (stack: Stack, mcp: TestMcp) => Promise<void>,
): Promise<void> {
  const mcp = await startTestMcp();
  const upstream = await startUpstream(script);
  let stack: Stack | undefined;
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
    });
    await test(stack, mcp);
  } finally {
    await stack?.close();
    await upstream.close();
    await mcp.close();
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

async function runs(stack: Stack, groupId: string): Promise<RunRow[]> {
  return stack.sql<RunRow[]>`SELECT ended_at FROM runs WHERE group_id = ${groupId}`;
}

async function waitForRunEnd(stack: Stack, groupId: string): Promise<void> {
  await expect
    .poll(async () => {
      const stored = await runs(stack, groupId);
      return stored.length > 0 && stored.every((run) => run.ended_at !== null);
    }, POLL)
    .toBe(true);
}

async function connectTool(stack: Stack, mcp: TestMcp, assignedBotId?: string) {
  const created = ToolResponse.parse(
    await stack.post("/api/tools", {
      name: "邮箱",
      url: mcp.baseUrl,
      authorization: AUTHORIZATION,
      localOnly: false,
    }),
  ).tool;
  if (assignedBotId === undefined) return created;
  return ToolResponse.parse(await stack.patch(`/api/tools/${created.id}`, { assignedBotIds: [assignedBotId] })).tool;
}

function toolCallMessages(
  stored: Awaited<ReturnType<typeof messages>>,
): { readonly tool: string; readonly status: string }[] {
  return stored.messages.flatMap((message) =>
    message.body.kind === "tool_call" ? [{ tool: message.body.tool, status: message.body.status }] : [],
  );
}

function callTurn(name: string, args: Record<string, unknown>): ScriptedTurn {
  return {
    textChunks: [],
    toolCall: { id: "call-1", name, args },
    usage: USAGE,
  };
}

function followUp(text: string): ScriptedTurn {
  return { textChunks: [text], usage: { input: 160, output: 24 } };
}

describe("端到端：MCP 工具连接、分配和审批", () => {
  it("只监听 127.0.0.1 的本机 MCP 由真电脑代理发现，initialize 从不来自控制面", async () => {
    await withStack(
      () => followUp("本机连接成功"),
      async (stack, mcp) => {
        const tool = ToolResponse.parse(
          await stack.post("/api/tools", {
            name: "本机工具",
            url: mcp.baseUrl,
            authorization: AUTHORIZATION,
            localOnly: true,
          }),
        ).tool;
        expect(tool.localOnly).toBe(true);
        expect(tool.operations.map((operation) => operation.name)).toEqual(["send_email", "lookup_stock"]);
        expect(ToolListResponse.parse(await stack.get("/api/tools")).items).toEqual([tool]);
        expect(mcp.clientNames()).toEqual(["baize-bot-runner"]);
        expect(mcp.clientNames()).not.toContain("baize-control-plane");
      },
    );
  });
  it("连接 MCP 后发现两条操作，并按只读注解决定默认审批", async () => {
    await withStack(
      () => followUp("连接成功"),
      async (stack, mcp) => {
        const tool = await connectTool(stack, mcp);
        expect(tool.operations).toHaveLength(2);
        expect(
          tool.operations.map((operation) => ({ name: operation.name, needsApproval: operation.needsApproval })),
        ).toEqual([
          { name: "send_email", needsApproval: true },
          { name: "lookup_stock", needsApproval: false },
        ]);
      },
    );
  });

  it("未分配给 Bot 时，模型点 send_email 不会调用 MCP", async () => {
    await withStack(
      (request) => (isFollowUpTurn(request) ? followUp("工具结果已处理") : callTurn("send_email", EMAIL_ARGS)),
      async (stack, mcp) => {
        await connectTool(stack, mcp);
        const { groupId } = await serviceBot(stack);
        await stack.post(`/api/groups/${groupId}/messages`, { text: "请发确认邮件" });

        await waitForRunEnd(stack, groupId);
        const stored = await messages(stack, groupId);
        const sendEmailCall = toolCallMessages(stored).find((call) => call.tool === "send_email");
        expect(sendEmailCall, "未分配工具时模型点 send_email 应留下 failed 卡").toEqual({
          tool: "send_email",
          status: "failed",
        });
        expect(mcp.calls()).toEqual([]);
      },
    );
  });

  it("分配给 Bot 后 send_email 先等审批，批准后恰好调用一次并带上参数和授权头", async () => {
    await withStack(
      (request) =>
        isFollowUpTurn(request) ? followUp("你批准了，我已发送确认邮件") : callTurn("send_email", EMAIL_ARGS),
      async (stack, mcp) => {
        const { bot, groupId } = await serviceBot(stack);
        await connectTool(stack, mcp, bot.id);
        await stack.post(`/api/groups/${groupId}/messages`, { text: "请发确认邮件" });

        await expect
          .poll(
            async () =>
              (await messages(stack, groupId)).approvals.filter((approval) => approval.status === "pending").length,
            POLL,
          )
          .toBe(1);
        expect(mcp.calls()).toEqual([]);

        const pending = (await messages(stack, groupId)).approvals.find((approval) => approval.status === "pending");
        if (pending === undefined) throw new Error("审批卡已出现但没找到 pending 审批");
        await stack.post(`/api/approvals/${pending.id}`, { decision: "approved" });

        await expect.poll(() => mcp.calls().length, { ...POLL, timeout: 5_000 }).toBe(1);
        await waitForRunEnd(stack, groupId);
        expect(mcp.calls()).toEqual([
          { name: "send_email", args: EMAIL_ARGS, authorization: AUTHORIZATION },
        ] satisfies readonly McpCall[]);
        const stored = await messages(stack, groupId);
        expect(toolCallMessages(stored)).toContainEqual({ tool: "send_email", status: "ok" });
        expect(
          stored.messages.some((message) => message.body.kind === "bot" && message.body.text.includes("你批准了")),
        ).toBe(true);
      },
    );
  });

  it("非本机 lookup_stock 经真控制面代执行，群里不出现审批卡", async () => {
    await withStack(
      (request) => (isFollowUpTurn(request) ? followUp("X3 库存 120") : callTurn("lookup_stock", { sku: "X3" })),
      async (stack, mcp) => {
        const { bot, groupId } = await serviceBot(stack);
        const tool = await connectTool(stack, mcp, bot.id);
        expect(tool.localOnly).toBe(false);
        const fetchCalls = vi.spyOn(globalThis, "fetch");
        try {
          await stack.post(`/api/groups/${groupId}/messages`, { text: "查一下 X3 库存" });

          await expect.poll(() => mcp.calls().length, POLL).toBe(1);
          await waitForRunEnd(stack, groupId);
          const forwarded = fetchCalls.mock.calls.filter(
            ([input]) =>
              new URL(input instanceof Request ? input.url : String(input)).pathname === `/mcp-proxy/${tool.id}/call`,
          );
          expect(forwarded, "运行器必须先 POST 到真控制面的 MCP 代理").toHaveLength(1);
          expect(forwarded[0]?.[1]?.method).toBe("POST");
          expect(JSON.parse(String(forwarded[0]?.[1]?.body))).toEqual({
            botId: bot.id,
            tool: "lookup_stock",
            arguments: { sku: "X3" },
          });
          expect(mcp.calls()).toEqual([
            { name: "lookup_stock", args: { sku: "X3" }, authorization: AUTHORIZATION },
          ] satisfies readonly McpCall[]);
          const stored = await messages(stack, groupId);
          expect(stored.approvals).toEqual([]);
          expect(toolCallMessages(stored)).toContainEqual({ tool: "lookup_stock", status: "ok" });
        } finally {
          fetchCalls.mockRestore();
        }
      },
    );
  });
});
