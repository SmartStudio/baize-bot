import type { AccountId, ComputerId, LiveId, LivePurpose, LiveSession, LoginAttemptId } from "@baize/shared";
import type { Seq } from "./stamped.js";
import type { ContentBook, LiveEntry, LoginFlow } from "./types.js";

// 画面面板摆的会话：登录和接手。终端有自己的面板。
export type ScreenSession = Omit<LiveSession, "purpose"> & { purpose: Exclude<LivePurpose, { kind: "terminal" }> };
const isScreen = (session: LiveEntry): session is LiveEntry & ScreenSession => session.purpose.kind !== "terminal";

// 「正在登录」不另存：页面点击时自己取的尝试号就是认领凭据，attempt 对得上的 login 会话就是这次点击的画面。
export const loginScreen = (live: ContentBook["live"], attempt: LoginAttemptId): ScreenSession | null =>
  Object.values(live)
    .filter(isScreen)
    .find((session) => session.purpose.kind === "login" && session.purpose.attempt === attempt) ?? null;

export type ShownLogin = { accountId: AccountId; attempt: LoginAttemptId; startedAt: Seq; session: ScreenSession };

// 一页只摆一块登录画面：一台电脑同一时刻只有一个观看者，摆两块会互相顶掉。几个号同时在等，摆最后点的那个。
export const shownLogin = (content: ContentBook): ShownLogin | null => {
  let shown: ShownLogin | null = null;
  for (const [accountId, flow] of Object.entries(content.logins) as [AccountId, LoginFlow | undefined][]) {
    if (flow?.status !== "opening") continue;
    const session = loginScreen(content.live, flow.attempt);
    if (session === null || (shown !== null && flow.startedAt < shown.startedAt)) continue;
    shown = { accountId, attempt: flow.attempt, startedAt: flow.startedAt, session };
  }
  return shown;
};

export type ShownLive =
  | ({ kind: "login" } & ShownLogin)
  | { kind: "takeover"; openedAt: Seq; session: ScreenSession }
  | { kind: "terminal"; openedAt: Seq; session: LiveSession };

// 整页只有一块画面面板。登录是用户点了登录才有的，会话一到就摆；接手是 Bot 发起的，用户点了「打开画面」才摆；
// 终端是用户在电脑页上点开的，会话报上来才摆。几块都能摆时摆用户最后一次动作指向的那块，同一个钟上比 startedAt 和 openedAt。
export const shownLive = (content: ContentBook): ShownLive | null => {
  const candidates: ShownLive[] = [];
  const login = shownLogin(content);
  if (login !== null) candidates.push({ kind: "login", ...login });
  const takeover = content.takeover === null ? undefined : content.live[content.takeover.liveId];
  if (content.takeover !== null && takeover !== undefined && isScreen(takeover))
    candidates.push({ kind: "takeover", openedAt: content.takeover.openedAt, session: takeover });
  const terminal = content.terminal?.status === "open" ? content.live[content.terminal.liveId] : undefined;
  if (content.terminal?.status === "open" && terminal !== undefined)
    candidates.push({ kind: "terminal", openedAt: content.terminal.openedAt, session: terminal });
  const at = (shown: ShownLive): Seq => (shown.kind === "login" ? shown.startedAt : shown.openedAt);
  return candidates.reduce<ShownLive | null>(
    (last, next) => (last === null || at(next) > at(last) ? next : last),
    null,
  );
};

// 这台电脑上还开着的终端，刷新之后电脑页靠它给「回到终端」。一台电脑同时可以有两个，回到哪个都行。
export const openTerminal = (live: ContentBook["live"], computerId: ComputerId): LiveSession | null =>
  Object.values(live).find((session) => session.purpose.kind === "terminal" && session.computerId === computerId) ??
  null;

// 画面出现过、现在没了的尝试改成 closed：按钮放开，尝试号留着等晚到的结果。电脑先收起画面、后报结论是常态。
export const closeScreens = (
  logins: ContentBook["logins"],
  before: ContentBook["live"],
  after: ContentBook["live"],
): ContentBook["logins"] => {
  let next = logins;
  for (const [id, flow] of Object.entries(logins) as [AccountId, LoginFlow | undefined][]) {
    if (flow?.status !== "opening") continue;
    if (loginScreen(before, flow.attempt) === null || loginScreen(after, flow.attempt) !== null) continue;
    next = { ...next, [id]: { status: "closed", startedAt: flow.startedAt, attempt: flow.attempt } };
  }
  return next;
};

// 接手卡上的画面：还在就能开；出现过又没了是电脑收起了、结论还在路上；这一页没见过就是还没报上来。
// 「出现过」认画面表的号：会话写进来、被删都记号，删掉的号留着当墓碑。号只活在这一次页面加载里，刷新后收起过的也算没见过。
export type TakeoverScreen = { kind: "open"; session: LiveSession } | { kind: "put_away" } | { kind: "unseen" };

export const takeoverScreen = (content: ContentBook, liveId: LiveId): TakeoverScreen => {
  const session = content.live[liveId];
  if (session !== undefined) return { kind: "open", session };
  return content.stamps[liveId] === undefined ? { kind: "unseen" } : { kind: "put_away" };
};
