import { describe, expect, it } from "vitest";
import {
  EMPTY_WORK_HEAD,
  HubLaneSnapshot,
  PiWorkEntry,
  WorkAppendResult,
  advanceWorkHead,
  extractWorkSearchText,
} from "../src/lane-records.js";

describe("lane 工作记录", () => {
  it("按空头、一行、两行的固定向量推进哈希", async () => {
    expect(await advanceWorkHead(EMPTY_WORK_HEAD, [])).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(await advanceWorkHead(EMPTY_WORK_HEAD, ["a"])).toBe(
      "8c374a53782642f7514d087d26a3e733f1b806009a03e04a43b288ef2fa9f9c0",
    );
    expect(await advanceWorkHead(EMPTY_WORK_HEAD, ["a", "b"])).toBe(
      "153d5381929b50792d3b22ae9596544af3b0e4805be1555a595e6d2a2734933f",
    );
  });

  it("保留 Pi 工作条目的其他字段，并拒绝 SessionHeader", () => {
    const entry = { type: "message", id: "entry-1", parentId: null, custom: { keep: true } };
    expect(PiWorkEntry.parse(entry)).toEqual(entry);
    expect(PiWorkEntry.safeParse({ type: "session", id: "header", parentId: null }).success).toBe(false);
  });

  it("只提取用户、助手和工具结果里的文本块", () => {
    expect(extractWorkSearchText({ message: { role: "user", content: "用户内容" } })).toBe("用户内容");
    expect(
      extractWorkSearchText({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "助手" },
            { type: "thinking", thinking: "隐藏推理" },
            { type: "image", data: "图片" },
            { type: "text", text: "文本" },
          ],
        },
      }),
    ).toBe("助手文本");
    expect(extractWorkSearchText({ message: { role: "toolResult", content: [{ type: "text", text: "工具" }] } })).toBe(
      "工具",
    );
    expect(extractWorkSearchText({ message: { role: "system", content: "忽略" } })).toBe("");
    expect(extractWorkSearchText({ message: { role: "assistant", content: [{ type: "image", data: "忽略" }] } })).toBe(
      "",
    );
  });

  it("工作记录结果联合只接受声明的返回形状", () => {
    expect(WorkAppendResult.parse({ kind: "seq_mismatch", nextSeq: 12 })).toEqual({
      kind: "seq_mismatch",
      nextSeq: 12,
    });
    expect(WorkAppendResult.safeParse({ kind: "seq_mismatch" }).success).toBe(false);
  });

  it("Hub 快照支持空流与原样行，拒绝负序号和缺失版本", () => {
    expect(HubLaneSnapshot.parse({ entries: [], nextSeq: 0, head: EMPTY_WORK_HEAD, piSessionVersion: null })).toEqual({
      entries: [],
      nextSeq: 0,
      head: EMPTY_WORK_HEAD,
      piSessionVersion: null,
    });
    const snapshot = {
      entries: [{ seq: 0, line: ' {"id":"a"} ' }],
      nextSeq: 1,
      head: EMPTY_WORK_HEAD,
      piSessionVersion: 3,
    };
    expect(HubLaneSnapshot.parse(snapshot)).toEqual(snapshot);
    expect(HubLaneSnapshot.safeParse({ ...snapshot, entries: [{ seq: -1, line: "x" }] }).success).toBe(false);
    expect(HubLaneSnapshot.safeParse({ entries: [], nextSeq: 0, head: EMPTY_WORK_HEAD }).success).toBe(false);
  });
});
