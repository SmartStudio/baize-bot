import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_FRAME_MAX_BYTES, type AgentToControl, BotId, GroupId, MessageId, RunId } from "@baize/shared";
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

  it("截完仍超限的帧拒收，不占序号、不落盘，发件箱照常接后面的帧", async () => {
    const directory = await dataDir();
    const outbox = await ReliableOutbox.open(directory);
    await expect(
      outbox.append({
        type: "bot_tool_call",
        ...lane,
        callId: "call-1",
        tool: "bash",
        view: { kind: "bash", command: oversized("y"), raw: { command: "y" } },
        status: "running",
        durationMs: null,
      }),
    ).rejects.toThrow("bot_tool_call 截短后仍超过单帧上限，不进发件箱");
    const next = await outbox.append(runDone("run-2"));
    expect(next.seq).toBe(1);
    expect(outbox.pending()).toEqual([{ seq: 1, body: runDone("run-2") }]);
    expect(await readFile(join(directory, ".agent", "outbox", outbox.stream, "frames.jsonl"), "utf8")).toBe(
      `${JSON.stringify({ seq: 1, body: runDone("run-2") })}\n`,
    );
  });
});
