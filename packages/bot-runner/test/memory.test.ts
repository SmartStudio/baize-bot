import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { readMemoryShown, recordMemoryShown } from "../src/watermark.js";

describe("记忆给过的记号", () => {
  it("新会话什么都没给过，记一次以后读得回来，没变不重复记", () => {
    const sessions = SessionManager.inMemory();
    expect(readMemoryShown(sessions)).toEqual({ brand: false, preferences: false });

    recordMemoryShown(sessions, { brand: true, preferences: false }, readMemoryShown(sessions));
    recordMemoryShown(sessions, { brand: true, preferences: false }, readMemoryShown(sessions));

    expect(readMemoryShown(sessions)).toEqual({ brand: true, preferences: false });
    expect(sessions.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
  });

  it("会话压缩不抹掉记号：摘要里还留着旧偏好，之后清空仍要说作废", () => {
    const sessions = SessionManager.inMemory();
    recordMemoryShown(sessions, { brand: true, preferences: true }, readMemoryShown(sessions));
    sessions.appendCompaction("之前聊过的摘要", null, 1000);

    expect(readMemoryShown(sessions)).toEqual({ brand: true, preferences: true });
  });

  it("形状对不上的记号当没给过", () => {
    const sessions = SessionManager.inMemory();
    sessions.appendCustomEntry("baize.memory-shown", { brand: "yes" });

    expect(readMemoryShown(sessions)).toEqual({ brand: false, preferences: false });
  });
});
