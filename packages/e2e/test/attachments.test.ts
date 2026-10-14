import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BotListResponse,
  ComputerListResponse,
  ComputerTokenResponse,
  DecideDraftResponse,
  MessageListResponse,
  type AccountId,
  type AgentToControl,
  type Draft,
} from "@baize/shared";
import { createRunner, type PromptMessage } from "@baize/bot-runner";
import { startAgent, type AgentHandle } from "@baize/computer-agent";
import { startStack, type Stack } from "../src/stack.js";
import { isFollowUpTurn, startUpstream, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

const ASK = "起草跨电脑配图验收笔记";
const BROWSER_DISABLED = "附件已下载，验收禁止连接真实平台或 Chrome";
const USAGE = { input: 100, output: 10 };
const POLL = { timeout: 15_000, interval: 50 };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type PublishResult = Extract<AgentToControl, { type: "publish_result" }>;

async function draftPushed(stack: Stack): Promise<Draft> {
  for (;;) {
    const push = await stack.nextPush();
    if (push.type === "draft_updated") return push.draft;
  }
}

it("同一账号远程起草带图小红书草稿，本机发布前按附件下载同一份 PNG 字节", async () => {
  let accountId: AccountId | undefined;
  const upstream = await startUpstream((request: ChatRequest): ScriptedTurn => {
    const asked = request.messages.some(
      (message) => message.role === "user" && JSON.stringify(message.content).includes(ASK),
    );
    if (!asked || accountId === undefined || isFollowUpTurn(request)) {
      return { textChunks: ["草稿在等你批"], usage: USAGE };
    }
    return {
      textChunks: [],
      toolCall: {
        id: "attachment-draft",
        name: "create_draft",
        args: {
          accountId,
          content: {
            kind: "post",
            title: "跨电脑配图验收",
            text: "远程起草的图片在本机按附件取回",
            images: [{ path: "cover.png" }],
          },
        },
      },
      usage: USAGE,
    };
  });
  const remoteDataDir = mkdtempSync(join(tmpdir(), "e2e-attachments-remote-"));
  const sha256 = createHash("sha256").update(PNG).digest("hex");
  const remotePrompts: PromptMessage[] = [];
  const publishResults: PublishResult[] = [];
  let remoteConfigsApplied = 0;
  let remoteLog = "";
  let remoteBrowserConnections = 0;
  let localBrowserConnections = 0;
  let localCopyPath: string | undefined;
  let localCopyAtBrowser: Buffer | undefined;
  let stack: Stack | undefined;
  let remoteAgent: AgentHandle | undefined;
  try {
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      startComputer: false,
      beforeReliableSend: (frame) => {
        if (frame.body.type === "publish_result") publishResults.push(frame.body);
      },
      makeChrome: ({ dataDir }) => ({
        kind: "local",
        profileDir: join(dataDir, "chrome-profile"),
        connection: async () => {
          localBrowserConnections += 1;
          if (localCopyPath === undefined) throw new Error("验收没有设定本机配图路径");
          localCopyAtBrowser = await readFile(localCopyPath);
          throw new Error(BROWSER_DISABLED);
        },
        login: async () => ({ login: "failed", reason: "window_failed" }),
        pid: () => null,
        stop: async () => {},
      }),
    });
    const account = await stack.addAccount({
      platform: "xiaohongshu",
      handle: "e2e-attachments",
      token: "not-used",
    });
    accountId = account.id;
    const local = ComputerListResponse.parse(await stack.get("/api/computers")).computers.find(
      (computer) => computer.kind === "local",
    );
    if (local === undefined) throw new Error("seed 没建出本机电脑");
    expect(account.computerId, "小红书账号归本机，发布必须派给本机").toBe(local.id);

    const remote = ComputerTokenResponse.parse(await stack.post("/api/computers/remote", {}));
    remoteAgent = startAgent({
      url: `ws://127.0.0.1:${stack.port}/agent`,
      computerId: remote.computerId,
      token: remote.token,
      version: "0.1.0-e2e",
      dataDir: remoteDataDir,
      log: (line) => {
        remoteLog += `${line}\n`;
      },
      makeRunner: (config) => {
        const runner = createRunner(config);
        remoteConfigsApplied += 1;
        return {
          ...runner,
          applyConfig: async (next) => {
            await runner.applyConfig(next);
            remoteConfigsApplied += 1;
          },
          prompt: (message) => {
            remotePrompts.push(message);
            return runner.prompt(message);
          },
        };
      },
      makeChrome: () => ({
        kind: "remote",
        profileDir: join(remoteDataDir, "chrome-profile"),
        connection: async () => {
          remoteBrowserConnections += 1;
          throw new Error("远程起草不该连接浏览器");
        },
        login: async () => ({ login: "failed", reason: "remote_refused" }),
        pid: () => null,
        stop: async () => {},
      }),
    });
    await expect.poll(() => remoteConfigsApplied, POLL).toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          ComputerListResponse.parse(await stack!.get("/api/computers")).computers.find(
            (computer) => computer.id === remote.computerId,
          )?.status,
        POLL,
      )
      .toBe("online");
    const first = BotListResponse.parse(await stack.get("/api/bots")).items[0];
    if (first === undefined) throw new Error("seed 没建出 Bot");
    await mkdir(join(remoteDataDir, first.bot.id, "work"), { recursive: true });
    await writeFile(join(remoteDataDir, first.bot.id, "work", "cover.png"), PNG);
    localCopyPath = join(stack.dataDir, first.bot.id, "drafts", `${sha256}.png`);
    expect(existsSync(localCopyPath), "起草前本机没有远程电脑的配图拷贝").toBe(false);

    await stack.post(`/api/groups/${first.groupId}/messages`, { text: ASK });
    const created = await draftPushed(stack);
    expect(remotePrompts, "本机未上线，真实派活到远程电脑").toHaveLength(1);
    expect(stack.prompts()).toHaveLength(0);
    expect(created).toMatchObject({
      botId: first.bot.id,
      groupId: first.groupId,
      accountId,
      platform: "xiaohongshu",
      status: "pending",
      content: {
        kind: "post",
        images: [{ kind: "attachment", attachmentId: expect.any(String), sha256, mime: "image/png" }],
      },
    });
    expect(await readFile(join(remoteDataDir, first.bot.id, "drafts", `${sha256}.png`))).toEqual(PNG);
    expect(publishResults, "用户批准前没有发布结果，也没有连接浏览器").toEqual([]);
    expect(localBrowserConnections).toBe(0);
    expect(remoteBrowserConnections).toBe(0);

    await stack.startComputer();
    await expect.poll(() => stack!.configsApplied(), POLL).toBeGreaterThan(0);
    const computers = ComputerListResponse.parse(await stack.get("/api/computers")).computers;
    expect(
      computers.map((computer) => computer.ownerId),
      "两台电脑属于同一个账号",
    ).toEqual([account.ownerId, account.ownerId]);
    expect(computers.map((computer) => computer.status)).toEqual(["online", "online"]);
    expect(existsSync(localCopyPath), "本机上线不会顺手复制远程草稿配图").toBe(false);
    const decided = DecideDraftResponse.parse(await stack.post(`/api/drafts/${created.id}`, { decision: "approve" }));
    expect(decided.draft.status).toBe("approved");
    await stack.publishTick();

    await expect.poll(() => publishResults.length, POLL).toBe(1);
    expect(publishResults[0]).toMatchObject({
      draftId: created.id,
      result: { status: "failed", reason: "error", detail: `发布出错：${BROWSER_DISABLED}` },
    });
    expect(localBrowserConnections, "配图下载并校验后才进入本机发布器的浏览器连接").toBe(1);
    expect(localCopyAtBrowser).toEqual(PNG);
    expect(await readFile(localCopyPath)).toEqual(PNG);
    expect(remoteBrowserConnections, "发布没有派回起草的远程电脑").toBe(0);
    await expect
      .poll(
        async () =>
          MessageListResponse.parse(await stack!.get(`/api/groups/${first.groupId}/messages`)).drafts.find(
            (draft) => draft.id === created.id,
          )?.status,
        POLL,
      )
      .toBe("failed");
    const page = MessageListResponse.parse(await stack.get(`/api/groups/${first.groupId}/messages`));
    expect(page.publications).toHaveLength(0);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n远程电脑代理日志：\n${remoteLog}\n本机电脑代理日志：\n${stack?.agentLog() ?? "尚未启动"}`,
      { cause: error },
    );
  } finally {
    await remoteAgent?.stop();
    await stack?.close();
    await upstream.close();
    rmSync(remoteDataDir, { recursive: true, force: true });
  }
});
