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

describe("没有空壳的 delta 和 lastMessage", () => {
  const lastOf = (state: ReadyState) => state.conversations[0]?.lastMessage ?? null;
  const timed = (message: Message, createdAt: string): Message => ({ ...message, createdAt });

  it("没有空壳的 delta 取群里已知最新一条的时间，不用本地时钟，排在已知消息之后", () => {
    const next = createClock();
    const said = timed(user("msg_said", "开干"), "2026-09-26T08:00:05.000Z");
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [said], seq: next() });
    const streamed = reduceGroups(loaded, delta(next(), "收到", false));
    const row = streamed.messages.rows[GROUP_ID]?.find((m) => m.id === MESSAGE_ID);
    expect(row?.createdAt, "本地时钟现在远晚于 2026-09-26，取到它就说明用了本地时间").toBe(said.createdAt);
    expect(idsIn(streamed)).toEqual(["msg_said", MESSAGE_ID]);
  });

  it("同 id 的完整消息到了，时间以服务端为准", () => {
    const next = createClock();
    const said = timed(user("msg_said", "开干"), "2026-09-26T08:00:05.000Z");
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [said], seq: next() });
    const streamed = reduceGroups(loaded, delta(next(), "收到", false));
    const settled = reduceGroups(streamed, {
      type: "message_upserted",
      message: timed(bot("收到。", false), "2026-09-26T08:00:06.000Z"),
      seq: next(),
    });
    expect(settled.messages.rows[GROUP_ID]?.find((m) => m.id === MESSAGE_ID)?.createdAt).toBe(
      "2026-09-26T08:00:06.000Z",
    );
  });

  it("晚到的旧消息不顶掉 lastMessage，同 id 的更新照旧能换", () => {
    const next = createClock();
    const late = timed(bot("较晚的回复", false), "2026-09-26T08:00:09.000Z");
    const early = timed(user("msg_early", "较早的话"), "2026-09-26T08:00:01.000Z");
    const afterLate = reduceGroups(initial, { type: "message_upserted", message: late, seq: next() });
    const afterEarly = reduceGroups(afterLate, { type: "message_upserted", message: early, seq: next() });
    expect(lastOf(afterEarly)?.id).toBe(MESSAGE_ID);
    const edited = timed(bot("较晚的回复，改了", false), "2026-09-26T08:00:08.000Z");
    const afterEdit = reduceGroups(afterEarly, { type: "message_upserted", message: edited, seq: next() });
    expect(lastOf(afterEdit)).toEqual(edited);
  });
});

describe("重拉只回最近一窗历史", () => {
  it("窗口外但本地还留着的行，和窗口内第一条同毫秒时仍排在它前面", () => {
    const next = createClock();
    const sameMs = "2026-09-26T08:00:00.000Z";
    const outside = Message.parse({
      id: "msg_zzzz",
      groupId: GROUP_ID,
      body: { kind: "user", text: "A" },
      createdAt: sameMs,
    });
    const first = Message.parse({
      id: "msg_aaaa",
      groupId: GROUP_ID,
      body: { kind: "bot", botId: "bot_sales", text: "B", streaming: false },
      createdAt: sameMs,
    });
    const later = user("msg_later", "更晚的");
    const laterAt = { ...later, createdAt: "2026-09-26T08:00:09.000Z" };
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [outside, first, laterAt],
      seq: next(),
    });
    const resynced = reduceGroups(loaded, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [first, laterAt],
      seq: next(),
    });
    expect(idsIn(resynced), "A 在窗口外，不能因为接到末尾而排到同毫秒的 B 后面").toEqual([
      "msg_zzzz",
      "msg_aaaa",
      "msg_later",
    ]);
  });

  it("锚点取第一条共享行：A 夹在两条共享行之间，仍接在末尾", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [user("msg_b", "B"), user("msg_a", "A"), user("msg_c", "C")],
      seq: next(),
    });
    const resynced = reduceGroups(loaded, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [user("msg_b", "B"), user("msg_c", "C")],
      seq: next(),
    });
    expect(idsIn(resynced)).toEqual(["msg_b", "msg_c", "msg_a"]);
  });

  it("对照：A 在第一条共享行之前，放到快照前面", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [user("msg_a", "A"), user("msg_b", "B"), user("msg_c", "C")],
      seq: next(),
    });
    const resynced = reduceGroups(loaded, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [user("msg_b", "B"), user("msg_c", "C")],
      seq: next(),
    });
    expect(idsIn(resynced)).toEqual(["msg_a", "msg_b", "msg_c"]);
  });

  it("本地独有、排在快照之后的行照旧接在末尾", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [user("msg_one", "一"), user("msg_two", "二")],
      seq: next(),
    });
    const resynced = reduceGroups(loaded, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [user("msg_one", "一")],
      seq: next(),
    });
    expect(idsIn(resynced)).toEqual(["msg_one", "msg_two"]);
  });
});

describe("群入列按 kind，不按成员数和首席猜", () => {
  const task = {
    id: "tsk_x",
    groupId: GROUP_ID,
    number: "T-0001",
    title: "x",
    summary: "",
    cadence: "",
    dueAt: null,
    checklist: [],
    currentBotId: null,
    handled: [],
    status: "active",
    goal: null,
    metricSource: null,
    metric: null,
  };
  const created = (group: Record<string, unknown>) => {
    const state = reduceGroups({ ...initial, conversations: [] }, {
      type: "group_created",
      group: { id: "grp_new", ownerId: "u1", taskId: "tsk_x", createdAt: at, ...group },
      task,
    } as unknown as Action);
    return state.conversations;
  };

  it("kind 为 solo 入成单聊", () => {
    expect(created({ kind: "solo", botIds: ["bot_a"], chiefBotId: null })).toEqual([
      expect.objectContaining({ kind: "solo", groupId: "grp_new", botId: "bot_a" }),
    ]);
  });

  it("kind 为 team 入成团队群，哪怕只剩一个成员、没有首席", () => {
    expect(created({ kind: "team", botIds: ["bot_a"], chiefBotId: null })).toEqual([
      expect.objectContaining({ kind: "team", groupId: "grp_new", botIds: ["bot_a"], chiefBotId: null }),
    ]);
  });
});
