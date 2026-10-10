import { describe, expect, it } from "vitest";
import { describeCron } from "./cron.js";

describe("describeCron", () => {
  it("四种预设和每周某天都说成人话，认不出的原样给", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("工作日 09:00");
    expect(describeCron("30 8 * * *")).toBe("每天 08:30");
    expect(describeCron("0 17 * * 5")).toBe("每周五 17:00");
    expect(describeCron("0 10 * * 0"), "0 和 7 都是周日").toBe("每周日 10:00");
    expect(describeCron("0 10 * * 7")).toBe("每周日 10:00");
    expect(describeCron("0 10 1 * *")).toBe("0 10 1 * *");
  });
});
