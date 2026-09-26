import { describe, expect, it } from "vitest";
import { ContentPlan, ContentPlanId, Draft, DraftId } from "@baize/shared";
import { EMPTY_CONTENT, reduceContent } from "./content.js";
import { createClock, type Seq } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

const at = "2026-09-26T08:00:00.000Z";
const DRAFT_ID = DraftId.parse("draft_1");
const PLAN_ID = ContentPlanId.parse("plan_1");

const draft = (status: Draft["status"], text = "X3 现货比价清单") =>
  Draft.parse({
    id: "draft_1",
    groupId: "grp_1",
    botId: "bot_1",
    planId: null,
    accountId: "acc_1",
    platform: "xiaohongshu",
    content: { kind: "post", title: "比价", text, images: [], github: null },
    scheduledAt: null,
    status,
    edits: [],
    failure: null,
    createdAt: at,
    decidedAt: status === "pending" ? null : at,
  });

const plan = (status: ContentPlan["status"]) =>
  ContentPlan.parse({
    id: "plan_1",
    groupId: "grp_1",
    botId: "bot_1",
    title: "本周推广计划",
    status,
    draftIds: ["draft_1"],
    createdAt: at,
    decidedAt: status === "pending" ? null : at,
  });

// 这几条动作只读写 content，别的字段用不上。
const initial = { content: EMPTY_CONTENT } as unknown as ReadyState;

// 请求发出时取号、推送到达时取号，用例按真实的先后取号，再按落地的先后喂给 reducer。
const setup = () => {
  const next = createClock();
  let state = initial;
  const land = (seq: Seq, drafts: Draft[], plans: ContentPlan[] = []) => {
    state = reduceContent(state, { type: "content_loaded", drafts, plans, seq } satisfies Action);
  };
  return { next, land, get: () => state.content };
};

describe("推送、快照和操作回包的先后", () => {
  it("快照发出之后批了的草稿，快照晚到不把它打回待批", () => {
    const { next, land, get } = setup();
    land(next(), [draft("pending")]);
    const snapshot = next();
    land(next(), [draft("approved")]);
    land(snapshot, [draft("pending")]);
    expect(get().drafts[DRAFT_ID]?.status).toBe("approved");
  });

  it("快照发出之后批了的计划，快照晚到不把它打回待批", () => {
    const { next, land, get } = setup();
    land(next(), [], [plan("pending")]);
    const snapshot = next();
    land(next(), [], [plan("approved")]);
    land(snapshot, [], [plan("pending")]);
    expect(get().plans[PLAN_ID]?.status).toBe("approved");
  });

  it("快照发出之前写下的条目，快照照样盖成服务端的新样子", () => {
    const { next, land, get } = setup();
    land(next(), [draft("approved")], [plan("pending")]);
    land(next(), [draft("pending", "Bot 改过的新正文")], [plan("approved")]);
    expect(get().drafts[DRAFT_ID]?.content.text, "断线时漏掉的改稿由快照补上").toBe("Bot 改过的新正文");
    expect(get().drafts[DRAFT_ID]?.status).toBe("pending");
    expect(get().plans[PLAN_ID]?.status).toBe("approved");
  });

  it("快照落地之后到的推送照样生效", () => {
    const { next, land, get } = setup();
    land(next(), [draft("pending")]);
    land(next(), [draft("approved")]);
    expect(get().drafts[DRAFT_ID]?.status).toBe("approved");
  });

  it("晚到的快照被挡掉以后，下一份新快照照样能盖这条", () => {
    const { next, land, get } = setup();
    const stale = next();
    land(next(), [draft("approved")]);
    land(stale, [draft("pending")]);
    land(next(), [draft("pending", "Bot 改过的新正文")]);
    expect(get().drafts[DRAFT_ID]?.content.text).toBe("Bot 改过的新正文");
  });

  it("批准请求发出之后 Bot 改稿的推送先到，晚到的批准回包不把它盖回已批", () => {
    const { next, land, get } = setup();
    land(next(), [draft("pending")]);
    const approve = next();
    land(next(), [draft("pending", "Bot 后来改过")]);
    land(approve, [draft("approved")]);
    expect(get().drafts[DRAFT_ID]?.status).toBe("pending");
    expect(get().drafts[DRAFT_ID]?.content.text).toBe("Bot 后来改过");
  });

  it("两份快照都发出后才依次落地，后发的那份说了算", () => {
    const { next, land, get } = setup();
    land(next(), [draft("pending", "本地旧值")]);
    const first = next();
    const second = next();
    land(first, [draft("pending", "先发快照")]);
    land(second, [draft("pending", "后发快照")]);
    expect(get().drafts[DRAFT_ID]?.content.text).toBe("后发快照");
  });

  it("两份快照后发先到，先发的那份晚到也不盖", () => {
    const { next, land, get } = setup();
    const first = next();
    const second = next();
    land(second, [draft("pending", "后发快照")]);
    land(first, [draft("pending", "先发快照")]);
    expect(get().drafts[DRAFT_ID]?.content.text).toBe("后发快照");
  });
});
