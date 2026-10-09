import { BrowserPlatform, type Account, type AccountId, type TodayPendingItem } from "@baize/shared";
import type { ContentBook } from "./types.js";

const isBrowser = (account: Account): boolean => BrowserPlatform.safeParse(account.platform).success;

export type PendingEntry = TodayPendingItem | { kind: "login"; account: Account };

// 只认现在还待批的稿子。today 那份是拉回来时的样子，批掉退回之后本地的 content 先变，卡跟着本地那份走。
const pendingAccountIdsOf = (item: TodayPendingItem, content: ContentBook): AccountId[] => {
  switch (item.kind) {
    case "draft": {
      const draft = content.drafts[item.draft.id] ?? item.draft;
      return draft.status === "pending" ? [draft.accountId] : [];
    }
    case "plan": {
      const plan = content.plans[item.plan.id] ?? item.plan;
      if (plan.status !== "pending") return [];
      return item.drafts
        .map((draft) => content.drafts[draft.id] ?? draft)
        .filter((draft) => draft.status === "pending")
        .map((draft) => draft.accountId);
    }
    case "account":
    case "approval":
    case "team_offer":
    case "routine_offer":
      return [];
  }
};

// 一条在列表里的身份。登录卡顶替的是服务端那行账号，两者同一个 key。
export const entryKey = (entry: PendingEntry): string => {
  switch (entry.kind) {
    case "draft":
      return `draft:${entry.draft.id}`;
    case "plan":
      return `plan:${entry.plan.id}`;
    case "approval":
      return `approval:${entry.approval.id}`;
    case "team_offer":
    case "routine_offer":
      return `${entry.kind}:${entry.message.id}`;
    case "account":
    case "login":
      return `account:${entry.account.id}`;
  }
};

// 哪个号要登录只有一处说了算：控制面 pendingItems 列的账号行，过期的号恒列，没登录的占位有待批的活才列。
// 这里只管怎么摆：浏览器平台的那行换成能当场扫码的登录卡，挪到第一张要用它的卡前面，没有就留在原位，
// 行数和服务端 pending 一样。OAuth 平台的行照原样列，去账号页重新授权。
// watched 是这一页上出过登录卡的号，记着卡上屏时排在它前面的那些条目的 key。
// 号登上后服务端那行随之没了，卡片留着说「已登录」，是回执不是待办：有待办等它就放在那件前面，
// 没有就跟在原先前面那些里还在的最后一条后面，一条都不在了才排最前，不让回执在列表里跳位。
// 离开这一页再回来，回执就不再出。
export const withLoginCards = (
  pending: readonly TodayPendingItem[],
  content: ContentBook,
  watched: ReadonlyMap<AccountId, ReadonlySet<string>>,
): PendingEntry[] => {
  const listed = new Set(pending.flatMap((item) => (item.kind === "account" ? [item.account.id] : [])));
  const cardOf = (id: AccountId): Account | undefined => {
    const account = content.accounts[id];
    if (account === undefined || !isBrowser(account)) return undefined;
    if (account.login === "valid") return watched.has(id) ? account : undefined;
    return listed.has(id) ? account : undefined;
  };
  const entries: PendingEntry[] = [];
  const carded = new Set<AccountId>();
  const place = (id: AccountId): boolean => {
    const account = cardOf(id);
    if (account === undefined) return false;
    if (!carded.has(id)) {
      carded.add(id);
      entries.push({ kind: "login", account });
    }
    return true;
  };
  for (const item of pending) {
    for (const id of pendingAccountIdsOf(item, content)) place(id);
    if (item.kind === "account" && place(item.account.id)) continue;
    entries.push(item);
  }
  for (const [id, before] of watched) {
    const account = carded.has(id) ? undefined : cardOf(id);
    if (account === undefined) continue;
    const anchor = entries.findLastIndex((entry) => before.has(entryKey(entry)));
    entries.splice(anchor + 1, 0, { kind: "login", account });
  }
  return entries;
};

// 一屏提交后记下每张登录卡前面排着哪些条目，下一次渲染的 withLoginCards 靠它把回执放回原位。
export const rememberLoginCards = (
  entries: readonly PendingEntry[],
  watched: Map<AccountId, ReadonlySet<string>>,
): void => {
  entries.forEach((entry, index) => {
    if (entry.kind === "login") watched.set(entry.account.id, new Set(entries.slice(0, index).map(entryKey)));
  });
};
