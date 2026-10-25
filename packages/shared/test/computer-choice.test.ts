import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL, ControlToAgent, SwitchComputerRequest, SwitchComputerResponse } from "../src/index.js";

describe("换电脑的报文", () => {
  it("请求只认 runId 和 kind，多一个字段就不收", () => {
    expect(SwitchComputerRequest.safeParse({ runId: "run-1", kind: "remote" }).success).toBe(true);
    expect(SwitchComputerRequest.safeParse({ runId: "run-1", kind: "remote", extra: 1 }).success).toBe(false);
    expect(SwitchComputerRequest.safeParse({ runId: "run-1", kind: "tablet" }).success).toBe(false);
  });

  it("回应是 switching 或带原因和文案的 refused", () => {
    expect(SwitchComputerResponse.parse({ result: "switching" })).toEqual({ result: "switching" });
    expect(
      SwitchComputerResponse.parse({ result: "refused", reason: "target_offline", text: "云电脑现在不在线" }),
    ).toEqual({ result: "refused", reason: "target_offline", text: "云电脑现在不在线" });
    expect(
      SwitchComputerResponse.parse({ result: "refused", reason: "routine_failed", text: "这次例行已经记了失败" }),
    ).toEqual({ result: "refused", reason: "routine_failed", text: "这次例行已经记了失败" });
    expect(SwitchComputerResponse.safeParse({ result: "refused", reason: "busy", text: "x" }).success).toBe(false);
    expect(SwitchComputerResponse.safeParse({ result: "switching", reason: "target_offline" }).success).toBe(false);
  });

  it("prompt 的 reason 多一种 continuation", () => {
    expect(AGENT_PROTOCOL).toBe(5);
    const parsed = ControlToAgent.safeParse({
      type: "prompt",
      runId: "run-2",
      botId: "bot-1",
      groupId: "group-1",
      lane: { epoch: 1, heads: {} },
      messageId: "message-1",
      text: "刚才你请求换电脑",
      origin: { kind: "user" },
      table: null,
      routine: null,
      group: { id: "group-1", number: "", title: "小运", kind: "solo" },
      context: [],
      purpose: "plan",
      reason: "continuation",
      task: null,
      members: [],
      computer: null,
    });
    expect(parsed.success, "continuation 是合法的 reason").toBe(true);
  });
});
