import { describe, expect, it } from "vitest";
import { Account, AccountId, Computer, ComputerId, Draft, LoginAttemptId, TodayPendingItem } from "@baize/shared";
import { withLoginCards } from "./accounts.js";
import { EMPTY_CONTENT, reduceContent } from "./content.js";
import { createClock } from "./stamped.js";
import type { Action, ContentBook, ReadyState } from "./types.js";

const at = "2026-09-26T08:00:00.000Z";
const ACC = AccountId.parse("acc_1");
const OTHER = AccountId.parse("acc_2");
const CMP = ComputerId.parse("cmp_1");
const TRY_1 = LoginAttemptId.parse("try_1");
const TRY_2 = LoginAttemptId.parse("try_2");

const account = (
  login: Account["login"],
  handle: string | null = "要务机械星球",
  platform: Account["platform"] = "xiaohongshu",
  id: AccountId = ACC,
) =>
  Account.parse({
    id,
    ownerId: "usr_1",
    computerId: "cmp_1",
    platform,
    handle,
    tier: "confirm_publish",
    login,
    loginChangedAt: at,
    lastLoginFailure: null,
    createdAt: at,
  });

const computer = (status: Computer["status"]) =>
  Computer.parse({ id: CMP, ownerId: "usr_1", kind: "local", status, host: "local", idleSince: null, lastSeenAt: at });

const draftFor = (accountId: string, status: Draft["status"] = "pending", id = `draft_${accountId}`) =>
  Draft.parse({
    id,
    groupId: "grp_1",
    botId: "bot_1",
    planId: null,
    accountId,
    platform: "xiaohongshu",
    content: { kind: "post", title: "比价", text: "X3 现货比价清单", images: [], github: null },
    scheduledAt: null,
    status,
    edits: [],
    failure: null,
    createdAt: at,
    decidedAt: null,
  });

const initial = { content: EMPTY_CONTENT } as unknown as ReadyState;

const setup = () => {
  let state = initial;
  const put = (action: Action) => {
    state = reduceContent(state, action);
  };
  return { next: createClock(), put, get: () => state.content };
};

describe("账号表的快照、推送和回包按号排", () => {
  it("点登录的 202 回包比登上的推送晚到，不把已登录打回未登录", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    const request = next();
    put({ type: "account_upserted", account: account("valid", "新号"), seq: next() });
    put({ type: "account_upserted", account: account("none", null), seq: request });
    expect(get().accounts[ACC]?.login).toBe("valid");
    expect(get().logins[ACC]).toEqual({ status: "signed_in" });
  });

  it("列表请求在途时推来的账号，列表晚到不盖掉它", () => {
    const { next, put, get } = setup();
    const snapshot = next();
    put({ type: "account_upserted", account: account("valid"), seq: next() });
    put({ type: "accounts_loaded", accounts: [account("expired")], computers: [], seq: snapshot });
    expect(get().accounts[ACC]?.login).toBe("valid");
  });

  it("删掉的账号留墓碑，删之前发出的列表晚到不把它带回来", () => {
    const { next, put, get } = setup();
    put({ type: "accounts_loaded", accounts: [account("valid")], computers: [], seq: next() });
    const snapshot = next();
    put({ type: "account_removed", accountId: ACC, seq: next() });
    put({ type: "accounts_loaded", accounts: [account("valid")], computers: [], seq: snapshot });
    expect(get().accounts[ACC]).toBeUndefined();
  });

  it("快照里没有的账号，号比快照旧就算删了", () => {
    const { next, put, get } = setup();
    put({ type: "account_upserted", account: account("valid"), seq: next() });
    put({ type: "accounts_loaded", accounts: [], computers: [], seq: next() });
    expect(get().accounts[ACC]).toBeUndefined();
  });

  it("重拉的账号列表里这个号登上了，等扫码的卡变成已登录", () => {
    const { next, put, get } = setup();
    put({ type: "accounts_loaded", accounts: [account("none", null)], computers: [], seq: next() });
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "accounts_loaded", accounts: [account("valid", "小王")], computers: [], seq: next() });
    expect(get().logins[ACC]).toEqual({ status: "signed_in" });
  });

  it("电脑表也按号排：推送之前发出的快照晚到，不把休眠改回在线", () => {
    const { next, put, get } = setup();
    put({ type: "accounts_loaded", accounts: [], computers: [computer("online")], seq: next() });
    const snapshot = next();
    put({ type: "computer_upserted", computer: computer("sleeping"), seq: next() });
    put({ type: "accounts_loaded", accounts: [], computers: [computer("online")], seq: snapshot });
    expect(get().computers[CMP]?.status).toBe("sleeping");
    put({ type: "accounts_loaded", accounts: [], computers: [computer("online")], seq: next() });
    expect(get().computers[CMP]?.status, "推送之后发出的快照照常盖").toBe("online");
  });
});

