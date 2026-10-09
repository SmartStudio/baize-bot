import { describe, expect, it } from "vitest";
import { BotId, GroupId, Message, MessageId } from "@baize/shared";
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
  });

// 这几条动作只读写群消息，别的字段用不上。
const initial = {
  conversations: [
    { kind: "solo", groupId: GROUP_ID, botId: "bot_sales", lastMessage: null, pendingApprovals: 0, pendingHandoffs: 0 },
  ],
  messages: emptyShelf(),
  messagesLoadedAt: {},
  messageGaps: {},
  deletedBotIds: [],
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
  seq,
});

const replyIn = (state: ReadyState) => state.messages.rows[GROUP_ID]?.find((m) => m.id === MESSAGE_ID)?.body;
const idsIn = (state: ReadyState) => state.messages.rows[GROUP_ID]?.map((m) => m.id);

const user = (id: string, text: string) =>
  Message.parse({ id, groupId: GROUP_ID, body: { kind: "user", text }, createdAt: at, revision: 0 });

describe("群历史和流式推送的先后", () => {
  it("断线前只收到半句，重连后重拉的历史换成服务端的完整正文", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [], seq: next() });
    const partial = reduceGroups(loaded, delta(next(), "收到。", false, 1));
    const history = next();
    const resynced = reduceGroups(partial, {
      type: "messages_set",
      groupId: GROUP_ID,
      messages: [bot("收到。我这就去办。", false, 3)],
      seq: history,
    });
    expect(replyIn(resynced)).toEqual(bot("收到。我这就去办。", false, 3).body);
  });

  it("历史请求发出之后才到的 delta，不被晚到的历史盖回去", () => {
    const next = createClock();
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [], seq: next() });
    const partial = reduceGroups(loaded, delta(next(), "收到。", false, 1));
    const history = next();
    const grown = reduceGroups(partial, delta(next(), "我这就", false, 2));
    const late = reduceGroups(grown, {
      type: "messages_set",
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
    const state = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages, seq: next() });
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
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [], seq: next() });
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
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [said], seq: next() });
    const streamed = reduceGroups(loaded, delta(next(), "收到", false, 1));
    const row = streamed.messages.rows[GROUP_ID]?.find((m) => m.id === MESSAGE_ID);
    expect(row?.createdAt, "本地时钟现在远晚于 2026-09-26，取到它就说明用了本地时间").toBe(said.createdAt);
    expect(idsIn(streamed)).toEqual(["msg_said", MESSAGE_ID]);
  });

  it("同 id 的完整消息到了，时间以服务端为准", () => {
    const next = createClock();
    const said = timed(user("msg_said", "开干"), "2026-09-26T08:00:05.000Z");
    const loaded = reduceGroups(initial, { type: "messages_set", groupId: GROUP_ID, messages: [said], seq: next() });
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
    const loaded = reduceGroups(pushed, { type: "messages_set", groupId: GROUP_ID, messages: [settled], seq: next() });
    expect(lastOf(loaded), "同一条的更新版本").toEqual(settled);
    const newer = timed(user("msg_newer", "再说一句"), "2026-09-26T08:00:05.000Z");
    const reloaded = reduceGroups(loaded, {
      type: "messages_set",
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
    });
    const first = Message.parse({
      id: "msg_aaaa",
      groupId: GROUP_ID,
      body: { kind: "bot", botId: "bot_sales", text: "B", streaming: false },
      createdAt: sameMs,
      revision: 0,
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
