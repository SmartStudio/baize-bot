import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice, Settings } from "@baize/shared";
import { createPushHandlers, dispatchServerPush } from "./push.js";
import type { Seq } from "./stamped.js";
import type { AppState, SessionId } from "./types.js";

const A = 1 as SessionId;
const B = 2 as SessionId;
const settings = Settings.parse({ theme: "system", notify: true, dndFrom: "22:00", dndTo: "08:00" });
const notice = Notice.parse({
  kind: "result",
  text: "A 账号的机密通知",
  groupId: null,
  at: "2026-09-26T15:10:00.000Z",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sentFor = (handlerSession: SessionId, stateSession: SessionId, live: boolean) => {
  const notification = vi.fn();
  Object.defineProperty(notification, "permission", { value: "granted" });
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("window", { location: { pathname: "/" } });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });
  const state = { status: "ready", session: stateSession, settings } as unknown as AppState;
  const handlers = createPushHandlers({
    session: handlerSession,
    live: () => live,
    dispatch: () => undefined,
    stateRef: { current: state },
    refreshPendingCounts: () => undefined,
    recoverLogins: () => undefined,
  });
  dispatchServerPush(handlers, { type: "notify", notice }, 1 as Seq);
  return notification.mock.calls.length;
};

describe("推送处理函数绑定创建它的会话", () => {
  it("当前会话的 notify 照常弹系统通知", () => {
    expect(sentFor(A, A, true)).toBe(1);
  });

  it("会话已经不是当前的，notify 不弹", () => {
    expect(sentFor(A, A, false)).toBe(0);
  });

  it("状态已经换成别的会话，旧会话的 notify 不拿新会话的设置弹", () => {
    expect(sentFor(A, B, true)).toBe(0);
  });
});
