import { describe, expect, it } from "vitest";
import { AgentToControl, ControlOrigin, controlOriginFromAgentUrl } from "../src/index.js";

describe("controlOriginFromAgentUrl", () => {
  it.each([
    ["ws://127.0.0.1:3101/agent", "http://127.0.0.1:3101"],
    ["ws://control-plane:3001/agent", "http://control-plane:3001"],
    ["wss://baize.example.com/agent", "https://baize.example.com"],
    ["wss://baize.example.com:443/agent", "https://baize.example.com"],
    ["ws://localhost:80/agent", "http://localhost"],
    ["ws://[::1]:3001/agent", "http://[::1]:3001"],
    ["wss://baize.example.com:8443/agent?x=1", "https://baize.example.com:8443"],
  ])("%s 自报 %s", (url, origin) => {
    expect(controlOriginFromAgentUrl(url)).toBe(origin);
  });

  it.each([["http://127.0.0.1:3101/agent"], ["不是地址"], ["ws://user:pass@127.0.0.1:3101/agent"]])(
    "%s 推不出源就抛错，代理启动即失败",
    (url) => {
      expect(() => controlOriginFromAgentUrl(url)).toThrow();
    },
  );
});

describe("hello 的 controlOrigin", () => {
  const hello = {
    type: "hello",
    computerId: "c-1",
    token: "t",
    version: "test",
    protocol: 5,
    installId: "f112ce55-14af-49b1-a419-18b2e213f288",
    piSessionVersion: 3,
    uplinkStream: "c-1",
    downApplied: 0,
    activeRuns: [],
  };

  it("只收 http(s) 源本身", () => {
    expect(ControlOrigin.safeParse("https://baize.example.com").success).toBe(true);
    expect(ControlOrigin.safeParse("http://computer-box.internal:3101").success).toBe(true);
    for (const bad of [
      "https://baize.example.com/",
      "https://baize.example.com/gateway",
      "https://baize.example.com?x=1",
      "https://u:p@baize.example.com",
      "ws://baize.example.com",
      "baize.example.com",
      `https://${"a".repeat(256)}.com`,
    ]) {
      expect(ControlOrigin.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("schema 上可缺，留给控制面按协议号判；格式不对整条 hello 不过", () => {
    expect(AgentToControl.safeParse(hello).success).toBe(true);
    expect(AgentToControl.safeParse({ ...hello, controlOrigin: "https://baize.example.com" }).success).toBe(true);
    expect(AgentToControl.safeParse({ ...hello, controlOrigin: "https://baize.example.com/" }).success).toBe(false);
  });
});
