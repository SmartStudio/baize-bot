import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { shouldReportStartFailure, shouldRetryPush, type AgentState } from "../src/agent-state.js";

describe("代理状态转移守卫", () => {
  it("第二次推送连接关闭时不再重连旧连接", () => {
    const oldSocket = {};
    const currentSocket = {};

    expect(shouldRetryPush(false, currentSocket, oldSocket)).toBe(false);
    expect(shouldRetryPush(false, currentSocket, currentSocket)).toBe(true);
    expect(shouldRetryPush(true, currentSocket, currentSocket)).toBe(false);
  });

  it("被替换的 startAgent 失败不上报", () => {
    const child = {} as ChildProcess;
    const otherChild = {} as ChildProcess;
    const replaced: AgentState = { status: "starting", child: otherChild };
    const current: AgentState = { status: "starting", child };

    expect(shouldReportStartFailure(replaced, child)).toBe(false);
    expect(shouldReportStartFailure(current, child)).toBe(true);
  });
});
