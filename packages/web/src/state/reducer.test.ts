import { describe, expect, it } from "vitest";
import { GroupId, Message, MessageId } from "@baize/shared";
import { reduce } from "./reducer.js";
import { createClock } from "./stamped.js";
import type { Action, AppState, ReadyState, SessionId } from "./types.js";

const GROUP_ID = GroupId.parse("grp_sales");

// 就绪只要一份能进门的入口数据，列表都给空的。
const ready = (session: number): Action =>
  ({
    type: "ready",
    session: session as SessionId,
    user: { id: "usr_chen", email: "chen@baize.dev", name: "陈" },
    bots: [],
    groups: [],
    tools: [],
    settings: {},
    usage: {},
  }) as unknown as Action;

const history = (text: string) => [
  Message.parse({
    id: "msg_old",
    groupId: GROUP_ID,
    body: { kind: "user", text },
    createdAt: "2026-09-26T08:00:00.000Z",
    revision: 0,
  }),
];

const asReady = (state: AppState): ReadyState => {
  if (state.status !== "ready") throw new Error("应当已就绪");
  return state;
};

describe("会话号", () => {
  it("登出再登录后，旧会话发起的动作落地时整条丢掉，新会话的照常写入", () => {
    const next = createClock();
    const first = reduce({ status: "loading" }, ready(1));
    const oldRequest = next();
    const signedOut = reduce(first, { type: "anonymous", login: { kind: "idle" } });
    const second = reduce(signedOut, ready(2));
    const late = asReady(
      reduce(second, {
        type: "from_session",
        session: 1 as SessionId,
        action: { type: "messages_set", groupId: GROUP_ID, messages: history("旧会话的历史"), seq: oldRequest },
      }),
    );
    expect(late.messages.rows[GROUP_ID], "旧会话的历史不能写进新会话").toBeUndefined();
    expect(late.messagesLoadedAt[GROUP_ID], "新会话里这个群还得重新拉历史").toBeUndefined();

    const fresh = asReady(
      reduce(late, {
        type: "from_session",
        session: 2 as SessionId,
        action: { type: "messages_set", groupId: GROUP_ID, messages: history("新会话的历史"), seq: next() },
      }),
    );
    expect(fresh.messages.rows[GROUP_ID]?.map((m) => m.body)).toEqual([{ kind: "user", text: "新会话的历史" }]);
  });

  it("旧会话的 401 不能把新会话踢回登录页", () => {
    const second = reduce(reduce({ status: "loading" }, ready(1)), ready(2));
    const late = reduce(second, {
      type: "from_session",
      session: 1 as SessionId,
      action: { type: "anonymous", login: { kind: "failed", message: "登录已过期，请重新登录" } },
    });
    expect(late.status).toBe("ready");
  });
});

describe("漏档单拉的恢复", () => {
  it("单拉失败到上限之后，推送重连给一轮新机会：次数清零，漏档目标不变", () => {
    const next = createClock();
    const messageId = MessageId.parse("msg_reply");
    const gapped = reduce(reduce({ status: "loading" }, ready(1)), {
      type: "message_delta",
      groupId: GROUP_ID,
      messageId,
      delta: "缺",
      done: false,
      revision: 3,
      seq: next(),
    });
    const failed: Action = { type: "message_gap_failed", messageId };
    const exhausted = asReady([failed, failed, failed].reduce(reduce, gapped));
    expect(exhausted.messageGaps[messageId]?.attempts).toBe(3);
    const reconnected = asReady(reduce(exhausted, { type: "push_reconnected", seq: next() }));
    expect(reconnected.messageGaps[messageId]).toMatchObject({ revision: 3, attempts: 0 });
  });
});
