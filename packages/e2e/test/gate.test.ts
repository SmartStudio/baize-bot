import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BotListResponse, BotResponse, GrantListResponse, MessageListResponse, type Approval } from "@baize/shared";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream, type ChatMessage, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

const POLL = { timeout: 30_000, interval: 25 };
const USAGE = { input: 120, output: 20 };
const SECRET = "BEGIN-FAKE-PRIVATE-KEY-p1-3";
const DOWNLOADED = "下载目录里的报价单";

// 闸门的禁区和 `~` 都按 homedir() 算，它读 HOME。电脑代理跑在本进程里，所以换 HOME 就换了它眼里的家目录。
let home: string;
let realHome: string | undefined;

beforeAll(() => {
  realHome = process.env["HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "p1-3-cp-home-")));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_rsa"), SECRET);
  mkdirSync(join(home, "Downloads"));
  writeFileSync(join(home, "Downloads", "a.txt"), DOWNLOADED);
  mkdirSync(join(home, "Documents"));
  process.env["HOME"] = home;
});

afterAll(() => {
  if (realHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = realHome;
  rmSync(home, { recursive: true, force: true });
});

type ToolCallScript = { readonly name: string; readonly args: Record<string, unknown> };

const textOf = (message: ChatMessage | undefined): string =>
  message === undefined ? "" : typeof message.content === "string" ? message.content : JSON.stringify(message.content);

/**
 * 按最后一条用户消息里的暗号出剧本。该暗号的第 n 个工具调用在第 n 轮发，调用都回来之后说一句话收尾。
 * 同一个群的会话会带着前面几轮，所以只看最后一条用户消息之后的工具结果数。
 */
function scripted(
  plays: Readonly<Record<string, readonly ToolCallScript[]>>,
  hold?: (marker: string, round: number) => Promise<void>,
) {
  const toolResults = new Map<string, string[]>();
  const script = async (request: ChatRequest): Promise<ScriptedTurn> => {
    const lastUser = request.messages.findLastIndex((message) => message.role === "user");
    const said = textOf(request.messages[lastUser]);
    // 运行器拼的 prompt 里带着群里前几条，当前这条排在最后，所以取位置最靠后的暗号。
    const marker = Object.keys(plays)
      .filter((candidate) => said.includes(candidate))
      .toSorted((left, right) => said.lastIndexOf(right) - said.lastIndexOf(left))[0];
    if (marker === undefined) return { textChunks: ["收到"], usage: USAGE };
    const results = request.messages.slice(lastUser + 1).filter((message) => message.role === "tool");
    toolResults.set(marker, results.map(textOf));
    await hold?.(marker, results.length);
    const call = plays[marker]?.[results.length];
    if (call === undefined) return { textChunks: [`${marker}做完了`], usage: USAGE };
    return { textChunks: [], toolCall: { id: `${marker}-${results.length}`, ...call }, usage: USAGE };
  };
  return { script, toolResults: (marker: string) => toolResults.get(marker) ?? [] };
}

async function withStack(
  script: Parameters<typeof startUpstream>[0],
  test: (stack: Stack, requests: () => readonly ChatRequest[]) => Promise<void>,
): Promise<void> {
  const upstream = await startUpstream(script);
  let stack: Stack | undefined;
  try {
    stack = await startStack({ upstreamBaseUrl: upstream.baseUrl, priceInputPerM: 3, priceOutputPerM: 15 });
    await test(stack, upstream.requests);
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

async function waitForRunEnd(stack: Stack, groupId: string): Promise<void> {
  await expect
    .poll(async () => {
      const stored = await stack.sql<
        { ended_at: Date | null }[]
      >`SELECT ended_at FROM runs WHERE group_id = ${groupId}`;
      return stored.length > 0 && stored.every((run) => run.ended_at !== null);
    }, POLL)
    .toBe(true);
}

async function pendingApproval(stack: Stack, groupId: string): Promise<Approval> {
  let found: Approval | undefined;
  await expect
    .poll(async () => {
      found = (await messages(stack, groupId)).approvals.find((approval) => approval.status === "pending");
      return found !== undefined;
    }, POLL)
    .toBe(true);
  if (found === undefined) throw new Error("没等到挂起的审批");
  return found;
}

async function toolCalls(stack: Stack, groupId: string) {
  return (await messages(stack, groupId)).messages.flatMap((message) =>
    message.body.kind === "tool_call" ? [{ tool: message.body.tool, status: message.body.status }] : [],
  );
}

describe("端到端：统一闸门和授权", () => {
  it("bash 在工作目录外写文件挂起等确认", async () => {
    const target = join(home, "Documents", "out.txt");
    const { script } = scripted({ 写文档: [{ name: "bash", args: { command: "echo hi > ~/Documents/out.txt" } }] });
    await withStack(script, async (stack) => {
      const { groupId } = await serviceBot(stack);
      await stack.post(`/api/groups/${groupId}/messages`, { text: "写文档" });

      const approval = await pendingApproval(stack, groupId);
      expect(approval.action).toBe("write_outside");
      expect(approval.target).toMatchObject({ kind: "path", prefix: target });
      expect(existsSync(target), "没批之前文件不能落地").toBe(false);

      await stack.post(`/api/approvals/${approval.id}`, { decision: "rejected" });
      await waitForRunEnd(stack, groupId);
      expect(existsSync(target), "拒绝之后也不落地").toBe(false);
    });
  });

  it("bash 读 ~/.ssh 被拒绝，授权了也被拒绝", async () => {
    const { script, toolResults } = scripted({
      偷钥匙: [{ name: "bash", args: { command: "cat ~/.ssh/id_rsa" } }],
      看家目录: [{ name: "bash", args: { command: "ls ~" } }],
      再偷: [{ name: "bash", args: { command: "cat ~/.ssh/id_rsa" } }],
    });
    await withStack(script, async (stack) => {
      const { groupId } = await serviceBot(stack);

      await stack.post(`/api/groups/${groupId}/messages`, { text: "偷钥匙" });
      await waitForRunEnd(stack, groupId);
      expect((await messages(stack, groupId)).approvals, "禁区直接拒，不出审批").toEqual([]);
      expect(toolResults("偷钥匙").join("")).not.toContain(SECRET);
      expect(toolResults("偷钥匙").join("")).toContain("禁区");

      await stack.post(`/api/groups/${groupId}/messages`, { text: "看家目录" });
      const approval = await pendingApproval(stack, groupId);
      expect(approval).toMatchObject({ action: "read", target: { kind: "path", prefix: home } });
      await stack.post(`/api/approvals/${approval.id}`, { decision: "approved", scope: "forever" });
      await waitForRunEnd(stack, groupId);
      expect(
        GrantListResponse.parse(await stack.get("/api/grants")).grants,
        "整个家目录的读授权真的落下了",
      ).toMatchObject([{ scope: "forever", action: "read", target: { kind: "path", prefix: home } }]);

      await stack.post(`/api/groups/${groupId}/messages`, { text: "再偷" });
      await waitForRunEnd(stack, groupId);
      expect(
        (await messages(stack, groupId)).approvals.filter((item) => item.status === "pending"),
        "授权盖住了禁区也不问",
      ).toEqual([]);
      expect(toolResults("再偷").join(""), "禁区排在授权前面").not.toContain(SECRET);
      expect(toolResults("再偷").join("")).toContain("禁区");
    });
  });

  it("给过 ~/Downloads 的读授权后，读那里的文件不再问", async () => {
    const { script, toolResults } = scripted({
      看下载: [{ name: "bash", args: { command: "ls ~/Downloads" } }],
      读报价: [{ name: "read", args: { path: join(home, "Downloads", "a.txt") } }],
    });
    await withStack(script, async (stack) => {
      const { groupId } = await serviceBot(stack);

      await stack.post(`/api/groups/${groupId}/messages`, { text: "看下载" });
      const approval = await pendingApproval(stack, groupId);
      expect(approval).toMatchObject({ action: "read", target: { prefix: join(home, "Downloads") } });
      await stack.post(`/api/approvals/${approval.id}`, { decision: "approved", scope: "project" });
      await waitForRunEnd(stack, groupId);
      expect(toolResults("看下载").join("")).toContain("a.txt");

      await stack.post(`/api/groups/${groupId}/messages`, { text: "读报价" });
      await waitForRunEnd(stack, groupId);
      expect((await messages(stack, groupId)).approvals, "读授权盖住了这个文件，不再出第二张卡").toHaveLength(1);
      expect(toolResults("读报价").join("")).toContain(DOWNLOADED);
    });
  });

  it("暂停时在跑的 run 挂在闸门，继续后做完，群里没有模型错误", async () => {
    const upstreamGate: { release?: () => void } = {};
    const held = new Promise<void>((resolve) => {
      upstreamGate.release = resolve;
    });
    const { script } = scripted(
      { 打个点: [{ name: "bash", args: { command: "echo 暂停点 > marker.txt" } }] },
      (_, round) => (round === 0 ? held : Promise.resolve()),
    );
    await withStack(script, async (stack, requests) => {
      const { bot, groupId } = await serviceBot(stack);
      const marker = join(stack.dataDir, bot.id, "work", "marker.txt");

      await stack.post(`/api/groups/${groupId}/messages`, { text: "打个点" });
      await expect.poll(() => requests().length, POLL).toBe(1);
      const paused = BotResponse.parse(await stack.post(`/api/bots/${bot.id}/pause`, {}));
      expect(paused.bot.runState).toBe("paused");
      upstreamGate.release?.();

      await expect
        .poll(async () => (await toolCalls(stack, groupId)).some((call) => call.status === "running"), POLL)
        .toBe(true);
      expect(existsSync(marker), "暂停着，工具停在闸门上没执行").toBe(false);
      expect(requests(), "工具没回结果，模型没被再问").toHaveLength(1);

      const resumed = BotResponse.parse(await stack.post(`/api/bots/${bot.id}/resume`, {}));
      expect(resumed.bot.runState).toBe("running");
      await waitForRunEnd(stack, groupId);

      expect(existsSync(marker), "继续之后工具真的跑了").toBe(true);
      expect(await toolCalls(stack, groupId)).toEqual([{ tool: "bash", status: "ok" }]);
      const stored = await messages(stack, groupId);
      expect(
        stored.messages.filter((message) => message.body.kind === "system" && message.body.tone === "error"),
        "暂停不是出错，群里不该有错误卡",
      ).toEqual([]);
      expect(
        stored.messages.some((message) => message.body.kind === "bot" && message.body.text.includes("打个点做完了")),
      ).toBe(true);
    });
  });

  it("断线期间点继续，重连后下发 resume，Bot 接着干活", async () => {
    const { script } = scripted({});
    await withStack(script, async (stack) => {
      const { bot, groupId } = await serviceBot(stack);
      expect(BotResponse.parse(await stack.post(`/api/bots/${bot.id}/pause`, {})).bot.runState).toBe("paused");

      // 探针用同一台电脑的身份 hello，把在进程里的真代理顶下线。代理进程和运行器都还在，运行器记得小服停着。
      const probe = await stack.connectComputer();
      await expect.poll(() => probe.frames().some((frame) => frame.type === "config"), POLL).toBe(true);
      expect(BotResponse.parse(await stack.post(`/api/bots/${bot.id}/resume`, {})).bot.runState).toBe("running");
      await expect
        .poll(() => probe.frames().some((frame) => frame.type === "resume" && frame.botId === bot.id), {
          ...POLL,
          message: "resume 落在探针上，真代理那一刻不在线，收不到",
        })
        .toBe(true);

      await expect.poll(() => probe.closed()?.code ?? null, POLL).toBe(4000);
      await stack.post(`/api/groups/${groupId}/messages`, { text: "继续之后还能干活吗" });
      await waitForRunEnd(stack, groupId);
      expect(
        (await messages(stack, groupId)).messages.some(
          (message) => message.body.kind === "bot" && message.body.text.includes("收到"),
        ),
        "真代理重连后拿到 resume，小服把这条活做完了",
      ).toBe(true);
    });
  });
});
