import { describe, expect, it } from "vitest";
import { RunId } from "@baize/shared";
import { previewOf } from "./preview.js";

describe("previewOf", () => {
  it("单轮花费只在用量页看，侧栏只说已完成", () => {
    expect(previewOf({ kind: "cost", runId: RunId.parse("run-1"), steps: 4, amount: 0.000372 })).toBe("已完成");
  });
});
