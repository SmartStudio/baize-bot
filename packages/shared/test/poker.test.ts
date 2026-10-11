import { describe, expect, it } from "vitest";
import { POKER_REVIEW_TEXT_LIMIT, POKER_USER_SEAT, PokerTableView, RetryReviewRequest } from "../src/index.js";

const seat = (no: number, engineSeatId: string) => ({
  seat: no,
  engineSeatId,
  kind: no === POKER_USER_SEAT ? "user" : "bot",
  botId: no === POKER_USER_SEAT ? null : `bot_${no}`,
  name: `${no} 号`,
  persona: null,
  hue: "sky",
  stack: 2000,
});

const view = (patch: Record<string, unknown>) => ({
  groupId: "grp_1",
  status: "idle",
  version: 1,
  seats: [seat(1, "1"), seat(2, "2"), seat(3, "3"), seat(4, "4")],
  host: { botId: "bot_host", name: "老白", hue: "sky" },
  session: null,
  hand: null,
  hint: null,
  lastReview: null,
  reviewState: null,
  stats: { sessions: 0, sessionsWon: 0, net: 0 },
  ...patch,
});

describe("牌桌视图", () => {
  it("每个座位都带引擎座位 id，控制面和 mock 两种写法都是任意字符串", () => {
    expect(PokerTableView.parse(view({})).seats.map((entry) => entry.engineSeatId)).toEqual(["1", "2", "3", "4"]);
    expect(PokerTableView.parse(view({ seats: [seat(4, "s4")] })).seats[0]?.engineSeatId).toBe("s4");
    const { engineSeatId: _dropped, ...without } = seat(4, "4");
    expect(PokerTableView.safeParse(view({ seats: [without] })).success, "少了引擎座位 id 不收").toBe(false);
  });

  it("复盘状态只有生成中、已完成、失败三种", () => {
    for (const status of ["generating", "done", "failed"]) {
      const parsed = PokerTableView.parse(view({ reviewState: { sessionId: "ses_1", status } }));
      expect(parsed.reviewState).toEqual({ sessionId: "ses_1", status });
    }
    expect(PokerTableView.safeParse(view({ reviewState: { sessionId: "ses_1", status: "waiting" } })).success).toBe(
      false,
    );
    expect(PokerTableView.safeParse(view({ lastReview: null, reviewState: undefined })).success, "字段必填").toBe(
      false,
    );
  });

  it("重试复盘只认场次 id，多余字段不收", () => {
    expect(RetryReviewRequest.parse({ sessionId: "ses_1" })).toEqual({ sessionId: "ses_1" });
    expect(RetryReviewRequest.safeParse({}).success).toBe(false);
    expect(RetryReviewRequest.safeParse({ sessionId: "ses_1", force: true }).success).toBe(false);
  });

  it("复盘正文上限和用户座位号是两边共用的常量", () => {
    expect(POKER_REVIEW_TEXT_LIMIT).toBe(120);
    expect(POKER_USER_SEAT).toBe(4);
  });
});
