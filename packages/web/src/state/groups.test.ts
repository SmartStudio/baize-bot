import { describe, expect, it } from "vitest";
import { BotId, GroupId, Message, MessageId, type Bot, type ToolConnection } from "@baize/shared";
import { reduceGroups } from "./groups.js";
import { createClock, emptyShelf, type Seq } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

const GROUP_ID = GroupId.parse("grp_sales");
const MESSAGE_ID = MessageId.parse("msg_reply");
const at = "2026-09-26T08:00:00.000Z";

// revision 是服务端写这条的第几次：空壳 0，每接一段 delta 加一。
const bot = (text: string, streaming: boolean, revision: number) =>
  Message.parse({
    id: MESSAGE_ID,
    groupId: GROUP_ID,
    body: { kind: "bot", botId: "bot_sales", text, streaming },
    createdAt: at,
    revision,
    visibleTo: null,
  });

// 这几条动作只读写群消息，别的字段用不上。
const initial = {
  conversations: [
    { kind: "solo", groupId: GROUP_ID, botId: "bot_sales", lastMessage: null, pendingApprovals: 0, pendingHandoffs: 0 },
  ],
  messages: emptyShelf(),
  messagesLoadedAt: {},
  messageEdges: {},
  messageGaps: {},
  deletedBotIds: [],
  unlistedCounts: {},
  tools: [],
} as unknown as ReadyState;

const delta = (
  seq: Seq,
  text: string,
  done: boolean,
  revision: number,
  { groupId = GROUP_ID, messageId = MESSAGE_ID }: { groupId?: GroupId; messageId?: MessageId } = {},
): Action => ({
  type: "message_delta",
  groupId,
  messageId,
  delta: text,
  done,
  revision,
  visibleTo: null,
  seq,
});

const replyIn = (state: ReadyState) => state.messages.rows[GROUP_ID]?.find((m) => m.id === MESSAGE_ID)?.body;
const idsIn = (state: ReadyState) => state.messages.rows[GROUP_ID]?.map((m) => m.id);

const user = (id: string, text: string) =>
  Message.parse({ id, groupId: GROUP_ID, body: { kind: "user", text }, createdAt: at, revision: 0, visibleTo: null });

describe("群历史和流式推送的先后", () => {
  it("断线前只收到半句，重连后重拉的历史换成服务端的完整正文", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [],
      seq: next(),
    });
    const partial = reduceGroups(loaded, delta(next(), "收到。", false, 1));
    const history = next();
    const resynced = reduceGroups(partial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [bot("收到。我这就去办。", false, 3)],
      seq: history,
    });
    expect(replyIn(resynced)).toEqual(bot("收到。我这就去办。", false, 3).body);
  });

  it("历史请求发出之后才到的 delta，不被晚到的历史盖回去", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [],
      seq: next(),
    });
    const partial = reduceGroups(loaded, delta(next(), "收到。", false, 1));
    const history = next();
    const grown = reduceGroups(partial, delta(next(), "我这就", false, 2));
    const late = reduceGroups(grown, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [bot("收到。", true, 1)],
      seq: history,
    });
    expect(replyIn(late)).toEqual(bot("收到。我这就", true, 2).body);
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
      hasMore: false,
      groupId: GROUP_ID,
      messages: [user("msg_old", "旧消息")],
      seq: history,
    });
    expect(idsIn(loaded)).toEqual(["msg_old", "msg_new"]);
  });

  it("空壳推送先到、正文接着流进来，历史里读到的半截盖不回去", () => {
    const next = createClock();
    const history = next();
    const shell = reduceGroups(initial, { type: "message_upserted", message: bot("", true, 0), seq: next() });
    const grown = reduceGroups(
      reduceGroups(shell, delta(next(), "收到。", false, 1)),
      delta(next(), "我这就", false, 2),
    );
    const loaded = reduceGroups(grown, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [bot("收到。", true, 1)],
      seq: history,
    });
    expect(replyIn(loaded)).toEqual(bot("收到。我这就", true, 2).body);
  });

  it("没收到空壳的 delta 缺了开头，不记下来，正文以历史为准", () => {
    const next = createClock();
    const history = next();
    const tail = reduceGroups(initial, delta(next(), "我这就", false, 2));
    expect(tail.messageGaps[MESSAGE_ID]?.revision, "缺了第 1 版，记下这条要单独拉").toBe(2);
    const loaded = reduceGroups(tail, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [bot("收到。我这就", true, 2)],
      seq: history,
    });
    expect(replyIn(loaded)).toEqual(bot("收到。我这就", true, 2).body);
    expect(loaded.messageGaps[MESSAGE_ID], "历史里已有第 2 版，不用再拉").toBeUndefined();
  });

  it("历史请求在路上时到的第一段 delta 就是全文，历史晚到的 0 版空壳盖不掉它", () => {
    const next = createClock();
    const history = next();
    const streamed = reduceGroups(initial, delta(next(), "甲", true, 1));
    expect(streamed.conversations[0]?.lastMessage?.body).toEqual(bot("甲", false, 1).body);
    const loaded = reduceGroups(streamed, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [bot("", true, 0)],
      seq: history,
    });
    expect(replyIn(loaded), "正文收敛到服务端的 1 版，不是空壳").toEqual(bot("甲", false, 1).body);
    expect(loaded.conversations[0]?.lastMessage?.body).toEqual(bot("甲", false, 1).body);
  });
});

