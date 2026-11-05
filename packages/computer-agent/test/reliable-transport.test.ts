import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_FRAME_MAX_BYTES,
  type AgentToControl,
  BotId,
  GroupId,
  MessageId,
  RunId,
  type ToolView,
} from "@baize/shared";
import { DownlinkCursor, ReliableOutbox } from "../src/reliable-transport.js";

const directories: string[] = [];

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "baize-reliable-transport-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const runDone = (runId: string) => ({
  type: "run_done" as const,
  runId: RunId.parse(runId),
  botId: BotId.parse("bot-1"),
  groupId: GroupId.parse("group-1"),
  steps: 1,
  inputTokens: 2,
  outputTokens: 3,
});

describe("电脑代理可靠传输落盘", () => {
  it("未 fsync 的帧不进入重放列表", async () => {
    const directory = await dataDir();
    const outbox = await ReliableOutbox.open(directory);
    const pending = outbox.append(runDone("run-1"));
    expect(outbox.pending()).toEqual([]);
    await outbox.flush();
    expect(outbox.pending()).toEqual([await pending]);
  });

  it("ACK 状态已落盘而日志尚未压缩时，重启跳过已确认帧", async () => {
    const directory = await dataDir();
    const outbox = await ReliableOutbox.open(directory);
    await outbox.append(runDone("run-1"));
    await outbox.append(runDone("run-2"));
    await writeFile(
      join(directory, ".agent", "outbox", "state.json"),
      JSON.stringify({ stream: outbox.stream, acked: 1 }),
    );
    const restarted = await ReliableOutbox.open(directory);
    expect(restarted.pending()).toEqual([{ seq: 2, body: runDone("run-2") }]);
    expect((await restarted.append(runDone("run-3"))).seq).toBe(3);
  });

  it("只在追加并 fsync 后完成，重启按原流和序号补发，累计确认后清理", async () => {
    const directory = await dataDir();
    const first = await ReliableOutbox.open(directory);
    const stored = await first.append(runDone("run-1"));
    const journalPath = join(directory, ".agent", "outbox", first.stream, "frames.jsonl");
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual({ seq: 1, body: runDone("run-1") });
    expect(stored.seq).toBe(1);

    await appendFile(journalPath, '{"seq":2');
    const restarted = await ReliableOutbox.open(directory);
    expect(restarted.stream).toBe(first.stream);
    expect(restarted.pending()).toEqual([{ seq: 1, body: runDone("run-1") }]);

    await restarted.acknowledge(1);
    const next = await restarted.append(runDone("run-2"));
    expect(next.seq).toBe(2);
    expect(restarted.pending()).toEqual([{ seq: 2, body: runDone("run-2") }]);
    const afterAck = await readFile(journalPath, "utf8");
    expect(afterAck).toContain('"seq":2');
    expect(afterAck).not.toContain('"seq":1');
  });

  it("下行游标在重开后保留，重复帧不会倒退游标", async () => {
    const directory = await dataDir();
    const cursor = await DownlinkCursor.open(directory);
    await cursor.persist(4);
    await cursor.persist(3);

    const restarted = await DownlinkCursor.open(directory);
    expect(restarted.applied).toBe(4);
  });

  it("同一电脑重启后沿用可靠流和下行游标", async () => {
    const directory = await dataDir();
    const first = await ReliableOutbox.openForComputer(directory, "computer-1");
    await first.outbox.append(runDone("run-1"));
    await first.outbox.acknowledge(1);
    await first.downlinkCursor.persist(6);

    const restarted = await ReliableOutbox.openForComputer(directory, "computer-1");

    expect(restarted.outbox.stream).toBe(first.outbox.stream);
    expect(restarted.outbox.acknowledged).toBe(1);
    expect(restarted.downlinkCursor.applied).toBe(6);
  });

  it("另一台电脑接管 dataDir 时隔离旧状态并从新流和游标零开始", async () => {
    const directory = await dataDir();
    const first = await ReliableOutbox.openForComputer(directory, "computer-1");
    await first.outbox.append(runDone("run-1"));
    await first.downlinkCursor.persist(6);
    const oldStream = first.outbox.stream;
    const logs: string[] = [];

    const second = await ReliableOutbox.openForComputer(directory, "computer-2", (line) => logs.push(line));

    expect(second.outbox.stream).not.toBe(oldStream);
    expect(second.outbox.acknowledged).toBe(0);
    expect(second.outbox.pending()).toEqual([]);
    expect(second.downlinkCursor.applied).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("已隔离到 ");
    const quarantinePath = logs[0]?.split("已隔离到 ")[1];
    expect(quarantinePath).toBeTruthy();
    expect(await readFile(join(quarantinePath as string, "downlink.json"), "utf8")).toBe('{"applied":6}');
    expect(await readFile(join(quarantinePath as string, "computer.json"), "utf8")).toBe('{"computerId":"computer-1"}');
  });

  it.each([
    ["完整垃圾行", "{garbage}\n"],
    ["缺号", `${JSON.stringify({ seq: 2, body: runDone("run-2") })}\n`],
    ["schema 不合", `${JSON.stringify({ seq: 1, body: { type: "unknown_frame" } })}\n`],
  ])("%s 隔离损坏状态后仍会开启新流", async (_label, badJournal) => {
    const directory = await dataDir();
    const first = await ReliableOutbox.openForComputer(directory, "computer-1");
    const oldStream = first.outbox.stream;
    await writeFile(join(directory, ".agent", "outbox", oldStream, "frames.jsonl"), badJournal);
    const logs: string[] = [];

    const recovered = await ReliableOutbox.openForComputer(directory, "computer-1", (line) => logs.push(line));

    expect(recovered.outbox.stream).not.toBe(oldStream);
    expect(recovered.outbox.pending()).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("已隔离到 ");
    expect(logs[0]).not.toContain(badJournal);
    const quarantinePath = logs[0]?.split("已隔离到 ")[1];
    expect(await readFile(join(quarantinePath as string, "outbox", oldStream, "frames.jsonl"), "utf8")).toBe(
      badJournal,
    );
  });

  it("不完整的尾行只截断，不隔离旧流", async () => {
    const directory = await dataDir();
    const first = await ReliableOutbox.openForComputer(directory, "computer-1");
    await first.outbox.append(runDone("run-1"));
    const journalPath = join(directory, ".agent", "outbox", first.outbox.stream, "frames.jsonl");
    await appendFile(journalPath, '{"seq":2');
    const logs: string[] = [];

    const restarted = await ReliableOutbox.openForComputer(directory, "computer-1", (line) => logs.push(line));

    expect(restarted.outbox.stream).toBe(first.outbox.stream);
    expect(restarted.outbox.pending()).toEqual([{ seq: 1, body: runDone("run-1") }]);
    expect(logs).toEqual([]);
    expect(await readFile(journalPath, "utf8")).toBe(`${JSON.stringify({ seq: 1, body: runDone("run-1") })}\n`);
  });
});

