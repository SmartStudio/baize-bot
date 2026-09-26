import { describe, expect, it } from "vitest";
import { GroupId, Message, MessageId } from "@baize/shared";
import { reduceGroups } from "./groups.js";
import { createClock, emptyShelf, type Seq } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

const GROUP_ID = GroupId.parse("grp_sales");
const MESSAGE_ID = MessageId.parse("msg_reply");
const at = "2026-09-26T08:00:00.000Z";

const bot = (text: string, streaming: boolean) =>
  Message.parse({
    id: MESSAGE_ID,
    groupId: GROUP_ID,
    body: { kind: "bot", botId: "bot_sales", text, streaming },
    createdAt: at,
  });

// 这几条动作只读写群消息，别的字段用不上。
const initial = {
  conversations: [
    { kind: "solo", groupId: GROUP_ID, botId: "bot_sales", lastMessage: null, pendingApprovals: 0, pendingHandoffs: 0 },
  ],
  messages: emptyShelf(),
  messagesLoadedAt: {},
} as unknown as ReadyState;

const delta = (seq: Seq, text: string, done: boolean): Action => ({
  type: "message_delta",
  groupId: GROUP_ID,
  messageId: MESSAGE_ID,
  delta: text,
  done,
  seq,
});

const replyIn = (state: ReadyState) => state.messages.rows[GROUP_ID]?.find((m) => m.id === MESSAGE_ID)?.body;
const idsIn = (state: ReadyState) => state.messages.rows[GROUP_ID]?.map((m) => m.id);

const user = (id: string, text: string) =>
  Message.parse({ id, groupId: GROUP_ID, body: { kind: "user", text }, createdAt: at });

describe("群历史和流式推送的先后", () => {
  it("断线前只收到半句，重连后重拉的历史换成服务端的完整正文", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [], seq: next() });
    const partial = reduceGroups(loaded, delta(next(), "收到。", false));
    const history = next();
    const resynced = reduceGroups(partial, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [bot("收到。我这就去办。", false)],
      seq: history,
    });
    expect(replyIn(resynced)).toEqual(bot("收到。我这就去办。", false).body);
  });

  it("历史请求发出之后才到的 delta，不被晚到的历史盖回去", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [], seq: next() });
    const partial = reduceGroups(loaded, delta(next(), "收到。", false));
    const history = next();
    const grown = reduceGroups(partial, delta(next(), "我这就", false));
    const late = reduceGroups(grown, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [bot("收到。", true)],
      seq: history,
    });
    expect(replyIn(late)).toEqual(bot("收到。我这就", true).body);
  });
});

describe("群历史还在路上时到的推送", () => {
  it("新消息推送先到，历史到了以后它还在，历史里的消息排在前面", () => {
    const next = createClock();
    const history = next();
    const pushed = reduceGroups(initial, { type: "message_upserted", message: user("msg_new", "新消息"), seq: next() });
    expect(pushed.messages.rows[GROUP_ID], "推送不能把这个群算成拉过历史").toBeUndefined();
    expect(pushed.messagesLoadedAt[GROUP_ID], "推送不能把这个群算成拉过历史").toBeUndefined();
    const loaded = reduceGroups(pushed, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [user("msg_old", "旧消息")],
      seq: history,
    });
    expect(idsIn(loaded)).toEqual(["msg_old", "msg_new"]);
  });

  it("空壳推送先到、正文接着流进来，历史里读到的半截盖不回去", () => {
    const next = createClock();
    const history = next();
    const shell = reduceGroups(initial, { type: "message_upserted", message: bot("", true), seq: next() });
    const grown = reduceGroups(reduceGroups(shell, delta(next(), "收到。", false)), delta(next(), "我这就", false));
    const loaded = reduceGroups(grown, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [bot("收到。", true)],
      seq: history,
    });
    expect(replyIn(loaded)).toEqual(bot("收到。我这就", true).body);
  });

  it("没收到空壳的 delta 缺了开头，不记下来，正文以历史为准", () => {
    const next = createClock();
    const history = next();
    const tail = reduceGroups(initial, delta(next(), "我这就", false));
    const loaded = reduceGroups(tail, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [bot("收到。我这就", true)],
      seq: history,
    });
    expect(replyIn(loaded)).toEqual(bot("收到。我这就", true).body);
  });
});
