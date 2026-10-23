import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_FRAME_MAX_BYTES,
  BotId,
  EMPTY_WORK_HEAD,
  GroupId,
  RunId,
  advanceWorkHead,
  type HubLaneSnapshot,
  type WorkAppend,
} from "@baize/shared";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkAppendOutcome } from "../src/lane-fence.js";
import { WorkMirror } from "../src/work-mirror.js";

const MiB = 1024 * 1024;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(
  append: (frame: WorkAppend) => Promise<WorkAppendOutcome>,
  options: { root?: string; groupDir?: string; sessionDir?: string; stream?: "chat" | "table" } = {},
) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "baize-work-mirror-"));
  if (options.root === undefined) roots.push(root);
  const workDir = join(root, "work");
  const sessionDir = options.sessionDir ?? join(root, "sessions");
  const groupDir = options.groupDir ?? join(root, "groups", "group-1");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(groupDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  let localOnlyToolNames: ReadonlySet<string> = new Set();
  const sent: WorkAppend[] = [];
  const logs: string[] = [];
  let coldStarts = 0;
  const mirror = new WorkMirror({
    botId: BotId.parse("bot-1"),
    groupId: GroupId.parse("group-1"),
    stream: options.stream ?? "chat",
    groupDir,
    sessionDir,
    workDir,
    append: () => async (frame) => {
      sent.push(frame);
      return append(frame);
    },
    live: () => ({
      hub: { baseUrl: "http://hub.test/hub/v1" },
      gateway: { apiKey: "fake-key" },
      localOnlyToolNames,
    }),
    log: (message) => logs.push(message),
    cold: () => {
      coldStarts += 1;
    },
  });
  return {
    mirror,
    sent,
    logs,
    workDir,
    sessionDir,
    groupDir,
    setLocalOnlyToolNames(names: readonly string[]) {
      localOnlyToolNames = new Set(names);
    },
    coldStarts: () => coldStarts,
  };
}

function appendUser(manager: SessionManager, content: string | Array<Record<string, unknown>>): void {
  appendRawMessage(manager, { role: "user", content, timestamp: Date.now() });
}

function appendRawMessage(manager: SessionManager, message: Record<string, unknown>): void {
  manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
}

function assistant(content: Array<Record<string, unknown>>, stopReason: string): Record<string, unknown> {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
    timestamp: 1,
  };
}

async function snapshot(lines: readonly string[]): Promise<HubLaneSnapshot> {
  return {
    entries: lines.map((line, seq) => ({ seq, line })),
    nextSeq: lines.length,
    head: await advanceWorkHead(EMPTY_WORK_HEAD, lines),
    piSessionVersion: null,
  };
}

function stubHub(result: HubLaneSnapshot): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(result), { status: 200 })),
  );
}

function holdNextDigest() {
  const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  let held = false;
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation((algorithm, data) => {
    if (held) return original(algorithm, data);
    held = true;
    const pending = new Promise<ArrayBuffer>((resolve, reject) => {
      release = () => {
        void original(algorithm, data).then(resolve, reject);
      };
    });
    started();
    return pending;
  });
  return { entered, release: () => release() };
}

