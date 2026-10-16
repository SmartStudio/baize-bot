import { afterEach, describe, expect, it, vi } from "vitest";
import { BotId, Group, GroupId, Message, Notice, Settings, type ComputerChoices, type ServerPush } from "@baize/shared";
import { createPushHandlers, dispatchServerPush } from "./push.js";
import { emptyShelf, type Seq } from "./stamped.js";
import type { Action, AppState, SessionId } from "./types.js";

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
    reloadChoices: () => undefined,
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
      visibleTo: null,
    });

  const pushedActions = (message: Message) => {
    const actions: { type: string }[] = [];
    const handlers = createPushHandlers({
      session: A,
      live: () => true,
      dispatch: (action) => actions.push(action),
      stateRef: {
        current: {
          status: "ready",
          session: A,
          conversations: [],
          bots: {},
          computerChoices: emptyShelf(),
        } as unknown as AppState,
      },
      refreshPendingCounts: () => undefined,
      recoverLogins: () => undefined,
      reloadChoices: () => undefined,
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

describe("群头的电脑选择跟着推送重拉", () => {
  const TEAM = GroupId.parse("grp_order");
  const OTHER = GroupId.parse("grp_other");
  const SALES = BotId.parse("bot_sales");

  const harness = (loaded: ComputerChoices | null) => {
    const actions: Action[] = [];
    const reloads: [GroupId, Seq][] = [];
    const rows = loaded === null ? {} : { [TEAM]: loaded.map((row) => ({ ...row, id: `${TEAM}/${row.botId}` })) };
    const state = {
      status: "ready",
      session: A,
      conversations: [],
      bots: {},
      computerChoices: { rows, early: {}, stamps: {} },
    } as unknown as AppState;
    const handlers = createPushHandlers({
      session: A,
      live: () => true,
      dispatch: (action) => actions.push(action),
      stateRef: { current: state },
      refreshPendingCounts: () => undefined,
      recoverLogins: () => undefined,
      reloadChoices: (groupId, after) => reloads.push([groupId, after]),
    });
    return {
      push: (push: ServerPush, seq: number) => dispatchServerPush(handlers, push, seq as Seq),
      actions,
      reloads,
    };
  };

  const systemLine = (groupId: GroupId) =>
    Message.parse({
      id: "msg_cost",
      groupId,
      body: { kind: "system", text: "这一轮花了 0.8 元" },
      createdAt: "2026-10-16T08:00:00.000Z",
      revision: 0,
      visibleTo: null,
    });

  const turn = (groupId: GroupId): ServerPush => ({ type: "group_turn", groupId, epoch: 1, current: null, next: [] });

  it("computer_choice_updated 先把选择写进去，再按这条推送的号重拉这个群，拿回 runningOn", () => {
    const { push, actions, reloads } = harness([{ botId: SALES, kind: null, runningOn: "local" }]);
    push({ type: "computer_choice_updated", groupId: TEAM, botId: SALES, kind: "remote" }, 7);
    expect(actions).toEqual([{ type: "computer_choice_set", groupId: TEAM, botId: SALES, kind: "remote", seq: 7 }]);
    expect(reloads, "换到别的电脑时这一轮可能还在原来那台上跑").toEqual([[TEAM, 7]]);
  });

  it("没拉过的群收到 computer_choice_updated 只记下选择，进这个群时再拉", () => {
    const { push, actions, reloads } = harness(null);
    push({ type: "computer_choice_updated", groupId: TEAM, botId: SALES, kind: "remote" }, 3);
    expect(actions.map((action) => action.type)).toEqual(["computer_choice_set"]);
    expect(reloads).toEqual([]);
  });

  it("有成员这一轮还在原来那台上跑时，这个群的消息和回合推送各换一趟重拉，等到跑完那条花费卡把那句收掉", () => {
    const { push, reloads } = harness([{ botId: SALES, kind: "remote", runningOn: "local" }]);
    push({ type: "message", message: systemLine(TEAM) }, 4);
    push(turn(TEAM), 5);
    push({ type: "message", message: systemLine(OTHER) }, 6);
    expect(reloads, "别的群的消息不算").toEqual([
      [TEAM, 4],
      [TEAM, 5],
    ]);
  });

  it("没有在旧电脑上跑完的成员，消息和回合推送都不重拉", () => {
    const { push, reloads } = harness([{ botId: SALES, kind: "remote", runningOn: "remote" }]);
    push({ type: "message", message: systemLine(TEAM) }, 4);
    push(turn(TEAM), 5);
    expect(reloads).toEqual([]);
  });

  it("拉过的群成员变了就重拉，新进来的 Bot 也得有一行", () => {
    const group = Group.parse({
      id: TEAM,
      ownerId: "usr_chen",
      kind: "team",
      botIds: [SALES, "bot_buy"],
      taskId: "tsk_order",
      chiefBotId: null,
      createdAt: "2026-10-16T08:00:00.000Z",
    });
    const loaded = harness([{ botId: SALES, kind: null, runningOn: null }]);
    loaded.push({ type: "group_updated", group }, 9);
    expect(loaded.reloads).toEqual([[TEAM, 9]]);
    const fresh = harness(null);
    fresh.push({ type: "group_updated", group }, 9);
    expect(fresh.reloads, "没拉过的群进来时自己拉").toEqual([]);
  });
});
