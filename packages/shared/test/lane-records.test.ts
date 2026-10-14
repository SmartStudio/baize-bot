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

  it.each(["type", "id", "parentId"])("Pi 条目的 %s 拒绝真 NUL", (field) => {
    const entry = { type: "message", id: "entry-1", parentId: "parent-1", [field]: "前\u0000后" };
    expect(PiWorkEntry.safeParse(entry).success).toBe(false);
  });

  it("Pi 条目的非列字段保留 NUL，合法标识与 null 父节点保持原样", () => {
    const entry = { type: "custom", id: "entry-1", parentId: null, data: "前\u0000后" };
    expect(PiWorkEntry.parse(entry)).toEqual(entry);
    expect(PiWorkEntry.parse({ ...entry, parentId: "" }).parentId).toBe("");
  });

  it.each(["user", "assistant", "toolResult"])("%s 字符串 content 只剔除真 NUL，跨 NUL 的词保持连续", (role) => {
    expect(
      extractWorkSearchText({ message: { role, content: "\u0000前\u0000\u0000后\u0000\n保留\\u0000\t\u0001🙂" } }),
    ).toBe("前后\n保留\\u0000\t\u0001🙂");
  });

  it.each(["user", "assistant", "toolResult"])("%s 数组 content 只剔除文本块中的真 NUL", (role) => {
    expect(
      extractWorkSearchText({
        message: {
          role,
          content: [
            { type: "text", text: "\u0000前\u0000\u0000" },
            { type: "thinking", thinking: "不索引\u0000" },
            { type: "image", data: "不索引\u0000" },
            { type: "text", text: "后\u0000\n保留\\u0000\t\u0001🙂" },
          ],
        },
      }),
    ).toBe("前后\n保留\\u0000\t\u0001🙂");
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
    const changed = {
      kind: "invalid",
      reason: "tool_list_changed",
      replayReason: "unfiltered",
      lineIndex: 2,
      nextSeq: 2,
      head: EMPTY_WORK_HEAD,
    };
    expect(WorkAppendResult.parse(changed)).toEqual(changed);
    expect(WorkAppendResult.safeParse({ ...changed, reason: "未知原因" }).success).toBe(false);
    expect(WorkAppendResult.safeParse({ ...changed, lineIndex: -1 }).success).toBe(false);
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
