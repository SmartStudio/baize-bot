import { describe, expect, it } from "vitest";
import { RunId } from "@baize/shared";
import { formatAmount, previewOf } from "./preview.js";

describe("formatAmount", () => {
  it("keeps one decimal and rounds small costs to four decimals", () => {
    expect([4.6, 0.8, 0.000372, 0].map(formatAmount)).toEqual(["4.6", "0.8", "0.0004", "0.0"]);
  });

  it("uses the same amount in the sidebar preview", () => {
    expect(previewOf({ kind: "cost", runId: RunId.parse("run-1"), steps: 4, amount: 0.000372 })).toBe(
      "本次花费 ¥0.0004",
    );
  });
});
