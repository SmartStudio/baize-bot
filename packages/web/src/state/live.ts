import type { AccountId, LiveSession, LoginAttemptId } from "@baize/shared";
import type { Seq } from "./stamped.js";
import type { ContentBook, LoginFlow } from "./types.js";

// 「正在登录」不另存：页面点击时自己取的尝试号就是认领凭据，attempt 对得上的 login 会话就是这次点击的画面。
export const loginScreen = (live: ContentBook["live"], attempt: LoginAttemptId): LiveSession | null =>
  Object.values(live).find((session) => session.purpose.kind === "login" && session.purpose.attempt === attempt) ??
  null;

export type ShownLogin = { accountId: AccountId; attempt: LoginAttemptId; startedAt: Seq; session: LiveSession };

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

export type ShownLive = ({ kind: "login" } & ShownLogin) | { kind: "takeover"; openedAt: Seq; session: LiveSession };

// 整页只有一块画面面板。登录是用户点了登录才有的，会话一到就摆；接手是 Bot 发起的，用户点了「打开画面」才摆。
// 两块都能摆时摆用户最后一次动作指向的那块，同一个钟上比 startedAt 和 openedAt。
export const shownLive = (content: ContentBook): ShownLive | null => {
  const login = shownLogin(content);
  const opened = content.takeover;
  const session = opened === null ? undefined : content.live[opened.liveId];
  if (opened !== null && session !== undefined && (login === null || opened.openedAt > login.startedAt))
    return { kind: "takeover", openedAt: opened.openedAt, session };
  return login === null ? null : { kind: "login", ...login };
};

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