describe("同一条消息的旧版本晚到", () => {
  const loadedWith = (messages: Message[]) => {
    const next = createClock();
    const state = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages,
      seq: next(),
    });
    return { next, state };
  };

  it("完整正文先到、旧 delta 后到，正文不重复、不重标 streaming", () => {
    const { next, state } = loadedWith([]);
    const full = reduceGroups(state, {
      type: "message_upserted",
      message: bot("收到。我这就去办。", false, 3),
      seq: next(),
    });
    const stale = reduceGroups(full, delta(next(), "我这就", false, 2));
    expect(replyIn(stale)).toEqual(bot("收到。我这就去办。", false, 3).body);
    const staleDone = reduceGroups(stale, delta(next(), "", true, 3));
    expect(replyIn(staleDone), "同版本的收尾帧也是旧帧").toEqual(bot("收到。我这就去办。", false, 3).body);
  });

  it("较新的完整消息之后，较旧的完整消息到了不回退", () => {
    const { next, state } = loadedWith([]);
    const newer = reduceGroups(state, { type: "message_upserted", message: bot("定稿", false, 4), seq: next() });
    const older = reduceGroups(newer, { type: "message_upserted", message: bot("半截", true, 2), seq: next() });
    expect(replyIn(older)).toEqual(bot("定稿", false, 4).body);
    expect(older.conversations[0]?.lastMessage?.revision, "侧栏摘要也不回退").toBe(4);
  });

  it("历史没拉过时，侧栏摘要已是较新版本，晚到的旧 delta 不把它换回半截", () => {
    const listed = bot("定稿", false, 4);
    const fromList = {
      ...initial,
      conversations: initial.conversations.map((c) => ({ ...c, lastMessage: listed })),
    } as ReadyState;
    const stale = reduceGroups(fromList, delta(1 as Seq, "半", false, 2));
    expect(stale.conversations[0]?.lastMessage).toEqual(listed);
  });

  it("重连后拉的历史比途中到的 delta 新，就算历史请求先发出，也换成历史那份", () => {
    const next = createClock();
    const shell = reduceGroups(initial, { type: "message_upserted", message: bot("", true, 0), seq: next() });
    const history = next();
    const streamed = reduceGroups(shell, delta(next(), "收到。", false, 1));
    const loaded = reduceGroups(streamed, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [bot("收到。我这就去办。", false, 3)],
      seq: history,
    });
    expect(replyIn(loaded)).toEqual(bot("收到。我这就去办。", false, 3).body);
    const late = reduceGroups(loaded, delta(next(), "我这就", false, 2));
    expect(replyIn(late), "历史之后再到的旧 delta 也不接").toEqual(bot("收到。我这就去办。", false, 3).body);
  });

  it("delta 中间漏了一版就不接，记下这一条要单独拉回来", () => {
    const { next, state } = loadedWith([bot("收到。", true, 1)]);
    expect(state.messageGaps[MESSAGE_ID]).toBeUndefined();
    const gapAt = next();
    const gapped = reduceGroups(state, delta(gapAt, "去办。", true, 3));
    expect(replyIn(gapped), "缺了第 2 版那段，接上去正文就少一截").toEqual(bot("收到。", true, 1).body);
    expect(gapped.messageGaps[MESSAGE_ID]).toEqual({ groupId: GROUP_ID, revision: 3, seq: gapAt, attempts: 0 });
    const resumed = reduceGroups(state, delta(next(), "我这就", false, 2));
    expect(replyIn(resumed), "紧挨着的下一版照接").toEqual(bot("收到。我这就", true, 2).body);
  });

  it("漏档的消息落出了历史最近一页，重拉历史补不上，单独拉回这一条才算补齐", () => {
    const { next, state } = loadedWith([bot("收到。", true, 1)]);
    const gapped = reduceGroups(state, delta(next(), "去办。", true, 3));
    const window = reduceGroups(gapped, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [user("msg_newer", "后来的话")],
      seq: next(),
    });
    expect(replyIn(window), "历史里没有这条，本地半截照留").toEqual(bot("收到。", true, 1).body);
    expect(window.messageGaps[MESSAGE_ID]?.revision, "历史没带回这条，漏档还在").toBe(3);
    const fetched = reduceGroups(window, {
      type: "message_upserted",
      message: bot("收到。我这就去办。", false, 3),
      seq: next(),
    });
    expect(replyIn(fetched)).toEqual(bot("收到。我这就去办。", false, 3).body);
    expect(fetched.messageGaps[MESSAGE_ID]).toBeUndefined();
  });

  it("同版本的非空 delta 是重复帧，正文和侧栏摘要都不变", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [],
      seq: next(),
    });
    const first = reduceGroups(loaded, delta(next(), "甲", false, 1));
    const again = reduceGroups(first, delta(next(), "乙", false, 1));
    expect(replyIn(again)).toEqual(bot("甲", true, 1).body);
    expect(again.conversations[0]?.lastMessage?.body).toEqual(bot("甲", true, 1).body);
    const twice = reduceGroups(again, delta(next(), "乙", false, 2));
    const repeated = reduceGroups(twice, delta(next(), "乙", false, 2));
    expect(replyIn(repeated), "第 2 版只接一次").toEqual(bot("甲乙", true, 2).body);
    expect(repeated.conversations[0]?.lastMessage?.body).toEqual(bot("甲乙", true, 2).body);
  });

  it("历史没拉过时，同版本的非空 delta 不改侧栏摘要，下一版接在摘要上", () => {
    const listed = bot("甲乙丙", true, 3);
    const fromList = {
      ...initial,
      conversations: initial.conversations.map((c) => ({ ...c, lastMessage: listed })),
    } as ReadyState;
    const repeated = reduceGroups(fromList, delta(1 as Seq, "丙", false, 3));
    expect(repeated.conversations[0]?.lastMessage).toEqual(listed);
    const grown = reduceGroups(repeated, delta(2 as Seq, "丁", true, 4));
    expect(grown.conversations[0]?.lastMessage?.body).toEqual(bot("甲乙丙丁", false, 4).body);
  });
});

