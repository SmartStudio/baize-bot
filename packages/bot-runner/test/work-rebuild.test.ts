import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_WORK_HEAD, BotId, ComputerId, GroupId, MessageId, RunId, type HubLaneSnapshot } from "@baize/shared";
import { createRetainer } from "@baize/shared/work-record";
import { afterEach, expect, it, vi } from "vitest";
import { createRunner, type Runner, type RunnerConfig, type PromptMessage } from "../src/index.js";
import { startGateway } from "./fixtures/gateway.js";
import { scriptedUpstream } from "./fixtures/openai-sse.js";
import { startWorkHub } from "./helpers/work-hub.js";
import { WorkMirror } from "../src/work-mirror.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const botId = BotId.parse("bot-rebuild");
const groupId = GroupId.parse("group-rebuild");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const done of cleanup.splice(0).toReversed()) await done();
});

it("Hub 快照原始行和链头不符时拒绝重建", async () => {
  const root = mkdtempSync(join(tmpdir(), "baize-invalid-hub-head-"));
  cleanup.unshift(async () => {
    rmSync(root, { recursive: true, force: true });
  });
  const source = SessionManager.inMemory(root);
  source.appendMessage({ role: "user", content: "服务器原文", timestamp: 1 });
  const line = JSON.stringify(source.getEntries()[0]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ entries: [{ seq: 0, line }], nextSeq: 1, head: "f".repeat(64), piSessionVersion: 3 }),
      { status: 200 },
    ),
  );
  const mirror = new WorkMirror({
    botId,
    groupId,
    stream: "chat",
    groupDir: join(root, "sessions"),
    sessionDir: join(root, "sessions"),
    workDir: root,
    append: () => async () => ({ kind: "ok" }),
    live: () => ({
      hub: { baseUrl: "http://hub.test" },
      gateway: { apiKey: "fake-key" },
      localOnlyToolNames: new Set(),
    }),
    log: () => {},
    cold: () => {
      throw new Error("损坏的链不能冷启动掩盖");
    },
  });
  await expect(mirror.prepare(2, { seq: 1, head: "f".repeat(64) }, RunId.parse("bad-head"))).rejects.toThrow(
    "服务器记录链头不一致",
  );
});

async function records() {
  const hub = await startWorkHub();
  cleanup.push(hub.close);
  return hub;
}

function prompt(text: string, snapshot?: HubLaneSnapshot): PromptMessage {
  return {
    type: "prompt",
    runId: RunId.parse(`run-${text}`),
    botId,
    groupId,
    messageId: MessageId.parse(`message-${text}`),
    text,
    origin: { kind: "user" },
    reason: "solo",
    group: { id: groupId, title: "重建", number: "", kind: "solo" },
    context: [],
    members: [{ id: botId, name: "记录员", tags: [], description: "", seat: "member" }],
    task: null,
    routine: null,
    table: null,
    purpose: "plan",
    lane: { epoch: 1, heads: snapshot === undefined ? {} : { chat: { seq: snapshot.nextSeq, head: snapshot.head } } },
  };
}

it("删掉本地会话目录后重建，下一次上游请求体和原会话会发的逐字节相同", async () => {
  const hub = await records();
  const gateway = await startGateway({
    upstream: scriptedUpstream(() => ({ textChunks: ["记录完成"], usage: { input: 20, output: 5 } })),
    models: [{ id: "fake" }],
  });
  cleanup.push(() => gateway.close());
  const dataDir = mkdtempSync(join(tmpdir(), "baize-request-equivalence-"));
  cleanup.unshift(async () => {
    rmSync(dataDir, { recursive: true, force: true });
  });
  const config: RunnerConfig = {
    computerId: ComputerId.parse("computer-rebuild"),
    computerKind: "local",
    bots: [{ id: botId, name: "记录员", role: "member", preset: null, tags: [], description: "" }],
    tools: [],
    accounts: [],
    grants: [],
    brand: null,
    preferences: [],
    modelGateway: { baseUrl: gateway.baseUrl, apiKey: "fake-key" },
    mcpProxy: { baseUrl: hub.baseUrl },
    hub: { baseUrl: hub.baseUrl },
    accountsProxy: { baseUrl: hub.baseUrl },
    dataDir,
    workAppend: hub.append,
    send: () => {},
  };
  let runner: Runner = createRunner(config);
  cleanup.push(async () => runner.stop());
  await runner.prompt(prompt("第一轮"));
  await runner.prompt(prompt("第二轮", await hub.snapshot()));
  const before = await hub.snapshot();
  await runner.prompt(prompt("第三轮", before));
  const expected = gateway.rawRequests.at(-1);
  expect(expected).toBeDefined();
  await runner.stop();
  hub.reset(before.entries.map((entry) => entry.line));
  rmSync(join(dataDir, botId, "sessions"), { recursive: true, force: true });
  runner = createRunner(config);
  await runner.prompt(prompt("第三轮", before));
  expect(gateway.rawRequests.at(-1)).toBe(expected);
  expect(gateway.rawRequests).toHaveLength(4);
});

