import { describe, expect, it } from "vitest";
import { AccountId, ComputerId, LiveId, LiveSession, LoginAttemptId } from "@baize/shared";
import { EMPTY_CONTENT, reduceContent } from "./content.js";
import { openTerminal, shownLive, shownLogin, takeoverScreen } from "./live.js";
import { createClock } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

const ACC = AccountId.parse("acc_1");
const OTHER = AccountId.parse("acc_2");
const CMP = ComputerId.parse("cmp_1");
const TRY_1 = LoginAttemptId.parse("try_1");
const TRY_2 = LoginAttemptId.parse("try_2");
const LIVE_A = LiveId.parse("00000000-0000-4000-8000-00000000000a");
const LIVE_B = LiveId.parse("00000000-0000-4000-8000-00000000000b");
const LIVE_C = LiveId.parse("00000000-0000-4000-8000-00000000000c");

const login = (liveId: LiveId, attempt: LoginAttemptId, accountId: AccountId = ACC, origin: string | null = null) =>
  LiveSession.parse({
    liveId,
    purpose: { kind: "login", accountId, platform: "xiaohongshu", attempt },
    origin,
    computerId: CMP,
  });

const takeover = (liveId: LiveId) =>
  LiveSession.parse({
    liveId,
    purpose: { kind: "takeover", botId: "bot_1", groupId: "grp_1", reason: "知乎要登录" },
    origin: "https://www.zhihu.com",
    computerId: CMP,
  });

const terminal = (liveId: LiveId, computerId = CMP) =>
  LiveSession.parse({ liveId, purpose: { kind: "terminal" }, origin: null, computerId });

const setup = () => {
  let state = { content: EMPTY_CONTENT } as unknown as ReadyState;
  const put = (action: Action) => {
    state = reduceContent(state, action);
  };
  return { next: createClock(), put, get: () => state.content };
};

describe("画面表由 GET /api/live 和两种推送一起维护", () => {
  it("列表在途时推来的会话，列表晚到不把它抹掉", () => {
    const { next, put, get } = setup();
    const request = next();
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_loaded", sessions: [], seq: request });
    expect(Object.keys(get().live)).toEqual([LIVE_A]);
  });

  it("列表在途时推来的 live_closed，列表晚到不把已经关掉的会话带回来", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    const request = next();
    put({ type: "live_removed", liveId: LIVE_A, seq: next() });
    put({ type: "live_loaded", sessions: [login(LIVE_A, TRY_1)], seq: request });
    expect(get().live).toEqual({});
  });

  it("live_closed 删掉对应的会话，别的会话留着", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    put({ type: "live_removed", liveId: LIVE_A, seq: next() });
    expect(Object.keys(get().live)).toEqual([LIVE_B]);
  });

  it("推送重连后重拉的列表覆盖旧表：断线期间关掉的删掉，变了 origin 的换成新的", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    put({ type: "live_loaded", sessions: [login(LIVE_A, TRY_1, ACC, "https://www.xiaohongshu.com")], seq: next() });
    expect(Object.keys(get().live)).toEqual([LIVE_A]);
    expect(get().live[LIVE_A]?.origin).toBe("https://www.xiaohongshu.com");
  });
});

