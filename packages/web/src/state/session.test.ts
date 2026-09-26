import { describe, expect, it } from "vitest";
import { createSessions } from "./session.js";

describe("认证尝试", () => {
  it("新的尝试一开始，旧尝试的请求被取消，旧尝试也进不了会话", () => {
    const sessions = createSessions();
    const login = sessions.attempt();
    const register = sessions.attempt();
    expect(login.signal.aborted, "旧尝试在途的请求被取消").toBe(true);
    expect(sessions.begin(register), "最近一次尝试进了会话").not.toBeNull();
    expect(sessions.begin(login), "晚到的旧尝试进不了会话").toBeNull();
    expect(sessions.current()?.signal, "会话接着用最近一次尝试的 signal").toBe(register.signal);
  });

  it("同一次尝试只能进一次会话", () => {
    const sessions = createSessions();
    const attempt = sessions.attempt();
    const first = sessions.begin(attempt);
    expect(sessions.begin(attempt)).toBeNull();
    expect(sessions.current()?.id).toBe(first);
  });
});