const lane = { runId: RunId.parse("run-1"), botId: BotId.parse("bot-1"), groupId: GroupId.parse("group-1") };
const CLIPPED = "…（内容过长，后面的已截掉）";
const oversized = (unit: string): string =>
  unit.repeat(Math.ceil((AGENT_FRAME_MAX_BYTES + 1024) / Buffer.byteLength(unit)));
const wireBytes = (outbox: ReliableOutbox, frame: { seq: number; body: AgentToControl }): number =>
  Buffer.byteLength(
    JSON.stringify({ type: "uplink", conn: 1, stream: outbox.stream, seq: frame.seq, body: frame.body }),
  );

describe("发件箱入口的单帧上限", () => {
  it("bot_text_done 的正文超限时按 UTF-8 字节截尾并注明，整帧收进上限且不切坏多字节字符", async () => {
    const outbox = await ReliableOutbox.open(await dataDir());
    const text = oversized("白话a");
    const stored = await outbox.append({ type: "bot_text_done", ...lane, messageId: MessageId.parse("m-1"), text });
    if (stored.body.type !== "bot_text_done") throw new Error(`进队列的是 ${stored.body.type}`);
    expect(wireBytes(outbox, stored)).toBeLessThanOrEqual(AGENT_FRAME_MAX_BYTES);
    expect(wireBytes(outbox, stored)).toBeGreaterThan(AGENT_FRAME_MAX_BYTES - 1024);
    expect(stored.body.text.endsWith("…（内容过长，后面的已截掉）")).toBe(true);
    const kept = stored.body.text.slice(0, -"…（内容过长，后面的已截掉）".length);
    expect(text.startsWith(kept)).toBe(true);
    expect(kept).not.toContain("\uFFFD");
  });

  it("agent_error 的 detail 满是要转义的字符时，截尾注明后整帧仍在上限内", async () => {
    const outbox = await ReliableOutbox.open(await dataDir());
    const detail = oversized('出错"\n了');
    const stored = await outbox.append({ type: "agent_error", code: "runner_failed", detail, ...lane });
    if (stored.body.type !== "agent_error") throw new Error(`进队列的是 ${stored.body.type}`);
    expect(wireBytes(outbox, stored)).toBeLessThanOrEqual(AGENT_FRAME_MAX_BYTES);
    expect(stored.body.detail.endsWith("…（内容过长，后面的已截掉）")).toBe(true);
    expect(detail.startsWith(stored.body.detail.slice(0, -"…（内容过长，后面的已截掉）".length))).toBe(true);
    expect(stored.body).toMatchObject({ code: "runner_failed", ...lane });
  });

  it("bot_tool_call 的原始参数超限时换成一句说明，其余字段不动", async () => {
    const outbox = await ReliableOutbox.open(await dataDir());
    const content = oversized("x");
    const stored = await outbox.append({
      type: "bot_tool_call",
      ...lane,
      callId: "call-1",
      tool: "write",
      view: { kind: "write", path: "a.txt", preview: ["xxx"], raw: { path: "a.txt", content } },
      status: "ok",
      durationMs: 5,
    });
    expect(wireBytes(outbox, stored)).toBeLessThanOrEqual(AGENT_FRAME_MAX_BYTES);
    expect(stored.body).toEqual({
      type: "bot_tool_call",
      ...lane,
      callId: "call-1",
      tool: "write",
      view: {
        kind: "write",
        path: "a.txt",
        preview: ["xxx"],
        raw: `原始参数有 ${Buffer.byteLength(JSON.stringify({ path: "a.txt", content }))} 字节，太大没有上传`,
      },
      status: "ok",
      durationMs: 5,
    });
  });

  it("approval_request 的原始参数超限时和 bot_tool_call 一样换成说明，其余字段不动", async () => {
    const outbox = await ReliableOutbox.open(await dataDir());
    const content = oversized("x");
    const request = {
      type: "approval_request" as const,
      ...lane,
      callId: "call-1",
      tool: "write",
      action: "write_workspace" as const,
      target: null,
      view: { kind: "write" as const, path: "a.txt", preview: ["xxx"], raw: { path: "a.txt", content } },
    };
    const stored = await outbox.append(request);
    expect(wireBytes(outbox, stored)).toBeLessThanOrEqual(AGENT_FRAME_MAX_BYTES);
    expect(stored.body).toEqual({
      ...request,
      view: {
        kind: "write",
        path: "a.txt",
        preview: ["xxx"],
        raw: `原始参数有 ${Buffer.byteLength(JSON.stringify({ path: "a.txt", content }))} 字节，太大没有上传`,
      },
    });
  });

  it("工具卡只是展示，命令、路径、预览、参数本身超限时一并截短注明，收进上限", async () => {
    const outbox = await ReliableOutbox.open(await dataDir());
    const huge = oversized("令a");
    const bash = await outbox.append({
      type: "bot_tool_call",
      ...lane,
      callId: "call-1",
      tool: "bash",
      view: { kind: "bash", command: huge, note: huge, raw: { command: huge } },
      status: "running",
      durationMs: null,
    });
    const write = await outbox.append({
      type: "bot_tool_call",
      ...lane,
      callId: "call-2",
      tool: "write",
      view: { kind: "write", path: huge, preview: [huge, "第二行"] },
      status: "ok",
      durationMs: 1,
    });
    const mcp = await outbox.append({
      type: "bot_tool_call",
      ...lane,
      callId: "call-3",
      tool: "search",
      view: { kind: "mcp", server: "搜索", tool: "search", params: [{ key: "q", value: [huge] }] },
      status: "ok",
      durationMs: 1,
    });
    for (const stored of [bash, write, mcp])
      expect(wireBytes(outbox, stored)).toBeLessThanOrEqual(AGENT_FRAME_MAX_BYTES);
    const clipped = (text: unknown): void => {
      if (typeof text !== "string") throw new Error(`不是字符串：${typeof text}`);
      expect(text.endsWith(CLIPPED)).toBe(true);
      const kept = text.slice(0, -CLIPPED.length);
      expect(kept.length).toBeGreaterThan(0);
      expect(huge.startsWith(kept) || JSON.stringify([huge]).startsWith(kept)).toBe(true);
      expect(kept).not.toContain("\uFFFD");
    };
    if (bash.body.type !== "bot_tool_call" || bash.body.view.kind !== "bash") throw new Error("工具卡变了形");
    clipped(bash.body.view.command);
    clipped(bash.body.view.note);
    expect(bash.body.view.raw).toMatch(/^原始参数有 \d+ 字节，太大没有上传$/);
    if (write.body.type !== "bot_tool_call" || write.body.view.kind !== "write") throw new Error("工具卡变了形");
    clipped(write.body.view.path);
    clipped(write.body.view.preview[0]);
    expect(write.body.view.preview[1]).toBe("第二行");
    expect(write.body.view).not.toHaveProperty("raw");
    if (mcp.body.type !== "bot_tool_call" || mcp.body.view.kind !== "mcp") throw new Error("工具卡变了形");
    expect(mcp.body.view.params[0]?.key).toBe("q");
    clipped(mcp.body.view.params[0]?.value);
  });

  it("审批卡上露出来的命令、说明、路径、工具和参数一个字不截，只把原始参数换成说明、写入预览截短", async () => {
    const outbox = await ReliableOutbox.open(await dataDir());
    const content = oversized("x");
    const command = `printf '${"令".repeat(10 * 1024)}' > a.txt`;
    const path = `${"深/".repeat(5 * 1024)}a.txt`;
    const value = "参".repeat(10 * 1024);
    const ask = (callId: string, view: ToolView): AgentToControl => ({
      type: "approval_request",
      ...lane,
      callId,
      tool: view.kind,
      action: "write_workspace",
      target: null,
      view,
    });
    const bash = await outbox.append(
      ask("call-1", { kind: "bash", command, note: "要装进工具箱", raw: { command, content } }),
    );
    const write = await outbox.append(
      ask("call-2", { kind: "write", path, preview: [content, "第二行"], raw: { content } }),
    );
    const mcp = await outbox.append(
      ask("call-3", {
        kind: "mcp",
        server: "邮箱",
        tool: "send_email",
        params: [{ key: "body", value }],
        raw: { content },
      }),
    );
    const rawText = `原始参数有 ${Buffer.byteLength(JSON.stringify({ content }))} 字节，太大没有上传`;
    for (const stored of [bash, write, mcp])
      expect(wireBytes(outbox, stored)).toBeLessThanOrEqual(AGENT_FRAME_MAX_BYTES);
    expect(bash.body).toEqual(
      ask("call-1", {
        kind: "bash",
        command,
        note: "要装进工具箱",
        raw: `原始参数有 ${Buffer.byteLength(JSON.stringify({ command, content }))} 字节，太大没有上传`,
      }),
    );
    expect(mcp.body).toEqual(
      ask("call-3", {
        kind: "mcp",
        server: "邮箱",
        tool: "send_email",
        params: [{ key: "body", value }],
        raw: rawText,
      }),
    );
    if (write.body.type !== "approval_request" || write.body.view.kind !== "write") throw new Error("审批卡变了形");
    expect(write.body.view.path).toBe(path);
    expect(write.body.view.raw).toBe(rawText);
    expect(write.body.view.preview[0]?.endsWith(CLIPPED)).toBe(true);
    expect(Buffer.byteLength(write.body.view.preview[0] ?? "")).toBeLessThanOrEqual(4096);
    expect(write.body.view.preview[1]).toBe("第二行");
  });

  it("审批卡上要看的内容本身就超过上限时不出卡，换成同一 runId 的报错说这一步没执行，并告诉代理停掉这个 run", async () => {
    const dropped: string[] = [];
    const outbox = await ReliableOutbox.open(await dataDir(), { dropped: (runId) => dropped.push(runId) });
    const huge = oversized("令a");
    const ask = (callId: string, view: ToolView): AgentToControl => ({
      type: "approval_request",
      ...lane,
      callId,
      tool: view.kind,
      action: "write_workspace",
      target: null,
      view,
    });
    const bash = await outbox.append(ask("call-1", { kind: "bash", command: huge }));
    const mcp = await outbox.append(
      ask("call-2", { kind: "mcp", server: "邮箱", tool: "send_email", params: [{ key: "body", value: [huge] }] }),
    );
    const notice = {
      type: "agent_error",
      code: "runner_failed",
      runId: lane.runId,
      detail: expect.stringMatching(/^审批请求过长，没法完整给你看，这一步没有执行/),
    };
    expect(bash.body).toEqual(notice);
    expect(mcp.body).toEqual(notice);
    expect(outbox.pending().map((frame) => frame.body.type)).toEqual(["agent_error", "agent_error"]);
    expect(dropped).toEqual(["run-1", "run-1"]);
  });

  it("带 runId 的帧截不下时原位换成同一 runId 的 agent_error 说明，序号照常连续，并告诉代理停掉这个 run", async () => {
    const directory = await dataDir();
    const dropped: string[] = [];
    const logs: string[] = [];
    const outbox = await ReliableOutbox.open(directory, {
      log: (line) => logs.push(line),
      dropped: (runId) => dropped.push(runId),
    });
    const notice = await outbox.append({
      type: "approval_abandoned",
      runId: lane.runId,
      callId: oversized("y"),
      reason: "stopped",
    });
    expect(notice.seq).toBe(1);
    expect(notice.body).toEqual({
      type: "agent_error",
      code: "runner_failed",
      runId: lane.runId,
      detail: expect.stringMatching(/^approval_abandoned 报文过长被丢弃/),
    });
    expect(dropped).toEqual(["run-1"]);
    expect(logs).toEqual([expect.stringContaining("approval_abandoned 截短后仍超过单帧上限")]);
    const next = await outbox.append(runDone("run-2"));
    expect(next.seq).toBe(2);
    expect(outbox.pending().map((frame) => [frame.seq, frame.body.type])).toEqual([
      [1, "agent_error"],
      [2, "run_done"],
    ]);
  });

  it("升级前已落在发件箱里的超限帧，重开时按同样规则截短或换成说明，序号不变，盘上也改掉", async () => {
    const directory = await dataDir();
    const first = await ReliableOutbox.open(directory);
    await first.append(runDone("run-0"));
    const journalPath = join(directory, ".agent", "outbox", first.stream, "frames.jsonl");
    const legacy: AgentToControl[] = [
      { type: "bot_text_done", ...lane, messageId: MessageId.parse("m-1"), text: oversized("白") },
      {
        type: "approval_request",
        ...lane,
        callId: "call-1",
        tool: "write",
        action: "write_workspace",
        target: null,
        view: { kind: "write", path: "a.txt", preview: [], raw: { content: oversized("x") } },
      },
      {
        type: "work_append",
        lane: { botId: lane.botId, groupId: lane.groupId, stream: "chat", epoch: 1 },
        runId: lane.runId,
        fromSeq: 0,
        lines: [oversized("z")],
        head: "0".repeat(64),
        cause: "turn_end",
      },
    ];
    for (const [index, body] of legacy.entries())
      await appendFile(journalPath, `${JSON.stringify({ seq: index + 2, body })}\n`);
    const logs: string[] = [];

    const restarted = await ReliableOutbox.open(directory, { log: (line) => logs.push(line) });

    const pending = restarted.pending();
    expect(pending.map((frame) => [frame.seq, frame.body.type])).toEqual([
      [1, "run_done"],
      [2, "bot_text_done"],
      [3, "approval_request"],
      [4, "agent_error"],
    ]);
    for (const frame of pending) expect(wireBytes(restarted, frame)).toBeLessThanOrEqual(AGENT_FRAME_MAX_BYTES);
    const [, text, approval, notice] = pending;
    if (text?.body.type !== "bot_text_done") throw new Error("正文帧变了形");
    expect(text.body.text.endsWith(CLIPPED)).toBe(true);
    if (approval?.body.type !== "approval_request") throw new Error("审批帧变了形");
    expect(approval.body.view.raw).toMatch(/^原始参数有 \d+ 字节，太大没有上传$/);
    expect(notice?.body).toEqual({
      type: "agent_error",
      code: "runner_failed",
      runId: lane.runId,
      detail: expect.stringMatching(/^work_append 报文过长被丢弃/),
    });
    expect(logs).toEqual([
      expect.stringContaining("发件箱第 2 帧 bot_text_done 超过单帧上限，已截短"),
      expect.stringContaining("发件箱第 3 帧 approval_request 超过单帧上限，已截短"),
      expect.stringContaining("发件箱第 4 帧 work_append 截短后仍超过单帧上限，换成一条报错"),
    ]);
    const onDisk = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line.length > 0);
    expect(onDisk.map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([1, 2, 3, 4]);
    for (const line of onDisk) expect(Buffer.byteLength(line)).toBeLessThan(AGENT_FRAME_MAX_BYTES);
    expect((await restarted.append(runDone("run-5"))).seq).toBe(5);
    expect((await ReliableOutbox.open(directory)).pending()).toEqual([...pending, { seq: 5, body: runDone("run-5") }]);
  });
});