describe("登录按 attempt 认领画面", () => {
  it("尝试号对上的 login 会话就是这次点击的画面，别的尝试和接手会话不算", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_B, TRY_2), seq: next() });
    put({ type: "live_upserted", session: takeover(LIVE_C), seq: next() });
    expect(shownLogin(get())).toBeNull();
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    expect(shownLogin(get())).toMatchObject({ accountId: ACC, attempt: TRY_1, session: { liveId: LIVE_A } });
  });

  it("两个号同时在等，一页只摆最后点的那个", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: OTHER, startedAt: next(), attempt: TRY_2 });
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_upserted", session: login(LIVE_B, TRY_2, OTHER), seq: next() });
    expect(shownLogin(get())?.accountId).toBe(ACC);
  });

  it("画面先收起、结果后到：卡改成 closed 放开按钮，晚到的失败照样落上来", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_removed", liveId: LIVE_A, seq: next() });
    expect(get().logins[ACC]).toMatchObject({ status: "closed", attempt: TRY_1 });
    expect(shownLogin(get())).toBeNull();
    put({ type: "login_failed", accountId: ACC, attempt: TRY_1, reason: "window_failed" });
    expect(get().logins[ACC]).toEqual({ status: "failed", reason: "window_failed" });
  });

  it("重连重拉发现认领过的画面没了，同样改成 closed", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_loaded", sessions: [], seq: next() });
    expect(get().logins[ACC]?.status).toBe("closed");
  });

  it("画面还没出现过的登录，重拉到空表不动，仍在等", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_loaded", sessions: [], seq: next() });
    expect(get().logins[ACC]?.status).toBe("opening");
  });

  it("点了「不登了」只复位按钮，不记失败；之后晚到的失败也不落", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "login_dismissed", accountId: ACC, attempt: TRY_1 });
    expect(get().logins[ACC]).toBeUndefined();
    put({ type: "login_failed", accountId: ACC, attempt: TRY_1, reason: "window_failed" });
    expect(get().logins[ACC]).toBeUndefined();
  });

  it("旧尝试的「不登了」不复位新点的那一次", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_2 });
    put({ type: "login_dismissed", accountId: ACC, attempt: TRY_1 });
    expect(get().logins[ACC]?.status).toBe("opening");
  });

  it("网页计时到点时画面还开着，不结成 lapsed；没开画面的照旧结", () => {
    const { next, put, get } = setup();
    const shown = next();
    put({ type: "login_opened", accountId: ACC, startedAt: shown, attempt: TRY_1 });
    const blind = next();
    put({ type: "login_opened", accountId: OTHER, startedAt: blind, attempt: TRY_2 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "login_flow", accountId: ACC, startedAt: shown, flow: { status: "lapsed" } });
    put({ type: "login_flow", accountId: OTHER, startedAt: blind, flow: { status: "lapsed" } });
    expect(get().logins[ACC]?.status).toBe("opening");
    expect(get().logins[OTHER]).toEqual({ status: "lapsed" });
    put({ type: "login_flow", accountId: ACC, startedAt: shown, flow: { status: "offline" } });
    expect(get().logins[ACC], "离线不看画面").toEqual({ status: "offline" });
  });

  it("推送重连时画面还开着的登录不算没等到，没画面的照旧结成 lapsed", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "login_opened", accountId: OTHER, startedAt: next(), attempt: TRY_2 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "logins_settled", before: next(), computerId: null, flow: { status: "lapsed" } });
    expect(get().logins[ACC]?.status).toBe("opening");
    expect(get().logins[OTHER]).toEqual({ status: "lapsed" });
  });

  it("电脑离线时收起了的登录结成 offline：结果不会再来了", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_removed", liveId: LIVE_A, seq: next() });
    put({ type: "logins_settled", before: next(), computerId: null, flow: { status: "lapsed" } });
    expect(get().logins[ACC]?.status).toBe("closed");
    put({ type: "logins_settled", before: next(), computerId: null, flow: { status: "offline" } });
    expect(get().logins[ACC]).toEqual({ status: "offline" });
  });
});

