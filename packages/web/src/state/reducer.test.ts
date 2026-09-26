import { describe, expect, it } from "vitest";
import { GroupId, Message } from "@baize/shared";
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
