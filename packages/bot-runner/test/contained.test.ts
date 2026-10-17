import { describe, expect, it } from "vitest";
import { containmentFor, looksLikeDeleteOrMove } from "../src/contained.js";

describe("containmentFor", () => {
  it.each([
    ["remote", "bwrap", "closed"],
    ["local", "bwrap", "none"],
    ["remote", "seatbelt", "none"],
    ["local", "seatbelt", "none"],
    ["remote", "none", "none"],
    ["local", "none", "none"],
  ] as const)("%s 电脑、%s 沙箱：%s", (kind, sandbox, level) => {
    expect(containmentFor(kind, sandbox)).toEqual({ level });
  });
});

describe("looksLikeDeleteOrMove", () => {
  it("rsync 的 --del 是 --delete-during 的简写，闸门因为联网已经要问，扫描也认出来", () => {
    expect(looksLikeDeleteOrMove("rsync -a --del src/ dst/")).toBe(true);
  });

  it("rsync 的 --delay-updates 不删东西", () => {
    expect(looksLikeDeleteOrMove("rsync -a --delay-updates src/ dst/")).toBe(false);
  });
});