describe("一次登录尝试的结算", () => {
  it("login_failed 只结算 accountId 和尝试号都对上的那张卡", () => {
    const { next, put, get } = setup();
    put({
      type: "accounts_loaded",
      accounts: [account("none", null), account("none", null, "xiaohongshu", OTHER)],
      computers: [],
      seq: next(),
    });
    const startedAt = next();
    put({ type: "login_opened", accountId: ACC, startedAt, attempt: TRY_1 });
    put({ type: "login_opened", accountId: OTHER, startedAt: next(), attempt: LoginAttemptId.parse("try_other") });
    put({ type: "login_failed", accountId: ACC, attempt: TRY_2, reason: "window_failed" });
    expect(get().logins[ACC], "旧的或别的尝试号不算").toEqual({ status: "opening", startedAt, attempt: TRY_1 });
    put({ type: "login_failed", accountId: ACC, attempt: TRY_1, reason: "window_failed" });
    expect(get().logins[ACC]).toEqual({ status: "failed", reason: "window_failed" });
    expect(get().logins[OTHER]?.status, "同平台的另一个号不受影响").toBe("opening");
  });

  it("再点一次之后、新 202 之前到的旧尝试失败不算，新尝试自己的失败才算", () => {
    const { next, put, get } = setup();
    put({ type: "accounts_loaded", accounts: [account("none", null)], computers: [], seq: next() });
    const first = next();
    put({ type: "login_opened", accountId: ACC, startedAt: first, attempt: TRY_1 });
    put({ type: "login_flow", accountId: ACC, startedAt: first, flow: { status: "lapsed" } });
    const second = next();
    put({ type: "login_opened", accountId: ACC, startedAt: second, attempt: TRY_2 });
    put({ type: "login_failed", accountId: ACC, attempt: TRY_1, reason: "window_failed" });
    expect(get().logins[ACC], "卡一开就带着这次的号，旧尝试的失败对不上号").toEqual({
      status: "opening",
      startedAt: second,
      attempt: TRY_2,
    });
    put({ type: "login_failed", accountId: ACC, attempt: TRY_2, reason: "remote_refused" });
    expect(get().logins[ACC], "这次自己的失败写的是自己的原因").toEqual({ status: "failed", reason: "remote_refused" });
  });

  it("login_flow 只落在同一次点击还在等的卡上", () => {
    const { next, put, get } = setup();
    const first = next();
    put({ type: "login_opened", accountId: ACC, startedAt: first, attempt: TRY_1 });
    const second = next();
    put({ type: "login_opened", accountId: ACC, startedAt: second, attempt: TRY_2 });
    put({ type: "login_flow", accountId: ACC, startedAt: first, flow: { status: "lapsed" } });
    expect(get().logins[ACC], "上一次点击的超时不动这一次").toEqual({
      status: "opening",
      startedAt: second,
      attempt: TRY_2,
    });
    put({ type: "login_flow", accountId: ACC, startedAt: second, flow: { status: "offline" } });
    expect(get().logins[ACC]).toEqual({ status: "offline" });
  });

  it("logins_settled 把某台电脑上、某个时刻之前还在等的卡都结掉，之后点的不动", () => {
    const { next, put, get } = setup();
    put({
      type: "accounts_loaded",
      accounts: [account("none", null), account("none", null, "xiaohongshu", OTHER)],
      computers: [],
      seq: next(),
    });
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    const before = next();
    const later = next();
    put({ type: "login_opened", accountId: OTHER, startedAt: later, attempt: TRY_2 });
    put({ type: "logins_settled", before, computerId: CMP, flow: { status: "offline" } });
    expect(get().logins[ACC]).toEqual({ status: "offline" });
    expect(get().logins[OTHER]).toEqual({ status: "opening", startedAt: later, attempt: TRY_2 });
    put({
      type: "logins_settled",
      before: next(),
      computerId: ComputerId.parse("cmp_other"),
      flow: { status: "lapsed" },
    });
    expect(get().logins[OTHER]?.status, "别的电脑离线不动这台的卡").toBe("opening");
    put({ type: "logins_settled", before: next(), computerId: null, flow: { status: "lapsed" } });
    expect(get().logins[OTHER], "不指定电脑就是全部").toEqual({ status: "lapsed" });
  });
});

