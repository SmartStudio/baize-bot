import { afterEach, describe, expect, it, vi } from "vitest";
import { Message, Notice, Settings } from "@baize/shared";
import { createPushHandlers, dispatchServerPush } from "./push.js";
import type { Seq } from "./stamped.js";
import type { AppState, SessionId } from "./types.js";

const A = 1 as SessionId;
const B = 2 as SessionId;
const settings = Settings.parse({ theme: "system", notify: true, dndFrom: "22:00", dndTo: "08:00", budget: null });
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

describe("建队卡落地要让首页和项目页的等你重拉", () => {
  const offerMessage = (body: unknown) =>
    Message.parse({
      id: "msg_offer",
      groupId: "grp_assistant",
      body,
      createdAt: "2026-10-09T08:00:00.000Z",
      revision: 0,
    });

  const pushedActions = (message: Message) => {
    const actions: { type: string }[] = [];
    const handlers = createPushHandlers({
      session: A,
      live: () => true,
      dispatch: (action) => actions.push(action),
      stateRef: { current: { status: "ready", session: A, conversations: [], bots: {} } as unknown as AppState },
      refreshPendingCounts: () => undefined,
      recoverLogins: () => undefined,
    });
    dispatchServerPush(handlers, { type: "message", message }, 1 as Seq);
    return actions.map((action) => action.type);
  };

  it("team_offer 那条消息推来时，除了入列还要重拉今天", () => {
    const message = offerMessage({
      kind: "team_offer",
      botId: "bot_assistant",
      members: [{ kind: "existing", botId: "bot_service", note: "盯评论", suggested: false }],
      status: "confirmed",
      groupId: "grp_project",
    });
    expect(pushedActions(message)).toEqual(["message_upserted", "today_version_bumped"]);
  });

  it("别的卡片不顺带重拉", () => {
    expect(pushedActions(offerMessage({ kind: "system", text: "你好", tone: "info" }))).toEqual(["message_upserted"]);
  });
});