describe("漏档单拉的失败和失效", () => {
  const OTHER_GROUP = GroupId.parse("grp_other");
  const gappedIn = () => {
    const next = createClock();
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [bot("收到。", true, 1)],
      seq: next(),
    });
    return { next, state: reduceGroups(loaded, delta(next(), "去办。", true, 3)) };
  };
  const failed: Action = { type: "message_gap_failed", messageId: MESSAGE_ID };

  it("单拉失败一次记一次，后来的 delta 不把次数清零，单拉不会被帧带着无限重来", () => {
    const { next, state } = gappedIn();
    const once = reduceGroups(state, failed);
    expect(once.messageGaps[MESSAGE_ID]?.attempts).toBe(1);
    expect(once.messageGaps, "失败要换出新的漏档表，MainWindow 才会再拉一趟").not.toBe(state.messageGaps);
    const thrice = reduceGroups(reduceGroups(once, failed), failed);
    const later = reduceGroups(thrice, delta(next(), "了", true, 4));
    expect(later.messageGaps[MESSAGE_ID]).toMatchObject({ revision: 4, attempts: 3 });
  });

  it("乱序晚到的旧帧不把漏档目标往回拉，单拉回来的旧版补不上这条漏档", () => {
    const { next, state } = gappedIn();
    const ahead = reduceGroups(state, delta(next(), "后面", true, 5));
    const late = reduceGroups(ahead, delta(next(), "晚到", true, 4));
    expect(late.messageGaps[MESSAGE_ID]?.revision, "目标还是见过的最新一版").toBe(5);
    const stale = reduceGroups(late, { type: "message_upserted", message: bot("第四版", true, 4), seq: next() });
    expect(stale.messageGaps[MESSAGE_ID], "拉回第四版不够，第五版还缺着").toMatchObject({ revision: 5 });
  });

  it("失败到上限之后，这个群重拉历史给一轮新机会，别的群的不动", () => {
    const { next, state } = gappedIn();
    const elsewhere = reduceGroups(
      state,
      delta(next(), "别处", true, 5, { groupId: OTHER_GROUP, messageId: MessageId.parse("msg_elsewhere") }),
    );
    const elsewhereFailed = reduceGroups(elsewhere, {
      type: "message_gap_failed",
      messageId: MessageId.parse("msg_elsewhere"),
    });
    const exhausted = [failed, failed, failed].reduce(reduceGroups, elsewhereFailed);
    expect(exhausted.messageGaps[MESSAGE_ID]?.attempts).toBe(3);
    const reloaded = reduceGroups(exhausted, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [user("msg_newer", "后来的话")],
      seq: next(),
    });
    expect(reloaded.messageGaps[MESSAGE_ID], "历史没带回这条，漏档还在，次数清零再拉").toMatchObject({
      revision: 3,
      attempts: 0,
    });
    expect(reloaded.messageGaps[MessageId.parse("msg_elsewhere")]?.attempts).toBe(1);
  });

  it("单拉回 404 是终态，这条漏档清掉，别的照留", () => {
    const { next, state } = gappedIn();
    const other = MessageId.parse("msg_other");
    const two = reduceGroups(state, delta(next(), "另一条", true, 2, { messageId: other }));
    const gone = reduceGroups(two, { type: "message_gone", messageId: MESSAGE_ID });
    expect(gone.messageGaps[MESSAGE_ID]).toBeUndefined();
    expect(gone.messageGaps[other]?.revision).toBe(2);
  });

  const TEAM = GroupId.parse("grp_team");
  const SHARED = GroupId.parse("grp_shared");
  const teamOf = (groupId: GroupId, botIds: string[]) => ({
    kind: "team",
    groupId,
    botIds,
    lastMessage: null,
    pendingApprovals: 0,
    pendingHandoffs: 0,
  });
  // 团队群的 botIds 是建群时的名单，删 Bot 不改它；还在不在只看 Bot 表。
  const withTeams = (teams: ReturnType<typeof teamOf>[], botIds: string[]) =>
    ({
      ...initial,
      bots: Object.fromEntries(botIds.map((id) => [id, { id }])),
      conversations: [...initial.conversations, ...teams],
    }) as unknown as ReadyState;
  const removed = (botId: string): Action => ({ type: "bot_removed", botId: BotId.parse(botId) });

  it("删掉 Bot 时，它的单聊和成员都已不在的团队群里的漏档一起清掉，还有别的成员的群照留", () => {
    const next = createClock();
    const gapIn = (groupId: GroupId, id: string): Action =>
      delta(next(), "缺", true, 3, { groupId, messageId: MessageId.parse(id) });
    const gapped = [gapIn(GROUP_ID, "msg_solo"), gapIn(TEAM, "msg_team"), gapIn(SHARED, "msg_shared")].reduce(
      reduceGroups,
      withTeams([teamOf(TEAM, ["bot_sales"]), teamOf(SHARED, ["bot_sales", "bot_other"])], ["bot_sales", "bot_other"]),
    );
    expect(Object.keys(reduceGroups(gapped, removed("bot_sales")).messageGaps)).toEqual(["msg_shared"]);
  });

  it("两人团队的成员依次删光：删第一个时漏档照留，删第二个时清掉，失败到上限的也清", () => {
    const next = createClock();
    const capped = [
      delta(next(), "缺", true, 3, { groupId: TEAM, messageId: MessageId.parse("msg_team_dead") }),
      { type: "message_gap_failed", messageId: MessageId.parse("msg_team_dead") },
      { type: "message_gap_failed", messageId: MessageId.parse("msg_team_dead") },
      { type: "message_gap_failed", messageId: MessageId.parse("msg_team_dead") },
    ].reduce<ReadyState>(
      (state, action) => reduceGroups(state, action as Action),
      withTeams([teamOf(TEAM, ["bot_service", "bot_sales"])], ["bot_service", "bot_sales"]),
    );
    expect(capped.messageGaps["msg_team_dead" as MessageId]?.attempts).toBe(3);
    const half = reduceGroups(capped, removed("bot_service"));
    expect(Object.keys(half.messageGaps), "还剩小销，群还在").toEqual(["msg_team_dead"]);
    const empty = reduceGroups(half, removed("bot_sales"));
    expect(empty.messageGaps, "成员删光，服务端对这个群只回 404").toEqual({});
  });

  it("Bot 表里没有的成员不算删了：入口快照之后才建的群，删无关的 Bot、删它一个已知成员，漏档都照留", () => {
    const next = createClock();
    const LATER = GroupId.parse("grp_later");
    const MIXED = GroupId.parse("grp_mixed");
    const gapped = [
      delta(next(), "缺", true, 3, { groupId: LATER, messageId: MessageId.parse("msg_later") }),
      delta(next(), "缺", true, 3, { groupId: MIXED, messageId: MessageId.parse("msg_mixed") }),
    ].reduce(
      reduceGroups,
      withTeams(
        [teamOf(LATER, ["bot_new_a", "bot_new_b"]), teamOf(MIXED, ["bot_sales", "bot_new_a"])],
        ["bot_sales", "bot_other"],
      ),
    );
    const unrelated = reduceGroups(gapped, removed("bot_other"));
    expect(Object.keys(unrelated.messageGaps), "两个新成员只是 Bot 表还没有").toEqual(["msg_later", "msg_mixed"]);
    const member = reduceGroups(unrelated, removed("bot_sales"));
    expect(Object.keys(member.messageGaps), "还有一个没删的新成员，群还在").toEqual(["msg_later", "msg_mixed"]);
  });
});