it("含截图和超长输出的服务器重建，与原条目逐条留存过滤后的结果相同", async () => {
  const hub = await records();
  const root = mkdtempSync(join(tmpdir(), "baize-retained-equivalence-"));
  cleanup.unshift(async () => {
    rmSync(root, { recursive: true, force: true });
  });
  const source = SessionManager.inMemory(root);
  source.appendMessage({ role: "user", content: [{ type: "text", text: "保留签名与用量" }], timestamp: 1 });
  source.appendMessage({
    role: "toolResult",
    toolCallId: "call-image",
    toolName: "screenshot",
    content: [
      { type: "image", mimeType: "image/png", data: "sensitive-image" },
      { type: "text", text: "甲".repeat(20_000) },
    ],
    isError: false,
    timestamp: 2,
  });
  const retainer = createRetainer({ localOnlyToolNames: new Set() });
  const retained = source.getEntries().map((entry) => {
    const result = retainer.retain(JSON.stringify(entry));
    if (result.status !== "retained") throw new Error(result.reason);
    return result.line;
  });
  hub.reset(retained);
  const mirror = new WorkMirror({
    botId,
    groupId,
    stream: "chat",
    groupDir: join(root, "sessions"),
    sessionDir: join(root, "sessions"),
    workDir: root,
    append: () => hub.append,
    live: () => ({ hub: { baseUrl: hub.baseUrl }, gateway: { apiKey: "fake-key" }, localOnlyToolNames: new Set() }),
    log: () => {},
    cold: () => {
      throw new Error("不应冷启动");
    },
  });
  const snapshot = await hub.snapshot();
  const manager = await mirror.prepare(
    2,
    { seq: snapshot.nextSeq, head: snapshot.head },
    RunId.parse("rebuild-retained"),
  );
  expect(manager.getEntries().map((entry) => JSON.stringify(entry))).toEqual(retained);
  const file = manager.getSessionFile();
  expect(file).toBeDefined();
  expect(readFileSync(file!, "utf8").trim().split("\n").slice(1)).toEqual(retained);
  expect(readdirSync(join(root, "sessions"))).toContain("lane.json");
});

it("旧会话以当前代际导入两遍，服务器记录和本地文件逐字相同，原文件不删", async () => {
  const hub = await records();
  const root = mkdtempSync(join(tmpdir(), "baize-import-equivalence-"));
  cleanup.unshift(async () => {
    rmSync(root, { recursive: true, force: true });
  });
  const sessionDir = join(root, "sessions");
  const legacy = SessionManager.create(root, sessionDir);
  legacy.appendMessage({ role: "user", content: "旧会话仍在", timestamp: 1 });
  const oldFile = legacy.getSessionFile()!;
  const oldBytes = readFileSync(oldFile);
  const options = {
    botId,
    groupId,
    stream: "chat" as const,
    groupDir: sessionDir,
    sessionDir,
    workDir: root,
    append: () => hub.append,
    live: () => ({
      hub: { baseUrl: hub.baseUrl },
      gateway: { apiKey: "fake-key" },
      localOnlyToolNames: new Set<string>(),
    }),
    log: () => {},
    cold: () => {
      throw new Error("不应冷启动");
    },
  };
  const first = new WorkMirror(options);
  await first.prepare(3, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("import-first"));
  expect(hub.frames).toHaveLength(1);
  expect(hub.frames[0]).toMatchObject({ cause: "import", runId: null, lane: { epoch: 3 } });
  const snapshot = await hub.snapshot();
  const files = () =>
    Object.fromEntries(
      readdirSync(sessionDir)
        .toSorted()
        .map((name) => [name, readFileSync(join(sessionDir, name), "utf8")]),
    );
  const before = files();
  const second = new WorkMirror(options);
  await second.prepare(3, { seq: snapshot.nextSeq, head: snapshot.head }, RunId.parse("import-second"));
  expect(await hub.snapshot()).toEqual(snapshot);
  expect(files()).toEqual(before);
  expect(readFileSync(oldFile)).toEqual(oldBytes);
  expect(hub.frames).toHaveLength(1);
});