describe("等你确认里的登录卡", () => {
  const book = (accounts: Account[], logins: ContentBook["logins"] = {}, drafts: Draft[] = []): ContentBook => ({
    ...EMPTY_CONTENT,
    accounts: Object.fromEntries(accounts.map((item) => [item.id, item])),
    drafts: Object.fromEntries(drafts.map((item) => [item.id, item])),
    logins,
  });
  const draftItem = (accountId = "acc_1", status: Draft["status"] = "pending"): TodayPendingItem =>
    TodayPendingItem.parse({ kind: "draft", draft: draftFor(accountId, status), since: at });
  const kinds = (entries: ReturnType<typeof withLoginCards>) => entries.map((entry) => entry.kind);

  const accountRow = (login: Account["login"], handle: string | null = "要务机械星球") =>
    TodayPendingItem.parse({ kind: "account", account: account(login, handle), since: at });

  it("没登录的小红书号有稿子等着，登录卡换掉服务端那行，放在稿子前面", () => {
    const pending = [accountRow("none", null), draftItem()];
    const entries = withLoginCards(pending, book([account("none", null)]));
    expect(kinds(entries)).toEqual(["login", "draft"]);
    expect(entries.length, "一张卡换一行，条数和服务端 pending 一样").toBe(pending.length);
  });

  it("服务端没列账号行的号，不论没登录还是过期，都不凭空放卡", () => {
    expect(kinds(withLoginCards([draftItem()], book([account("none", null)])))).toEqual(["draft"]);
    expect(kinds(withLoginCards([draftItem()], book([account("expired")])))).toEqual(["draft"]);
  });

  it("两条稿子发到同一个号只放一张卡", () => {
    const pending = [accountRow("expired"), draftItem(), draftItem()];
    expect(kinds(withLoginCards(pending, book([account("expired")])))).toEqual(["login", "draft", "draft"]);
  });

  it("号已登录、非浏览器平台、没有稿子等着，都不放卡", () => {
    expect(kinds(withLoginCards([draftItem()], book([account("valid")])))).toEqual(["draft"]);
    const xRow = TodayPendingItem.parse({ kind: "account", account: account("none", null, "x"), since: at });
    expect(kinds(withLoginCards([xRow, draftItem()], book([account("none", null, "x")])))).toEqual([
      "account",
      "draft",
    ]);
    expect(kinds(withLoginCards([accountRow("none", null)], book([account("none", null)])))).toEqual(["account"]);
  });

  it("点过登录的号登上之后卡片留着说已登录", () => {
    const entries = withLoginCards([draftItem()], book([account("valid")], { [ACC]: { status: "signed_in" } }));
    expect(kinds(entries)).toEqual(["login", "draft"]);
  });

  it("服务端单列的过期号照原样列，不换成登录卡", () => {
    const pending = [TodayPendingItem.parse({ kind: "account", account: account("expired"), since: at })];
    expect(kinds(withLoginCards(pending, book([account("expired")])))).toEqual(["account"]);
  });

  it("过期号有稿子等着，只放登录卡，服务端那行过期号不再列，不论它排在稿子前还是后", () => {
    const row = TodayPendingItem.parse({ kind: "account", account: account("expired"), since: at });
    const content = book([account("expired")]);
    expect(kinds(withLoginCards([row, draftItem()], content))).toEqual(["login", "draft"]);
    expect(kinds(withLoginCards([draftItem(), row], content))).toEqual(["login", "draft"]);
    expect(
      withLoginCards([row, draftItem()], content).length,
      "一张卡换一行过期号，条数和服务端 pending 一样，计数才能只数服务端的",
    ).toBe(2);
  });

  it("稿子在本地已经批掉或退回，today 还没刷新，也不再放卡", () => {
    const approved = draftFor("acc_1", "approved");
    const row = accountRow("expired");
    expect(kinds(withLoginCards([row, draftItem()], book([account("expired")], {}, [approved])))).toEqual([
      "account",
      "draft",
    ]);
    expect(kinds(withLoginCards([row, draftItem("acc_1", "returned")], book([account("expired")])))).toEqual([
      "account",
      "draft",
    ]);
  });
});
