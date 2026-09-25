import { describe, expect, it } from "vitest";
import { timeText } from "./TodayPage.js";

describe("timeText", () => {
  const localAt = (day: number, hour: number, minute = 0): string => new Date(2026, 8, day, hour, minute).toISOString();
  const now = new Date(2026, 8, 21, 12);

  it("测试时区钉在 Asia/Shanghai，本地日和 UTC 日在凌晨八点前不重合", () => {
    expect(new Date(2026, 8, 21).getTimezoneOffset()).toBe(-480);
  });

  it.each([
    [localAt(21, 9), "今天 09:00"],
    [localAt(22, 9), "明天 09:00"],
    [localAt(23, 9), "9月23日 09:00"],
    [localAt(20, 21, 30), "昨天 21:30"],
    [localAt(18, 21, 30), "9月18日 21:30"],
  ])("%s -> %s", (at, expected) => {
    expect(timeText(at, now)).toBe(expected);
  });

  it.each([
    ["明天 00:10", new Date(2026, 8, 21, 23, 50), new Date(2026, 8, 22, 0, 10)],
    ["昨天 23:50", new Date(2026, 8, 21, 0, 10), new Date(2026, 8, 20, 23, 50)],
    ["今天 01:00", new Date(2026, 8, 21, 7, 0), new Date(2026, 8, 21, 1, 0)],
    ["明天 13:00", new Date(2026, 8, 21, 7, 0), new Date(2026, 8, 22, 13, 0)],
    ["明天 09:00", new Date(2026, 11, 31, 22, 0), new Date(2027, 0, 1, 9, 0)],
  ])("靠近午夜和跨年：%s", (expected, current, at) => {
    expect(timeText(at.toISOString(), current)).toBe(expected);
  });
});