it("已确认的本地条目分叉后停止上传，下一个 prompt 按服务器重建并隔离分叉文件", async () => {
  const hub = await records();
  const root = mkdtempSync(join(tmpdir(), "baize-fork-rebuild-"));
  cleanup.unshift(async () => {
    rmSync(root, { recursive: true, force: true });
  });
  const sessionDir = join(root, "sessions");
  const mirror = new WorkMirror({
    botId,
    groupId,
    stream: "chat",
    groupDir: sessionDir,
    sessionDir,
    workDir: root,
    append: () => hub.append,
    live: () => ({ hub: { baseUrl: hub.baseUrl }, gateway: { apiKey: "fake-key" }, localOnlyToolNames: new Set() }),
    log: () => {},
    cold: () => {
      throw new Error("不应冷启动");
    },
  });
  const runId = RunId.parse("fork-run");
  const original = await mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, runId);
  original.appendMessage({ role: "user", content: "服务器事实", timestamp: 1 });
  expect(await mirror.flush("turn_end", runId)).toEqual({ kind: "ok" });
  const snapshot = await hub.snapshot();
  const file = original.getSessionFile()!;
  const forked = original.getEntries()[0]!;
  forked.id = "forked-id";
  writeFileSync(file, JSON.stringify(original.getHeader()) + "\n" + JSON.stringify(forked) + "\n");
  expect(await mirror.flush("turn_end", runId)).toEqual({ kind: "head_mismatch" });
  expect(await mirror.flush("settled", runId)).toEqual({ kind: "head_mismatch" });
  expect(hub.frames).toHaveLength(1);
  const restored = await mirror.prepare(1, { seq: snapshot.nextSeq, head: snapshot.head }, runId, original);
  expect(restored.getEntries().map((entry) => JSON.stringify(entry))).toEqual(
    snapshot.entries.map((entry) => entry.line),
  );
  const stale = readdirSync(join(sessionDir, ".stale"));
  expect(stale).toHaveLength(1);
  expect(readFileSync(join(sessionDir, ".stale", stale[0]!), "utf8")).toContain("forked-id");
});

it("本地条数和 id 相同但内容链头分叉时，prompt 必须重建服务器历史", async () => {
  const hub = await records();
  const root = mkdtempSync(join(tmpdir(), "baize-head-rebuild-"));
  cleanup.unshift(async () => {
    rmSync(root, { recursive: true, force: true });
  });
  const sessionDir = join(root, "sessions");
  const mirror = new WorkMirror({
    botId,
    groupId,
    stream: "chat",
    groupDir: sessionDir,
    sessionDir,
    workDir: root,
    append: () => hub.append,
    live: () => ({ hub: { baseUrl: hub.baseUrl }, gateway: { apiKey: "fake-key" }, localOnlyToolNames: new Set() }),
    log: () => {},
    cold: () => {
      throw new Error("不应冷启动");
    },
  });
  const runId = RunId.parse("head-run");
  const original = await mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, runId);
  original.appendMessage({ role: "user", content: "正确历史", timestamp: 1 });
  await mirror.flush("turn_end", runId);
  const snapshot = await hub.snapshot();
  const local = original.getEntries()[0]!;
  if (local.type !== "message" || local.message.role !== "user") throw new Error("未生成用户条目");
  local.message.content = "篡改历史";
  writeFileSync(original.getSessionFile()!, JSON.stringify(original.getHeader()) + "\n" + JSON.stringify(local) + "\n");
  const restored = await mirror.prepare(1, { seq: snapshot.nextSeq, head: snapshot.head }, runId, original);
  expect(restored.getEntries().map((entry) => JSON.stringify(entry))).toEqual(
    snapshot.entries.map((entry) => entry.line),
  );
  expect(readdirSync(join(sessionDir, ".stale"))).toHaveLength(1);
});
