import { describe, expect, it } from "vitest";
import { RECALL_EXCERPT_LENGTH, RECALL_LIMIT, RecallRequest, RecallResponse, recallPlaceholder } from "../src/index.js";

describe("recall 的边界契约", () => {
  it("关键词去除首尾空白，拒绝空白、超长和冒用身份字段", () => {
    expect(RecallRequest.parse({ query: "  小红书  " })).toEqual({ query: "小红书" });
    expect(RecallRequest.safeParse({ query: "  " }).success).toBe(false);
    expect(RecallRequest.safeParse({ query: "字".repeat(101) }).success).toBe(false);
    expect(RecallRequest.safeParse({ query: "预算\u0000" }).success).toBe(false);
    expect(RecallRequest.safeParse({ query: "底牌", botId: "别人的 Bot" }).success).toBe(false);
  });

  it("结果必须带出处，限制条数和摘录长度，拒绝未知种类", () => {
    const entry = {
      groupId: "group-a",
      groupTitle: "白泽推广",
      at: "2026-10-14T00:00:00.000Z",
      kind: "user",
      excerpt: "每周两篇小红书",
    };
    expect(RecallResponse.parse([entry])).toEqual([entry]);
    expect(RecallResponse.safeParse(Array.from({ length: RECALL_LIMIT + 1 }, () => entry)).success).toBe(false);
    expect(RecallResponse.safeParse([{ ...entry, excerpt: "字".repeat(RECALL_EXCERPT_LENGTH + 1) }]).success).toBe(
      false,
    );
    expect(RecallResponse.safeParse([{ ...entry, kind: "compaction" }]).success).toBe(false);
    expect(RecallResponse.safeParse([{ ...entry, at: "昨天" }]).success).toBe(false);
  });

  it("占位文字不包含查询词或摘录", () => {
    expect(recallPlaceholder(2)).toBe("找到 2 条以前的记录，内容只在这一轮可见");
  });
});
