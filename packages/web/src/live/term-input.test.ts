import { describe, expect, it } from "vitest";
import { LiveInput } from "@baize/shared";
import { resizeInput, termInputs } from "./term-input.js";

describe("终端输入按协议上限切帧", () => {
  it("短的一段原样一帧", () => {
    expect(termInputs("ls -la\r")).toEqual([{ kind: "term", data: "ls -la\r" }]);
  });

  it("粘贴超过 8192 字切成几帧，拼回来一字不差，每帧都过得了 schema", () => {
    const pasted = "a".repeat(20000);
    const inputs = termInputs(pasted);
    expect(inputs.length).toBe(3);
    expect(inputs.map((input) => (input.kind === "term" ? input.data : "")).join("")).toBe(pasted);
    for (const input of inputs) expect(LiveInput.safeParse(input).success).toBe(true);
  });

  it("切口落在代理对中间时往前挪一个，不把一个字劈成两半", () => {
    const pasted = `${"a".repeat(8191)}😀b`;
    const inputs = termInputs(pasted);
    const pieces = inputs.map((input) => (input.kind === "term" ? input.data : ""));
    expect(pieces[0]).toBe("a".repeat(8191));
    expect(pieces[1]).toBe("😀b");
  });

  it("空串不发", () => {
    expect(termInputs("")).toEqual([]);
  });
});

describe("resize 夹在协议范围里", () => {
  it("正常尺寸原样发", () => {
    expect(resizeInput(120, 32)).toEqual({ kind: "resize", cols: 120, rows: 32 });
  });

  it("还没量出来的 0 夹到最小值，超大的夹到最大值，都过得了 schema", () => {
    const small = resizeInput(0, 0);
    const large = resizeInput(9999, 9999);
    expect(small).toEqual({ kind: "resize", cols: 2, rows: 2 });
    expect(large).toEqual({ kind: "resize", cols: 500, rows: 200 });
    expect(LiveInput.safeParse(small).success).toBe(true);
  });

  it("NaN 不发", () => {
    expect(resizeInput(Number.NaN, 24)).toBeNull();
  });
});