describe("WorkMirror", () => {
  it("每帧最多 64 条并在上传前过滤图片、长文字和本机工具结果", async () => {
    const h = setup(async () => ({ kind: "ok" }));
    const manager = await h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-1"));
    for (let index = 0; index < 65; index += 1) appendUser(manager, `第 ${index} 条`);
    appendUser(manager, [{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }]);
    appendUser(manager, "长文字".repeat(5000));
    appendRawMessage(manager, {
      role: "toolResult",
      toolCallId: "call-local",
      toolName: "local_secret",
      content: [{ type: "text", text: "LOCAL_SECRET_OUTPUT" }],
      isError: false,
      timestamp: Date.now(),
    });
    h.setLocalOnlyToolNames(["local_secret"]);

    await expect(h.mirror.flush("turn_end", RunId.parse("run-1"))).resolves.toEqual({ kind: "ok" });

    expect(h.sent.length).toBe(2);
    expect(h.sent.every((frame) => frame.lines.length <= 64)).toBe(true);
    const uploaded = h.sent.flatMap((frame) => frame.lines).join("\n");
    expect(uploaded).toContain("（之前的截图已省略）");
    expect(uploaded).toContain("整段 sha256=");
    expect(uploaded).toContain("[本机工具结果，原文未上传 tool=local_secret");
    expect(uploaded).not.toContain("PRIVATE_IMAGE");
    expect(uploaded).not.toContain("LOCAL_SECRET_OUTPUT");
  });

  it.each([
    ["截断服务器前缀", true],
    ["不截断服务器前缀", false],
  ] as const)("tool_list_changed：%s 后用最新工具名单复查并补传", async (_name, truncate) => {
    let rejectionSent = false;
    let accepted: string[] = [];
    let retryStartsAt = Number.POSITIVE_INFINITY;
    const h = setup(async (frame) => {
      if (!rejectionSent && frame.cause === "turn_end" && frame.fromSeq > 0) {
        rejectionSent = true;
        accepted = truncate ? accepted.slice(0, 1) : accepted;
        const server = await snapshot(accepted);
        stubHub(server);
        retryStartsAt = h.sent.length;
        return {
          kind: "invalid",
          reason: "tool_list_changed",
          nextSeq: server.nextSeq,
          head: server.head,
        };
      }
      accepted = [...accepted, ...frame.lines];
      return { kind: "ok" };
    });
    const manager = await h.mirror.prepare(2, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-2"));
    appendUser(manager, "前缀消息");
    if (truncate) {
      appendRawMessage(manager, {
        role: "toolResult",
        toolCallId: "call-old",
        toolName: "local_secret",
        content: [{ type: "text", text: "OLD_SECRET" }],
        isError: false,
        timestamp: Date.now(),
      });
    }
    await h.mirror.flush("turn_end", RunId.parse("run-2"));
    if (!truncate) appendUser(manager, "已提交前缀");
    const oldUploaded = h.sent.reduce((count, frame) => count + frame.lines.length, 0);
    appendUser(manager, "待补传");
    h.setLocalOnlyToolNames(["local_secret"]);

    await expect(h.mirror.flush("turn_end", RunId.parse("run-2"))).resolves.toEqual({ kind: "ok" });

    expect(h.sent.some((frame) => frame.fromSeq === oldUploaded)).toBe(true);
    const retried = h.sent
      .slice(retryStartsAt)
      .flatMap((frame) => frame.lines)
      .join("\n");
    expect(retried).not.toContain("OLD_SECRET");
    if (truncate) expect(retried).toContain("[本机工具结果，原文未上传 tool=local_secret");
  });

  it("unfiltered 按最新工具名单重新过滤后只恢复一次，重复拒绝后停止", async () => {
    let calls = 0;
    let h: ReturnType<typeof setup>;
    h = setup(async () => {
      calls += 1;
      if (calls === 1) h.setLocalOnlyToolNames(["local_secret"]);
      return { kind: "invalid", reason: "unfiltered" };
    });
    const manager = await h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-3"));
    appendRawMessage(manager, {
      role: "toolResult",
      toolCallId: "call-local",
      toolName: "local_secret",
      content: [{ type: "text", text: "LOCAL_SECRET_OUTPUT" }],
      isError: false,
      timestamp: Date.now(),
    });

    await expect(h.mirror.flush("turn_end", RunId.parse("run-3"))).resolves.toEqual({
      kind: "invalid",
      reason: "unfiltered",
    });
    await expect(h.mirror.flush("turn_end", RunId.parse("run-3"))).resolves.toEqual({
      kind: "invalid",
      reason: "unfiltered",
    });
    expect(calls).toBe(2);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]?.lines).not.toEqual(h.sent[1]?.lines);
    expect(h.sent[0]?.lines.join("\n")).toContain("LOCAL_SECRET_OUTPUT");
    expect(h.sent[1]?.lines.join("\n")).not.toContain("LOCAL_SECRET_OUTPUT");
    expect(h.sent[1]?.lines.join("\n")).toContain("[本机工具结果，原文未上传 tool=local_secret");
  });

  it("unfiltered 复查没有改变帧时直接停止，不重发同一帧", async () => {
    let calls = 0;
    const h = setup(async () => {
      calls += 1;
      return { kind: "invalid", reason: "unfiltered" };
    });
    const manager = await h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-3-same"));
    appendUser(manager, "帧内容保持不变");

    await expect(h.mirror.flush("turn_end", RunId.parse("run-3-same"))).resolves.toEqual({
      kind: "invalid",
      reason: "unfiltered",
    });

    expect(calls).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it("seq_mismatch 拉取并核对 Hub 前缀后对齐重传，stale_epoch 不重发", async () => {
    const h = setup(async () => {
      stubHub(await snapshot([]));
      return h.sent.length === 1 ? { kind: "seq_mismatch", nextSeq: 0 } : { kind: "ok" };
    });
    const manager = await h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-4"));
    appendUser(manager, "按服务器游标重传");
    await expect(h.mirror.flush("turn_end", RunId.parse("run-4"))).resolves.toEqual({ kind: "ok" });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.fromSeq).toBe(0);

    appendUser(manager, "过期代际不重发");
    const callsBeforeStale = h.sent.length;
    const stale = setup(async () => ({ kind: "stale_epoch" }));
    const staleManager = await stale.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-5"));
    appendUser(staleManager, "过期");
    await expect(stale.mirror.flush("turn_end", RunId.parse("run-5"))).resolves.toEqual({ kind: "stale_epoch" });
    await stale.mirror.flush("turn_end", RunId.parse("run-5"));
    expect(stale.sent).toHaveLength(1);
    expect(h.sent.length).toBe(callsBeforeStale);
  });

  it("import 遇到 seq_mismatch 只发送一次，后续 prepare 不重试导入", async () => {
    let attempts = 0;
    const h = setup(async () => {
      if (++attempts > 2) throw new Error("重复导入被测试上限截住");
      return { kind: "seq_mismatch", nextSeq: 0 };
    });
    const legacy = SessionManager.create(h.workDir, h.sessionDir);
    appendUser(legacy, "旧会话内容");

    await expect(h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-import"))).rejects.toThrow(
      "旧会话导入停止",
    );
    expect(h.sent).toHaveLength(1);
    stubHub(await snapshot([]));
    await expect(
      h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-import-next")),
    ).rejects.toThrow("旧会话导入已停止");
    expect(h.sent).toHaveLength(1);
  });

  it("重建服务器尾部的悬空 toolCall 并上传合成 toolResult", async () => {
    const source = SessionManager.inMemory("/tmp/work-mirror-source");
    appendRawMessage(source, {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-hanging", name: "send_email", arguments: { to: "x@example.com" } }],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: "toolUse",
      timestamp: 1,
    });
    const line = JSON.stringify(source.getEntries()[0]);
    stubHub(await snapshot([line]));
    const h = setup(async () => ({ kind: "ok" }));

    const manager = await h.mirror.prepare(
      3,
      { seq: 1, head: (await snapshot([line])).head },
      RunId.parse("run-rebuild"),
    );

    const toolResult = manager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    expect(toolResult).toMatchObject({
      type: "message",
      message: { role: "toolResult", toolCallId: "call-hanging", isError: true },
    });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.cause).toBe("settled");
    expect(h.sent[0]?.lines.join("\n")).toContain("结果未知，上一台电脑在这一步断开了");
  });

  it("只补服务器尾部那一步的悬空 toolCall，更早被新消息作废的调用不在末尾补结果", async () => {
    const source = SessionManager.inMemory("/tmp/work-mirror-source");
    appendRawMessage(
      source,
      assistant(
        [
          { type: "toolCall", id: "call-done", name: "bash", arguments: {} },
          { type: "toolCall", id: "call-dropped", name: "bash", arguments: {} },
        ],
        "toolUse",
      ),
    );
    appendRawMessage(source, {
      role: "toolResult",
      toolCallId: "call-done",
      toolName: "bash",
      content: [{ type: "text", text: "用户发了新消息，这一步作废了。" }],
      isError: true,
      timestamp: 2,
    });
    appendRawMessage(source, assistant([], "aborted"));
    appendUser(source, "换个问题");
    appendRawMessage(source, assistant([{ type: "text", text: "好的" }], "stop"));
    appendUser(source, "再换一个");
    appendRawMessage(
      source,
      assistant([{ type: "toolCall", id: "call-partial", name: "bash", arguments: {} }], "aborted"),
    );
    const lines = source.getEntries().map((entry) => JSON.stringify(entry));
    stubHub(await snapshot(lines));
    const h = setup(async () => ({ kind: "ok" }));

    const manager = await h.mirror.prepare(
      3,
      { seq: lines.length, head: (await snapshot(lines)).head },
      RunId.parse("run-rebuild"),
    );

    expect(manager.getEntries()).toHaveLength(lines.length);
    expect(h.sent.flatMap((frame) => frame.lines).join("\n")).not.toContain("结果未知");
  });

  it("服务器记录无法打开文件时降级到内存恢复", async () => {
    const source = SessionManager.inMemory("/tmp/work-mirror-source");
    appendUser(source, "Hub 历史");
    const line = JSON.stringify(source.getEntries()[0]);
    stubHub(await snapshot([line]));
    const h = setup(async () => ({ kind: "ok" }));
    const open = vi.spyOn(SessionManager, "open").mockImplementation(() => {
      throw new Error("模拟文件打开失败");
    });

    const manager = await h.mirror.prepare(
      3,
      { seq: 1, head: (await snapshot([line])).head },
      RunId.parse("run-memory"),
    );

    expect(open).toHaveBeenCalled();
    expect(manager.getEntries()).toHaveLength(1);
    expect(manager.getSessionFile()).toBeUndefined();
  });

  it("服务器记录版本比本机新时冷启动", async () => {
    const source = SessionManager.inMemory("/tmp/work-mirror-source");
    appendUser(source, "未来版本历史");
    const future = await snapshot([JSON.stringify(source.getEntries()[0])]);
    stubHub({ ...future, piSessionVersion: 999 });
    const h = setup(async () => ({ kind: "ok" }));

    const manager = await h.mirror.prepare(4, { seq: 1, head: future.head }, RunId.parse("run-future"));

    expect(h.coldStarts()).toBe(1);
    expect(manager.getEntries()).toEqual([]);
  });

  it("Hub 快照读取挂起时 invalidate 取消请求并拒绝 prepare", async () => {
    const source = SessionManager.inMemory("/tmp/work-mirror-source");
    appendUser(source, "需要重建的记录");
    const hubSnapshot = await snapshot([JSON.stringify(source.getEntries()[0])]);
    const h = setup(async () => ({ kind: "ok" }));
    let markStarted!: (signal: AbortSignal | undefined) => void;
    const started = new Promise<AbortSignal | undefined>((resolve) => {
      markStarted = resolve;
    });
    let releaseFetch!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        markStarted(init?.signal ?? undefined);
        return new Promise<Response>((resolve, reject) => {
          releaseFetch = () => resolve(new Response(JSON.stringify(hubSnapshot), { status: 200 }));
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Hub read aborted", "AbortError")), {
            once: true,
          });
        });
      }),
    );

    const preparing = h.mirror.prepare(1, { seq: 1, head: hubSnapshot.head }, RunId.parse("run-invalidate"));
    const signal = await started;
    h.mirror.invalidate();
    releaseFetch();

    await expect(preparing).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("多帧旧会话导入断线后核对 Hub 前缀并从下一序号续传，保留旧文件", async () => {
    let calls = 0;
    let committed: string[] = [];
    const h = setup(async (frame) => {
      calls += 1;
      if (calls === 1) {
        committed = [...frame.lines];
        return { kind: "ok" };
      }
      if (calls === 2) return { kind: "disconnected" };
      return { kind: "ok" };
    });
    const legacy = SessionManager.create(h.workDir, h.sessionDir);
    for (let index = 0; index < 65; index += 1) appendUser(legacy, `旧会话 ${index}`);
    const oldFile = legacy.getSessionFile();
    if (oldFile === undefined) throw new Error("旧会话没有写入临时文件");

    await expect(
      h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-import-partial")),
    ).rejects.toThrow("旧会话导入停止");
    expect(h.sent.map((frame) => frame.fromSeq)).toEqual([0, 64]);
    stubHub(await snapshot(committed));

    await h.mirror.prepare(1, { seq: 64, head: (await snapshot(committed)).head }, RunId.parse("run-import-resume"));
    expect(h.sent.map((frame) => frame.fromSeq)).toEqual([0, 64, 64]);
    expect(h.sent[2]?.lines).toHaveLength(1);
    expect(existsSync(oldFile)).toBe(true);
  });

  it("导入首帧已在 Hub 提交但 ACK 断线时，下次 prepare 核对前缀后不重发", async () => {
    let committed: string[] = [];
    let calls = 0;
    const h = setup(async (frame) => {
      calls += 1;
      committed = [...frame.lines];
      return { kind: "disconnected" };
    });
    const legacy = SessionManager.create(h.workDir, h.sessionDir);
    appendUser(legacy, "ACK 丢失但 Hub 已保存");
    const oldFile = legacy.getSessionFile();
    if (oldFile === undefined) throw new Error("旧会话没有写入临时文件");

    await expect(
      h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-import-ack-lost")),
    ).rejects.toThrow("旧会话导入停止");
    stubHub(await snapshot(committed));

    await h.mirror.prepare(1, { seq: 1, head: (await snapshot(committed)).head }, RunId.parse("run-import-ack-resume"));

    expect(calls).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.fromSeq).toBe(0);
    expect(existsSync(oldFile)).toBe(true);
  });

  it("同群 lane.json 已有 chat 后仍导入独立 table 旧会话", async () => {
    const root = mkdtempSync(join(tmpdir(), "baize-work-mirror-streams-"));
    roots.push(root);
    const groupDir = join(root, "groups", "group-1");
    const chatDir = join(root, "sessions", "chat");
    const tableDir = join(root, "sessions", "table");
    const workDir = join(root, "work");
    mkdirSync(groupDir, { recursive: true });
    mkdirSync(chatDir, { recursive: true });
    mkdirSync(tableDir, { recursive: true });
    const chat = setup(async () => ({ kind: "ok" }), { root, groupDir, sessionDir: chatDir, stream: "chat" });
    const table = setup(async () => ({ kind: "ok" }), { root, groupDir, sessionDir: tableDir, stream: "table" });
    const chatLegacy = SessionManager.create(workDir, chatDir);
    appendUser(chatLegacy, "chat 旧会话");
    const tableLegacy = SessionManager.create(workDir, tableDir);
    appendUser(tableLegacy, "table 旧会话");
    const chatFile = chatLegacy.getSessionFile();
    const tableFile = tableLegacy.getSessionFile();
    if (chatFile === undefined || tableFile === undefined) throw new Error("旧会话没有写入临时文件");

    await chat.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-chat-import"));
    await table.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-table-import"));

    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]?.lines.join("\n")).toContain("chat 旧会话");
    expect(table.sent).toHaveLength(1);
    expect(table.sent[0]?.lane.stream).toBe("table");
    expect(table.sent[0]?.lines.join("\n")).toContain("table 旧会话");
    expect(existsSync(chatFile)).toBe(true);
    expect(existsSync(tableFile)).toBe(true);
  });

  it("invalidate 发生在 flush 的链头哈希期间时不调用 appender", async () => {
    let appendCalls = 0;
    const h = setup(async () => {
      appendCalls += 1;
      return { kind: "ok" };
    });
    const manager = await h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-hash-cancel"));
    appendUser(manager, "等待哈希取消");
    const digest = holdNextDigest();
    const flushing = h.mirror.flush("turn_end", RunId.parse("run-hash-cancel"));

    await digest.entered;
    h.mirror.invalidate();
    digest.release();

    await expect(flushing).resolves.toEqual({ kind: "disconnected" });
    expect(appendCalls).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("invalidate 发生在 Hub 完整响应后的最终哈希期间时不恢复上传", async () => {
    const source = SessionManager.inMemory("/tmp/work-mirror-source");
    appendUser(source, "Hub 历史");
    const hubSnapshot = await snapshot([JSON.stringify(source.getEntries()[0])]);
    stubHub(hubSnapshot);
    let appendCalls = 0;
    const h = setup(async () => {
      appendCalls += 1;
      return { kind: "ok" };
    });
    const digest = holdNextDigest();
    const preparing = h.mirror.prepare(1, { seq: 1, head: hubSnapshot.head }, RunId.parse("run-final-hash-cancel"));

    await digest.entered;
    h.mirror.invalidate();
    digest.release();

    await expect(preparing).rejects.toThrow();
    expect(appendCalls).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("chat 升到新 epoch 后 table 保留服务端游标并从 Hub 恢复历史", async () => {
    const root = mkdtempSync(join(tmpdir(), "baize-work-mirror-epochs-"));
    roots.push(root);
    const groupDir = join(root, "groups", "group-1");
    const chatDir = join(root, "sessions", "chat");
    const tableDir = join(root, "sessions", "table");
    const remote: Record<"chat" | "table", string[]> = { chat: [], table: [] };
    const chat = setup(
      async (frame) => {
        remote.chat.push(...frame.lines);
        return { kind: "ok" };
      },
      { root, groupDir, sessionDir: chatDir, stream: "chat" },
    );
    const table = setup(
      async (frame) => {
        remote.table.push(...frame.lines);
        return { kind: "ok" };
      },
      { root, groupDir, sessionDir: tableDir, stream: "table" },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const stream = new URL(String(input)).pathname.endsWith("/table") ? "table" : "chat";
        return new Response(JSON.stringify(await snapshot(remote[stream])), { status: 200 });
      }),
    );
    const chatManager = await chat.mirror.prepare(
      1,
      { seq: 0, head: EMPTY_WORK_HEAD },
      RunId.parse("run-chat-epoch-1"),
    );
    const tableManager = await table.mirror.prepare(
      1,
      { seq: 0, head: EMPTY_WORK_HEAD },
      RunId.parse("run-table-epoch-1"),
    );
    appendUser(chatManager, "chat epoch one");
    appendUser(tableManager, "table history survives");
    await chat.mirror.flush("turn_end", RunId.parse("run-chat-epoch-1"));
    await table.mirror.flush("turn_end", RunId.parse("run-table-epoch-1"));
    const tableHead = (await snapshot(remote.table)).head;

    await chat.mirror.prepare(
      2,
      { seq: remote.chat.length, head: (await snapshot(remote.chat)).head },
      RunId.parse("run-chat-epoch-2"),
      chatManager,
    );
    const afterChatEpochChange = JSON.parse(readFileSync(join(groupDir, "lane.json"), "utf8")) as {
      epoch: number;
      streams: { table?: { sessionFile: string | null; seq: number; head: string } };
    };
    expect(afterChatEpochChange).toMatchObject({
      epoch: 2,
      streams: { table: { sessionFile: null, seq: remote.table.length, head: tableHead } },
    });

    const restoredTable = await table.mirror.prepare(
      2,
      { seq: remote.table.length, head: tableHead },
      RunId.parse("run-table-epoch-2"),
      tableManager,
    );

    expect(table.sent.some((frame) => frame.cause === "import")).toBe(false);
    expect(
      restoredTable
        .getEntries()
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    ).toContain("table history survives");
  });

  it("快路径只在本地链头等于 prompt 带来的服务器链头时采用内存会话，分叉则按 Hub 重建", async () => {
    const lineOf = (text: string): string => {
      const source = SessionManager.inMemory("/tmp/work-mirror-source");
      appendUser(source, text);
      return JSON.stringify(source.getEntries()[0]);
    };
    const shared = await snapshot([lineOf("本地与服务器曾经一致")]);
    stubHub(shared);
    const h = setup(async () => ({ kind: "ok" }));
    const open = vi.spyOn(SessionManager, "open").mockImplementation(() => {
      throw new Error("模拟文件打开失败");
    });
    const local = await h.mirror.prepare(3, { seq: 1, head: shared.head }, RunId.parse("run-fork-1"));
    open.mockRestore();
    expect(local.getSessionFile()).toBeUndefined();

    const forked = await snapshot([lineOf("服务器上换成了另一条")]);
    let served = shared;
    const hub = vi.fn(async () => new Response(JSON.stringify(served), { status: 200 }));
    vi.stubGlobal("fetch", hub);

    const same = await h.mirror.prepare(3, { seq: 1, head: shared.head }, RunId.parse("run-fork-2"), local);
    expect(same).toBe(local);
    expect(hub).not.toHaveBeenCalled();

    served = forked;
    const rebuilt = await h.mirror.prepare(3, { seq: 1, head: forked.head }, RunId.parse("run-fork-3"), local);
    expect(rebuilt).not.toBe(local);
    expect(hub).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(rebuilt.getEntries());
    expect(text).toContain("服务器上换成了另一条");
    expect(text).not.toContain("本地与服务器曾经一致");
  });

  it("tool_list_changed 后 Hub 前缀与本地按新名单重滤的前缀不一致时停流并报 head_mismatch，不继续上传", async () => {
    const source = SessionManager.inMemory("/tmp/work-mirror-source");
    appendUser(source, "服务器上另一条分叉的前缀");
    const hubSnapshot = await snapshot([JSON.stringify(source.getEntries()[0])]);
    let rejected = false;
    const h = setup(async (frame) => {
      if (!rejected && frame.cause === "turn_end" && frame.fromSeq > 0) {
        rejected = true;
        stubHub(hubSnapshot);
        return { kind: "invalid", reason: "tool_list_changed", nextSeq: hubSnapshot.nextSeq, head: hubSnapshot.head };
      }
      return { kind: "ok" };
    });
    const manager = await h.mirror.prepare(2, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-tlc-fork"));
    appendUser(manager, "本地已确认的前缀");
    await expect(h.mirror.flush("turn_end", RunId.parse("run-tlc-fork"))).resolves.toEqual({ kind: "ok" });
    appendUser(manager, "不该传出去的尾巴");

    await expect(h.mirror.flush("turn_end", RunId.parse("run-tlc-fork"))).resolves.toEqual({ kind: "head_mismatch" });
    await expect(h.mirror.flush("turn_end", RunId.parse("run-tlc-fork"))).resolves.toEqual({ kind: "head_mismatch" });

    expect(h.sent).toHaveLength(2);
    expect(h.sent.at(-1)?.fromSeq).toBe(1);
    expect(h.logs.some((line) => line.includes("head_mismatch"))).toBe(true);
  });

  it("一批条目加起来超过上行帧上限时按字节分批，每帧都在上限以内，条目一条不落", async () => {
    const accepted: string[] = [];
    const h = setup(async (frame) => {
      accepted.push(...frame.lines);
      return { kind: "ok" };
    });
    const manager = await h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-big"));
    for (let index = 0; index < 24; index += 1)
      appendRawMessage(manager, assistant([{ type: "thinking", thinking: `${index}`.padEnd(MiB, "x") }], "stop"));

    await expect(h.mirror.flush("turn_end", RunId.parse("run-big"))).resolves.toEqual({ kind: "ok" });

    expect(h.sent.length, "24 条装不进一帧，要分成几帧").toBeGreaterThan(1);
    for (const frame of h.sent)
      expect(Buffer.byteLength(JSON.stringify(frame)), "每帧都要能过 /agent 的帧上限").toBeLessThan(
        AGENT_FRAME_MAX_BYTES,
      );
    expect(accepted).toHaveLength(24);
    expect(h.sent.map((frame) => frame.fromSeq)).toEqual(
      h.sent.map((_, index) => h.sent.slice(0, index).reduce((sum, frame) => sum + frame.lines.length, 0)),
    );
  });

  it("单条就超过上行帧上限时停流，前面的照传，超限的那条不发出去", async () => {
    const h = setup(async () => ({ kind: "ok" }));
    const manager = await h.mirror.prepare(1, { seq: 0, head: EMPTY_WORK_HEAD }, RunId.parse("run-huge"));
    appendUser(manager, "超限之前的一条");
    appendRawMessage(
      manager,
      assistant([{ type: "thinking", thinking: "x".repeat(AGENT_FRAME_MAX_BYTES + 1) }], "stop"),
    );

    await expect(h.mirror.flush("turn_end", RunId.parse("run-huge"))).resolves.toEqual({ kind: "invalid" });
    await expect(h.mirror.flush("turn_end", RunId.parse("run-huge"))).resolves.toEqual({ kind: "invalid" });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.lines).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("超过上行帧上限"))).toBe(true);
  });
});