describe("整页只摆一块画面：登录自动摆，接手点开才摆，两者都在摆最后动作指向的那块", () => {
  it("只有在等的登录：摆登录", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    expect(shownLive(get())).toMatchObject({ kind: "login", accountId: ACC, session: { liveId: LIVE_A } });
  });

  it("接手会话来了不自动摆，点开之后才摆它", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    expect(shownLive(get())).toBeNull();
    put({ type: "takeover_opened", liveId: LIVE_B, openedAt: next() });
    expect(shownLive(get())).toMatchObject({ kind: "takeover", session: { liveId: LIVE_B } });
  });

  it("登录摆着时来了接手，登录不被替换；点开接手摆接手，再点一次登录又摆登录", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    expect(shownLive(get())?.kind).toBe("login");
    put({ type: "takeover_opened", liveId: LIVE_B, openedAt: next() });
    expect(shownLive(get())).toMatchObject({ kind: "takeover", session: { liveId: LIVE_B } });
    put({ type: "login_opened", accountId: OTHER, startedAt: next(), attempt: TRY_2 });
    put({ type: "live_upserted", session: login(LIVE_C, TRY_2, OTHER), seq: next() });
    expect(shownLive(get())).toMatchObject({ kind: "login", accountId: OTHER, session: { liveId: LIVE_C } });
  });

  it("接手面板收起后回到还在等的登录", () => {
    const { next, put, get } = setup();
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    put({ type: "takeover_opened", liveId: LIVE_B, openedAt: next() });
    put({ type: "takeover_hidden", liveId: LIVE_B });
    expect(get().takeover).toBeNull();
    expect(shownLive(get())).toMatchObject({ kind: "login", session: { liveId: LIVE_A } });
  });

  it("点开的接手会话没了：有在等的登录就回到登录，没有就什么都不摆", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    put({ type: "takeover_opened", liveId: LIVE_B, openedAt: next() });
    put({ type: "live_removed", liveId: LIVE_B, seq: next() });
    expect(shownLive(get())).toBeNull();

    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_A, TRY_1), seq: next() });
    put({ type: "live_upserted", session: takeover(LIVE_C), seq: next() });
    put({ type: "takeover_opened", liveId: LIVE_C, openedAt: next() });
    put({ type: "live_loaded", sessions: [login(LIVE_A, TRY_1)], seq: next() });
    expect(shownLive(get())).toMatchObject({ kind: "login", session: { liveId: LIVE_A } });
  });

  it("会话没了就清掉点开的记录，晚到的同号会话不会自己弹出来", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    put({ type: "takeover_opened", liveId: LIVE_B, openedAt: next() });
    put({ type: "live_removed", liveId: LIVE_B, seq: next() });
    expect(get().takeover).toBeNull();
    put({ type: "live_loaded", sessions: [takeover(LIVE_B)], seq: next() });
    expect(shownLive(get())).toBeNull();
  });

  it("收起旧接手不清掉新点开的那个", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    put({ type: "live_upserted", session: takeover(LIVE_C), seq: next() });
    put({ type: "takeover_opened", liveId: LIVE_C, openedAt: next() });
    put({ type: "takeover_hidden", liveId: LIVE_B });
    expect(shownLive(get())).toMatchObject({ kind: "takeover", session: { liveId: LIVE_C } });
  });
});