describe("没有空壳的 delta 和 lastMessage", () => {
  const lastOf = (state: ReadyState) => state.conversations[0]?.lastMessage ?? null;
  const timed = (message: Message, createdAt: string): Message => ({ ...message, createdAt });

  it("没有空壳的 delta 取群里已知最新一条的时间，不用本地时钟，排在已知消息之后", () => {
    const next = createClock();
    const said = timed(user("msg_said", "开干"), "2026-09-26T08:00:05.000Z");
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [said],
      seq: next(),
    });
    const streamed = reduceGroups(loaded, delta(next(), "收到", false, 1));
    const row = streamed.messages.rows[GROUP_ID]?.find((m) => m.id === MESSAGE_ID);
    expect(row?.createdAt, "本地时钟现在远晚于 2026-09-26，取到它就说明用了本地时间").toBe(said.createdAt);
    expect(idsIn(streamed)).toEqual(["msg_said", MESSAGE_ID]);
  });

  it("同 id 的完整消息到了，时间以服务端为准", () => {
    const next = createClock();
    const said = timed(user("msg_said", "开干"), "2026-09-26T08:00:05.000Z");
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [said],
      seq: next(),
    });
    const streamed = reduceGroups(loaded, delta(next(), "收到", false, 1));
    const settled = reduceGroups(streamed, {
      type: "message_upserted",
      message: timed(bot("收到。", false, 2), "2026-09-26T08:00:06.000Z"),
      seq: next(),
    });
    expect(settled.messages.rows[GROUP_ID]?.find((m) => m.id === MESSAGE_ID)?.createdAt).toBe(
      "2026-09-26T08:00:06.000Z",
    );
  });

  it("重拉的历史刷新侧栏的最近一条：同 id 更新的版本、更晚的新消息都换上", () => {
    const next = createClock();
    const shell = timed(bot("", true, 0), "2026-09-26T08:00:01.000Z");
    const pushed = reduceGroups(initial, { type: "message_upserted", message: shell, seq: next() });
    expect(lastOf(pushed)).toEqual(shell);
    const settled = timed(bot("收到。", false, 2), "2026-09-26T08:00:01.000Z");
    const loaded = reduceGroups(pushed, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [settled],
      seq: next(),
    });
    expect(lastOf(loaded), "同一条的更新版本").toEqual(settled);
    const newer = timed(user("msg_newer", "再说一句"), "2026-09-26T08:00:05.000Z");
    const reloaded = reduceGroups(loaded, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [settled, newer],
      seq: next(),
    });
    expect(lastOf(reloaded), "更晚的新消息").toEqual(newer);
  });

  it("同毫秒的另一条已是最近一条时，同版完整消息重到不把摘要换回去", () => {
    const next = createClock();
    const replied = bot("收到。", false, 3);
    const later = user("msg_later", "同一毫秒的下一句");
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [replied, later],
      seq: next(),
    });
    expect(lastOf(loaded)?.id).toBe("msg_later");
    const again = reduceGroups(loaded, { type: "message_upserted", message: bot("收到。", false, 3), seq: next() });
    expect(lastOf(again)?.id, "同版本没写进架子，侧栏也不能动").toBe("msg_later");
  });

  it("晚到的旧消息不顶掉 lastMessage，同 id 的更新照旧能换", () => {
    const next = createClock();
    const late = timed(bot("较晚的回复", false, 0), "2026-09-26T08:00:09.000Z");
    const early = timed(user("msg_early", "较早的话"), "2026-09-26T08:00:01.000Z");
    const afterLate = reduceGroups(initial, { type: "message_upserted", message: late, seq: next() });
    const afterEarly = reduceGroups(afterLate, { type: "message_upserted", message: early, seq: next() });
    expect(lastOf(afterEarly)?.id).toBe(MESSAGE_ID);
    const edited = timed(bot("较晚的回复，改了", false, 1), "2026-09-26T08:00:08.000Z");
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
      revision: 0,
      visibleTo: null,
    });
    const first = Message.parse({
      id: "msg_aaaa",
      groupId: GROUP_ID,
      body: { kind: "bot", botId: "bot_sales", text: "B", streaming: false },
      createdAt: sameMs,
      revision: 0,
      visibleTo: null,
    });
    const later = user("msg_later", "更晚的");
    const laterAt = { ...later, createdAt: "2026-09-26T08:00:09.000Z" };
    const loaded = reduceGroups(initial, {
      type: "messages_set",
      hasMore: false,
      groupId: GROUP_ID,
      messages: [outside, first, laterAt],
      seq: next(),
    });
    const resynced = reduceGroups(loaded, {
      type: "messages_set",
      hasMore: false,
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
      hasMore: false,
      groupId: GROUP_ID,
      messages: [user("msg_b", "B"), user("msg_a", "A"), user("msg_c", "C")],
      seq: next(),
    });
    const resynced = reduceGroups(loaded, {
      type: "messages_set",
      hasMore: false,
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
      hasMore: false,
      groupId: GROUP_ID,
      messages: [user("msg_a", "A"), user("msg_b", "B"), user("msg_c", "C")],
      seq: next(),
    });
    const resynced = reduceGroups(loaded, {
      type: "messages_set",
      hasMore: false,
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
      hasMore: false,
      groupId: GROUP_ID,
      messages: [user("msg_one", "一"), user("msg_two", "二")],
      seq: next(),
    });
    const resynced = reduceGroups(loaded, {
      type: "messages_set",
      hasMore: false,
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
    metricSources: [],
    metric: { kind: "unread" },
    metrics: [],
  };
  const created = (group: Record<string, unknown>) => {
    const state = reduceGroups({ ...initial, conversations: [], groupStamps: {} }, {
      type: "group_created",
      group: { id: "grp_new", ownerId: "u1", taskId: "tsk_x", createdAt: at, ...group },
      task,
      seq: 1,
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

describe("新群入列前先回来的计数", () => {
  const task = { id: "tsk_new", title: "新项目", currentBotId: null };
  const group = { id: "grp_new", kind: "team", botIds: ["bot_a", "bot_b"], chiefBotId: null };
  const item = (pendingApprovals: number) => ({ group, task, lastMessage: null, pendingApprovals, pendingHandoffs: 0 });
  const empty = { ...initial, conversations: [], groupStamps: {}, countStamps: {} } as unknown as ReadyState;
  const counted = (seq: Seq) =>
    reduceGroups(empty, { type: "pending_counts_loaded", bots: [], groups: [item(1)], seq } as unknown as Action);
  const pendingOf = (state: ReadyState) => state.conversations.find((c) => c.groupId === "grp_new")?.pendingApprovals;

  it("更早发出的名单后到，新群入列用较新的计数，不写名单里的旧数", () => {
    const next = createClock();
    const roster = next();
    const listed = reduceGroups(counted(next()), {
      type: "groups_loaded",
      groups: [item(0)],
      seq: roster,
    } as unknown as Action);
    expect(pendingOf(listed)).toBe(1);
  });

  it("更晚发出的名单照常写它自己的数", () => {
    const next = createClock();
    const early = counted(next());
    const listed = reduceGroups(early, { type: "groups_loaded", groups: [item(0)], seq: next() } as unknown as Action);
    expect(pendingOf(listed)).toBe(0);
  });

  it("建群推送晚于计数到，新群带着已收到的计数入列", () => {
    const next = createClock();
    const created = reduceGroups(counted(next()), {
      type: "group_created",
      group: { ...group, ownerId: "u1", taskId: "tsk_new", createdAt: at },
      task,
      seq: next(),
    } as unknown as Action);
    expect(pendingOf(created)).toBe(1);
  });
});

describe("没入列的群，计数缓存只留最新完整计数里还有的", () => {
  const task = { id: "tsk_new", title: "新项目", currentBotId: null };
  const group = { id: "grp_new", kind: "team", botIds: ["bot_a", "bot_b"], chiefBotId: null };
  const GROUP = GroupId.parse("grp_new");
  const team = (id: string, pendingApprovals: number, pendingHandoffs = 0) => ({
    group: { ...group, id },
    task,
    lastMessage: null,
    pendingApprovals,
    pendingHandoffs,
  });
  const solo = (botId: string, groupId: string, pendingApprovals: number, pendingHandoffs = 0) => ({
    bot: { id: botId },
    groupId,
    lastMessage: null,
    pendingApprovals,
    pendingHandoffs,
  });
  const empty = { ...initial, conversations: [], groupStamps: {}, countStamps: {} } as unknown as ReadyState;
  const counts = (
    state: ReadyState,
    seq: Seq,
    groups: ReturnType<typeof team>[],
    bots: ReturnType<typeof solo>[] = [],
  ) => reduceGroups(state, { type: "pending_counts_loaded", bots, groups, seq } as unknown as Action);
  const roster = (state: ReadyState, seq: Seq, groups: ReturnType<typeof team>[]) =>
    reduceGroups(state, { type: "groups_loaded", groups, seq } as unknown as Action);

  it("后发的完整计数里没有这个群，缓存回收；更早发出的计数晚到也塞不回来", () => {
    const next = createClock();
    const [first, rosterSeq, laggard, full] = [next(), next(), next(), next()];
    const cached = counts(empty, first, [team("grp_new", 1, 2)]);
    expect(cached.unlistedCounts[GROUP], "入列前先到的计数先记着").toEqual({ pendingApprovals: 1, pendingHandoffs: 2 });
    const unlisted = roster(cached, rosterSeq, []);
    const swept = counts(unlisted, full, [team("grp_other", 0)]);
    expect(swept.unlistedCounts[GROUP], "更晚的完整计数确认没有这个群").toBeUndefined();
    const afterLaggard = counts(swept, laggard, [team("grp_new", 1, 2)]);
    expect(afterLaggard.unlistedCounts[GROUP], "回收那份之前发出的计数晚到，不再写回").toBeUndefined();
  });

  it("更早发出的完整计数里没有这个群，不清掉较新的缓存", () => {
    const next = createClock();
    const stale = next();
    const fresh = next();
    const cached = counts(empty, fresh, [team("grp_new", 1, 2)]);
    const afterStale = counts(cached, stale, [team("grp_other", 0)]);
    expect(afterStale.unlistedCounts[GROUP], "旧快照没资格说这个群不存在").toEqual({
      pendingApprovals: 1,
      pendingHandoffs: 2,
    });
    const listed = roster(afterStale, next(), [team("grp_new", 0)]);
    expect(listed.conversations.find((c) => c.groupId === GROUP)?.pendingApprovals).toBe(0);
  });

  it("完整计数里还有这个群就留着，换成最新的数", () => {
    const next = createClock();
    const first = counts(empty, next(), [team("grp_new", 1, 2)]);
    const second = counts(first, next(), [team("grp_new", 3, 0)]);
    expect(second.unlistedCounts[GROUP]).toEqual({ pendingApprovals: 3, pendingHandoffs: 0 });
  });

  it("名单里移除的群，更早发出的计数晚到，不再缓存", () => {
    const next = createClock();
    const admitted = next();
    const lateCounts = next();
    const removed = next();
    const listed = roster(empty, admitted, [team("grp_new", 0)]);
    expect(
      listed.conversations.map((c) => c.groupId),
      "名单把它收进来",
    ).toEqual([GROUP]);
    const gone = roster(listed, removed, []);
    expect(gone.conversations, "更晚的名单没有它，移掉").toEqual([]);
    const afterLate = counts(gone, lateCounts, [team("grp_new", 1, 2)]);
    expect(afterLate.unlistedCounts[GROUP], "移除之前发出的计数不能把它的数塞回缓存").toBeUndefined();
    const afterNewer = counts(afterLate, next(), [team("grp_other", 0)]);
    expect(afterNewer.unlistedCounts[GROUP], "更晚的完整计数里没有它，也不会被带回来").toBeUndefined();
  });

  it("单聊 Bot 在建群推送之前被删，之后的完整计数里没有它，缓存回收", () => {
    const next = createClock();
    const cached = counts(empty, next(), [], [solo("bot_new", "grp_solo", 2, 1)]);
    expect(cached.unlistedCounts[GroupId.parse("grp_solo")], "新 Bot 的计数先到").toEqual({
      pendingApprovals: 2,
      pendingHandoffs: 1,
    });
    const removed = reduceGroups(cached, { type: "bot_removed", botId: "bot_new" } as unknown as Action);
    const after = counts(removed, next(), [team("grp_other", 0)], [solo("bot_kept", "grp_kept", 0)]);
    expect(after.unlistedCounts[GroupId.parse("grp_solo")], "被删的 Bot 不在完整计数里").toBeUndefined();
    expect(Object.keys(after.unlistedCounts).sort(), "别的没入列的群照旧").toEqual(["grp_kept", "grp_other"]);
  });
});

describe("建 Bot 的回包和删除推送的先后", () => {
  it("删除推送先到，晚到的建 Bot 回包不把它加回团队和单聊", () => {
    const botId = BotId.parse("bot_imported");
    const groupId = GroupId.parse("grp_imported");
    const created = { id: botId, name: "导入的" } as unknown as Bot;
    const removed = reduceGroups({ ...initial, bots: {} } as ReadyState, { type: "bot_removed", botId });
    const late = reduceGroups(removed, { type: "bot_created", bot: created, groupId });
    expect(late.bots[botId], "已删的 Bot 不回到 Bot 表").toBeUndefined();
    expect(
      late.conversations.some((c) => c.groupId === groupId),
      "已删的 Bot 不多出一个单聊",
    ).toBe(false);
  });
});

describe("删 Bot 和插件分配", () => {
  it("删掉的 Bot 从每个插件的分配里拿掉，没分给它的插件原样不动", () => {
    const gone = BotId.parse("bot_gone");
    const kept = BotId.parse("bot_service");
    const both = { id: "tool_both", assignedBotIds: [gone, kept] } as unknown as ToolConnection;
    const other = { id: "tool_other", assignedBotIds: [kept] } as unknown as ToolConnection;
    const state = { ...initial, bots: {}, tools: [both, other] } as ReadyState;
    const removed = reduceGroups(state, { type: "bot_removed", botId: gone });
    expect(removed.tools.map((tool) => tool.assignedBotIds)).toEqual([[kept], [kept]]);
    expect(removed.tools[1], "没分给它的插件不换对象").toBe(other);
  });
});

describe("往上翻群历史", () => {
  const page = (...ids: string[]) => ids.map((id) => user(id, id));
  const latest = (state: ReadyState, messages: Message[], hasMore: boolean, seq: Seq) =>
    reduceGroups(state, { type: "messages_set", groupId: GROUP_ID, messages, hasMore, seq });
  const older = (state: ReadyState, before: string, messages: Message[], hasMore: boolean) =>
    reduceGroups(state, {
      type: "older_messages_loaded",
      groupId: GROUP_ID,
      before: MessageId.parse(before),
      messages,
      hasMore,
    });

  it("更早的一页接在最前面，翻到哪跟着往前挪，到头了 hasMore 变 false", () => {
    const next = createClock();
    const loaded = latest(initial, page("m4", "m5"), true, next());
    expect(loaded.messageEdges[GROUP_ID], "最近一页的头就是下一页的 before").toEqual({ oldest: "m4", hasMore: true });

    const second = older(loaded, "m4", page("m2", "m3"), true);
    expect(idsIn(second)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(second.messageEdges[GROUP_ID]).toEqual({ oldest: "m2", hasMore: true });

    const top = older(second, "m2", page("m1"), false);
    expect(idsIn(top)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(top.messageEdges[GROUP_ID], "到头了").toEqual({ oldest: "m1", hasMore: false });
  });

  it("翻出来的页和本地已有的重叠，同 id 只留一条，留 revision 大的那份", () => {
    const next = createClock();
    const loaded = latest(initial, page("m3", "m4"), true, next());
    const edited = Message.parse({ ...user("m3", "改过的"), revision: 2 });
    const pushed = reduceGroups(loaded, { type: "message_upserted", message: edited, seq: next() });
    const paged = older(pushed, "m3", page("m1", "m2", "m3"), false);
    expect(idsIn(paged)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(paged.messages.rows[GROUP_ID]?.find((m) => m.id === "m3")?.body, "推送来的新版本不被旧页盖掉").toEqual({
      kind: "user",
      text: "改过的",
    });
  });

  it("重拉的最近一页接得上翻过的几页，翻到哪不变；接不上就从新的一页重新往上翻", () => {
    const next = createClock();
    const paged = older(latest(initial, page("m3", "m4"), true, next()), "m3", page("m1", "m2"), true);

    const joined = latest(paged, page("m4", "m5"), true, next());
    expect(joined.messageEdges[GROUP_ID], "m4 本地就有，中间没缺").toEqual({ oldest: "m1", hasMore: true });

    const gapped = latest(paged, page("m8", "m9"), true, next());
    expect(gapped.messageEdges[GROUP_ID], "m5 到 m7 没拉过，从 m8 往上重翻").toEqual({ oldest: "m8", hasMore: true });

    const late = older(gapped, "m1", page("m0"), false);
    expect(late.messageEdges[GROUP_ID], "重新起翻之前发出的那页晚到，不改翻到哪").toEqual({
      oldest: "m8",
      hasMore: true,
    });
    expect(idsIn(late), "那一页的消息照样落进列表").toContain("m0");

    const refill = older(late, "m8", page("m6", "m7"), true);
    const ids: string[] = idsIn(refill) ?? [];
    expect(ids.slice(ids.indexOf("m6"), ids.indexOf("m8") + 1), "补出来的一段紧贴在 m8 前面").toEqual([
      "m6",
      "m7",
      "m8",
    ]);
  });
});