const BACKLOG = "…（电脑离线太久，积压的输出太多，后面的已截掉）";
const KiB = 1024;
const limits = { maxBytes: 512 * KiB, trimToBytes: 384 * KiB };
const textDone = (id: string, text: string): AgentToControl => ({
  type: "bot_text_done",
  ...lane,
  messageId: MessageId.parse(id),
  text,
});
const toolCall = (id: string, command: string): AgentToControl => ({
  type: "bot_tool_call",
  ...lane,
  callId: id,
  tool: "bash",
  view: { kind: "bash", command, raw: { command } },
  status: "ok",
  durationMs: 5,
});
const workAppend = (line: string): AgentToControl => ({
  type: "work_append",
  lane: { botId: lane.botId, groupId: lane.groupId, stream: "chat", epoch: 1 },
  runId: lane.runId,
  fromSeq: 0,
  lines: [line],
  head: "0".repeat(64),
  cause: "turn_end",
});
const journalBytes = async (outbox: ReliableOutbox, directory: string): Promise<number> =>
  Buffer.byteLength(await readFile(join(directory, ".agent", "outbox", outbox.stream, "frames.jsonl"), "utf8"));

describe("发件箱总量上限", () => {
  it("积压超过上限时从最早的大帧原位收短到回落线以下，序号连续，结局帧原样，收短的写明原因，盘上也改掉", async () => {
    const directory = await dataDir();
    const logs: string[] = [];
    const outbox = await ReliableOutbox.open(directory, { log: (line) => logs.push(line) }, limits);
    const error: AgentToControl = {
      type: "agent_error",
      code: "runner_failed",
      detail: "e".repeat(3 * KiB),
      runId: lane.runId,
    };
    const bodies: AgentToControl[] = [
      textDone("m-1", "早".repeat(100 * KiB)),
      runDone("run-1"),
      toolCall("call-1", "命".repeat(60 * KiB)),
      error,
      textDone("m-2", "晚".repeat(100 * KiB)),
    ];
    for (const body of bodies) await outbox.append(body);
    await outbox.flush();

    const reopened = await ReliableOutbox.open(directory, {}, limits);
    const pending = reopened.pending();
    expect(pending.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5]);
    const [first, done, tool, kept, last] = pending.map((frame) => frame.body);
    if (first?.type !== "bot_text_done") throw new Error(`第 1 帧成了 ${first?.type}`);
    expect(first.text.endsWith(BACKLOG)).toBe(true);
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(64 * KiB);
    expect("早".repeat(100 * KiB).startsWith(first.text.slice(0, -BACKLOG.length))).toBe(true);
    expect(done).toEqual(runDone("run-1"));
    if (tool?.type !== "bot_tool_call" || tool.view.kind !== "bash") throw new Error(`第 3 帧成了 ${tool?.type}`);
    expect(Buffer.byteLength(tool.view.command)).toBeLessThanOrEqual(4 * KiB);
    expect(tool.view.raw).toMatch(/^原始参数有 \d+ 字节，太大没有上传$/);
    expect(kept, "agent_error 的 detail 不到 4 KiB 不收").toEqual(error);
    expect(last, "回落到线以下就停，后面的大帧不动").toEqual(bodies[4]);
    expect(await journalBytes(reopened, directory)).toBeLessThanOrEqual(limits.trimToBytes);
    expect(logs).toEqual([
      expect.stringMatching(/^发件箱积压超过上限 524288 字节，收短了最早的 2 帧，从 \d+ 字节到 \d+ 字节$/),
    ]);
  });

  it("旧版代理留下的超量积压在重开时收短并重写日志：agent_error 的 detail 收到 4 KiB，审批请求不收，收过的不再收", async () => {
    const directory = await dataDir();
    const outbox = await ReliableOutbox.open(directory);
    const approval: AgentToControl = {
      type: "approval_request",
      ...lane,
      callId: "call-1",
      tool: "bash",
      action: "shell",
      target: null,
      view: { kind: "bash", command: "批".repeat(200 * KiB) },
    };
    await outbox.append(approval);
    await outbox.append({ type: "agent_error", code: "runner_failed", detail: "错".repeat(200 * KiB), ...lane });
    await outbox.append(toolCall("call-2", "命".repeat(60 * KiB)));
    await outbox.append(textDone("m-1", "早".repeat(100 * KiB)));
    await outbox.flush();
    const once = (await ReliableOutbox.open(directory, {}, limits)).pending();
    expect((await ReliableOutbox.open(directory)).pending(), "日志已重写").toEqual(once);

    expect(once[0]?.body).toEqual(approval);
    const error = once[1]?.body;
    if (error?.type !== "agent_error") throw new Error(`第 2 帧成了 ${error?.type}`);
    expect(error.detail.endsWith(BACKLOG)).toBe(true);
    expect(Buffer.byteLength(error.detail)).toBeLessThanOrEqual(4 * KiB);

    const logs: string[] = [];
    const twice = await ReliableOutbox.open(directory, { log: (line) => logs.push(line) }, limits);
    expect(twice.pending()).toEqual(once);
    expect(logs).toEqual([
      expect.stringMatching(/^发件箱收短后仍有 \d+ 字节，超过上限 524288 字节，剩下的报文收不动了，照收$/),
    ]);
  });

  it("超过上限时新来的 work_append 拒收不占序号，结局帧照收并在日志里报当前字节数", async () => {
    const directory = await dataDir();
    const logs: string[] = [];
    const outbox = await ReliableOutbox.open(directory, { log: (line) => logs.push(line) }, limits);
    await Promise.all(Array.from({ length: 4000 }, (_, index) => outbox.append(runDone(`run-${index + 1}`))));

    await expect(outbox.append(workAppend("一行工作记录"))).rejects.toThrow(/work_append 不进发件箱/);
    const next = await outbox.append(runDone("run-last"));
    await outbox.flush();

    expect(next.seq).toBe(4001);
    expect(outbox.pending().map((frame) => frame.seq)).toEqual(Array.from({ length: 4001 }, (_, index) => index + 1));
    expect(outbox.pending().at(-1)?.body).toEqual(runDone("run-last"));
    expect(logs.at(-1)).toMatch(/^发件箱收短后仍有 \d+ 字节，超过上限 524288 字节，剩下的报文收不动了，照收$/);
  });

  it("确认之后积压字节随之减少，work_append 又能进发件箱", async () => {
    const outbox = await ReliableOutbox.open(await dataDir(), {}, limits);
    await Promise.all(Array.from({ length: 4000 }, (_, index) => outbox.append(runDone(`run-${index + 1}`))));
    await expect(outbox.append(workAppend("被拒"))).rejects.toThrow(/work_append 不进发件箱/);

    await outbox.acknowledge(4000);

    expect((await outbox.append(workAppend("放行"))).seq).toBe(4001);
  });

  it("收不动的积压超过回落线后，新来的工具卡落盘前就收短，日志只追加不整份重写", async () => {
    const directory = await dataDir();
    const outbox = await ReliableOutbox.open(directory, {}, limits);
    for (let index = 0; index < 6; index += 1)
      await outbox.append({
        type: "approval_request",
        ...lane,
        callId: `approval-${index}`,
        tool: "bash",
        action: "shell",
        target: null,
        view: { kind: "bash", command: "批".repeat(40 * KiB) },
      });
    const journalPath = join(directory, ".agent", "outbox", outbox.stream, "frames.jsonl");
    const { ino } = await stat(journalPath);

    for (let index = 0; index < 20; index += 1) {
      await outbox.append(toolCall(`call-${index}`, "命".repeat(8 * KiB)));
      await outbox.flush();
      expect((await stat(journalPath)).ino, `第 ${index + 1} 条工具卡之后日志还是原来那个文件`).toBe(ino);
    }
    const onDisk = (await readFile(journalPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { seq: number; body: AgentToControl });
    expect(onDisk.map((frame) => frame.seq)).toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
    for (const { body } of onDisk.slice(6)) {
      if (body.type !== "bot_tool_call" || body.view.kind !== "bash") throw new Error(`工具卡成了 ${body.type}`);
      expect(Buffer.byteLength(body.view.command)).toBeLessThanOrEqual(4 * KiB);
      expect(body.view.raw).toMatch(/^原始参数有 \d+ 字节，太大没有上传$/);
    }
    expect(outbox.pending().map((frame) => frame.body)).toEqual(onDisk.map((frame) => frame.body));
  });

  it("压缩日志时还没落盘的帧不写进去，重开不出重复序号", async () => {
    const directory = await dataDir();
    const outbox = await ReliableOutbox.open(directory);
    await outbox.append(runDone("run-1"));
    const acknowledged = outbox.acknowledge(1);
    await new Promise((resolve) => setImmediate(resolve));
    const late = outbox.append(runDone("run-2"));
    await acknowledged;
    await late;

    expect((await ReliableOutbox.open(directory)).pending()).toEqual([{ seq: 2, body: runDone("run-2") }]);
  });
});