describe("终端点开时会话还在路上，报上来才摆", () => {
  it("点开在先、live_session 在后：先不摆，会话一到就摆终端", () => {
    const { next, put, get } = setup();
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    expect(shownLive(get())).toBeNull();
    expect(get().terminal?.liveId).toBe(LIVE_A);
    put({ type: "live_upserted", session: terminal(LIVE_A), seq: next() });
    expect(shownLive(get())).toMatchObject({ kind: "terminal", session: { liveId: LIVE_A } });
  });

  it("等会话时重拉的列表里还没有它，接着等，不算关了", () => {
    const { next, put, get } = setup();
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    put({ type: "live_loaded", sessions: [], seq: next() });
    expect(get().terminal?.liveId).toBe(LIVE_A);
  });

  it("会话出现过又关了：清掉点开的记录；再点这个号也不复活", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: terminal(LIVE_A), seq: next() });
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    put({ type: "live_removed", liveId: LIVE_A, seq: next() });
    expect(get().terminal).toBeNull();
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    expect(shownLive(get())).toBeNull();
  });

  it("从没报上来就收到 live_closed：电脑拒开了，记成 refused 留给那台电脑，不摆面板", () => {
    const { next, put, get } = setup();
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    put({ type: "live_removed", liveId: LIVE_A, seq: next() });
    expect(get().terminal).toEqual({ status: "refused", liveId: LIVE_A, computerId: CMP });
    expect(shownLive(get())).toBeNull();
  });

  it("live_closed 比开终端的回包先到，也算拒开", () => {
    const { next, put, get } = setup();
    const openedAt = next();
    put({ type: "live_removed", liveId: LIVE_A, seq: next() });
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt });
    expect(get().terminal).toEqual({ status: "refused", liveId: LIVE_A, computerId: CMP });
  });

  it("拒开之后再点一次，新号接着等", () => {
    const { next, put, get } = setup();
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    put({ type: "live_removed", liveId: LIVE_A, seq: next() });
    put({ type: "terminal_opened", liveId: LIVE_B, computerId: CMP, openedAt: next() });
    expect(get().terminal).toMatchObject({ status: "open", liveId: LIVE_B });
    put({ type: "live_upserted", session: terminal(LIVE_B), seq: next() });
    expect(shownLive(get())).toMatchObject({ kind: "terminal", session: { liveId: LIVE_B } });
  });

  it("断线重拉发现终端没了，也清掉", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: terminal(LIVE_A), seq: next() });
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    put({ type: "live_loaded", sessions: [], seq: next() });
    expect(get().terminal).toBeNull();
  });

  it("终端开着时点登录摆登录，再点「回到终端」又摆终端", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: terminal(LIVE_A), seq: next() });
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    put({ type: "login_opened", accountId: ACC, startedAt: next(), attempt: TRY_1 });
    put({ type: "live_upserted", session: login(LIVE_B, TRY_1), seq: next() });
    expect(shownLive(get())?.kind).toBe("login");
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    expect(shownLive(get())).toMatchObject({ kind: "terminal", session: { liveId: LIVE_A } });
  });

  it("收起终端只清这一页的记录，会话还在，电脑页靠它给「回到终端」", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: terminal(LIVE_A), seq: next() });
    put({ type: "terminal_opened", liveId: LIVE_A, computerId: CMP, openedAt: next() });
    put({ type: "terminal_hidden", liveId: LIVE_A });
    expect(shownLive(get())).toBeNull();
    expect(openTerminal(get().live, CMP)?.liveId).toBe(LIVE_A);
    expect(openTerminal(get().live, ComputerId.parse("cmp_other")), "别的电脑上没有终端").toBeNull();
  });

  it("登录和接手会话不算终端", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: takeover(LIVE_A), seq: next() });
    put({ type: "live_upserted", session: login(LIVE_B, TRY_1), seq: next() });
    expect(openTerminal(get().live, CMP)).toBeNull();
  });
});

describe("接手卡上的画面：还在、收起了、这一页没见过", () => {
  it("推来过又收到 live_closed 是收起了；从没推来过是没见过", () => {
    const { next, put, get } = setup();
    put({ type: "live_upserted", session: takeover(LIVE_B), seq: next() });
    expect(takeoverScreen(get(), LIVE_B)).toMatchObject({ kind: "open", session: { liveId: LIVE_B } });
    put({ type: "live_removed", liveId: LIVE_B, seq: next() });
    expect(takeoverScreen(get(), LIVE_B)).toEqual({ kind: "put_away" });
    expect(takeoverScreen(get(), LIVE_C)).toEqual({ kind: "unseen" });
  });

  it("断线重拉的列表里没了它，也算收起了", () => {
    const { next, put, get } = setup();
    put({ type: "live_loaded", sessions: [takeover(LIVE_B)], seq: next() });
    put({ type: "live_loaded", sessions: [], seq: next() });
    expect(takeoverScreen(get(), LIVE_B)).toEqual({ kind: "put_away" });
  });
});
