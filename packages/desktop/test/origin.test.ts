import { describe, expect, it } from "vitest";
import { normalizedOrigin } from "../src/origin.js";

describe("控制面地址", () => {
  it.each(["http://localhost:3001/path?q=1#top", "http://127.0.0.1:3001", "http://[::1]:3001"])(
    "允许本机 http：%s",
    (value) => {
      expect(normalizedOrigin(value)).toMatch(/^http:\/\//u);
    },
  );

  it("要求远程控制面使用 https", () => {
    expect(() => normalizedOrigin("http://baize.example.com")).toThrow("远程控制面必须使用 https");
    expect(normalizedOrigin("https://baize.example.com/path")).toBe("https://baize.example.com");
  });

  it("拒绝未知协议和无效地址并返回中文错误", () => {
    expect(() => normalizedOrigin("file:///tmp/baize")).toThrow("控制面地址只支持 http 或 https");
    expect(() => normalizedOrigin("not-an-url")).toThrow("控制面地址必须是有效的 http 或 https 地址");
  });
});
