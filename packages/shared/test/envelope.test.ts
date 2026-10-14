import { describe, expect, it } from "vitest";
import {
  AgentToControl,
  ControlToAgent,
  DOWNLINK_DELIVERY,
  UPLINK_DELIVERY,
  UplinkFrame,
  type AgentToControl as Uplink,
  type ControlToAgent as Downlink,
} from "../src/protocol.js";

// 新报文必须显式登记送法，漏登记在编译时失败。
// @ts-expect-error 新增类型没有对应送法。
const missingUplink: Record<Uplink["type"] | "future_uplink", "bare" | "reliable"> = UPLINK_DELIVERY;
// @ts-expect-error 新增类型没有对应送法。
const missingDownlink: Record<Downlink["type"] | "future_downlink", "bare" | "reliable"> = DOWNLINK_DELIVERY;
void missingUplink;
void missingDownlink;

describe("协议 3 信封登记", () => {
  it("两张登记表覆盖两个报文联合的全部成员", () => {
    expect(Object.keys(UPLINK_DELIVERY).toSorted()).toEqual(
      AgentToControl.options.map((option) => option.shape.type.value).toSorted(),
    );
    expect(Object.keys(DOWNLINK_DELIVERY).toSorted()).toEqual(
      ControlToAgent.options.map((option) => option.shape.type.value).toSorted(),
    );
  });
  it("bare 报文不能伪装成可靠帧占用序号", () => {
    expect(
      UplinkFrame.safeParse({
        type: "uplink",
        conn: 1,
        stream: "stream",
        seq: 1,
        body: { type: "heartbeat", at: new Date().toISOString() },
      }).success,
    ).toBe(false);
  });
  it("旧 hello 缺少协议号时按 1 解析", () => {
    const hello = AgentToControl.parse({
      type: "hello",
      computerId: "computer",
      token: "token",
      version: "old",
      activeRuns: [],
    });
    expect(hello.type === "hello" && hello.protocol).toBe(1);
  });
});
