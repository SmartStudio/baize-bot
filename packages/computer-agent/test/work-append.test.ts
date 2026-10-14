import { BotId, GroupId, RunId, type WorkAppend, type UplinkRejection } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { WorkAppendChannel } from "../src/work-append.js";

const probe = (): WorkAppend => ({
  type: "work_append",
  lane: { botId: BotId.parse("bot-1"), groupId: GroupId.parse("group-1"), stream: "chat", epoch: 7 },
  runId: RunId.parse("run-1"),
  fromSeq: 0,
  lines: [],
  head: "0".repeat(64),
  cause: "before_effect",
});

describe("工作记录探针的确认通路", () => {
  it("先等落盘、登记 seq 再发送，发送时同步到达的 ACK 也能结算", async () => {
    let durable!: (stored: { seq: number; body: WorkAppend }) => void;
    const sent: number[] = [];
    const channel = new WorkAppendChannel({
      connected: () => true,
      append: () => new Promise((resolve) => (durable = resolve)),
      send: (stored) => {
        sent.push(stored.seq);
        channel.acknowledge({ type: "uplink_ack", upTo: stored.seq, rejected: [] });
      },
      cancel: () => {},
      failed: () => {},
    });
    const pending = channel.append(probe());
    expect(sent).toEqual([]);
    durable({ seq: 4, body: probe() });
    expect(await pending).toEqual({ kind: "ok" });
    expect(sent).toEqual([4]);
  });

  it("累计 ACK 按 rejection.seq 分别结算，超出 upTo 的等待者留到断线再解除", async () => {
    let sequence = 0;
    const sent: number[] = [];
    const cancelled: Array<{ lane: NonNullable<UplinkRejection["lane"]>; epoch: number }> = [];
    const channel = new WorkAppendChannel({
      connected: () => true,
      append: async (body) => ({ seq: ++sequence, body }),
      send: (stored) => {
        sent.push(stored.seq);
      },
      cancel: (lane, epoch) => {
        cancelled.push({ lane, epoch });
      },
      failed: () => {},
    });
    const first = channel.append(probe());
    const second = channel.append(probe());
    const third = channel.append(probe());
    await Promise.resolve();
    expect(sent).toEqual([1, 2, 3]);
    channel.acknowledge({
      type: "uplink_ack",
      upTo: 2,
      rejected: [{ seq: 1, code: "stale_epoch", lane: probe().lane }],
    });
    expect(await Promise.all([first, second])).toEqual([{ kind: "stale_epoch" }, { kind: "ok" }]);
    expect(cancelled).toEqual([{ lane: probe().lane, epoch: 8 }]);
    channel.disconnect();
    expect(await third).toEqual({ kind: "disconnected" });
  });

  it("invalid 将服务端提供的全部复查字段传给运行器", async () => {
    const channel = new WorkAppendChannel({
      connected: () => true,
      append: async (body) => ({ seq: 1, body }),
      send: () => {},
      cancel: () => {},
      failed: () => {},
    });
    const pending = channel.append(probe());
    await Promise.resolve();
    const rejection: UplinkRejection = {
      seq: 1,
      code: "invalid",
      reason: "tool_list_changed",
      lineIndex: 3,
      replayReason: "unfiltered",
      nextSeq: 2,
      head: "a".repeat(64),
    };
    channel.acknowledge({ type: "uplink_ack", upTo: 1, rejected: [rejection] });
    expect(await pending).toEqual({
      kind: "invalid",
      reason: "tool_list_changed",
      lineIndex: 3,
      replayReason: "unfiltered",
      nextSeq: 2,
      head: "a".repeat(64),
    });
  });

  it("普通 invalid 不添加未提供的可选字段", async () => {
    const channel = new WorkAppendChannel({
      connected: () => true,
      append: async (body) => ({ seq: 1, body }),
      send: () => {},
      cancel: () => {},
      failed: () => {},
    });
    const pending = channel.append(probe());
    await Promise.resolve();
    channel.acknowledge({ type: "uplink_ack", upTo: 1, rejected: [{ seq: 1, code: "invalid" }] });
    const result = await pending;
    expect(result).toEqual({ kind: "invalid" });
    expect(Object.hasOwn(result, "reason")).toBe(false);
    expect(Object.hasOwn(result, "lineIndex")).toBe(false);
    expect(Object.hasOwn(result, "replayReason")).toBe(false);
    expect(Object.hasOwn(result, "nextSeq")).toBe(false);
    expect(Object.hasOwn(result, "head")).toBe(false);
  });
});
