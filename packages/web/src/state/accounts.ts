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
      return [];
  }
};

// 浏览器平台的号没登上、又有稿子等着发到它，服务端会单列一行账号（过期或还没登录），
// 登录卡换掉这一行，挪到第一张要用它的卡前面，行数和服务端 pending 一样。服务端没列的号不凭空放卡。
// 例外是点过登录、已经登上的号：服务端那行随之没了，卡片留着说「已登录」，它是回执不是待办。
// 没有稿子等着的账号行照原样列。
export const withLoginCards = (pending: readonly TodayPendingItem[], content: ContentBook): PendingEntry[] => {
  const listed = new Set(pending.flatMap((item) => (item.kind === "account" ? [item.account.id] : [])));
  const needsCard = (id: AccountId): Account | undefined => {
    const account = content.accounts[id];
    if (account === undefined || !isBrowser(account)) return undefined;
    if (account.login === "valid") return content.logins[id] === undefined ? undefined : account;
    return listed.has(id) ? account : undefined;
  };
  const cardedAnywhere = new Set(
    pending.flatMap((item) => pendingAccountIdsOf(item, content)).filter((id) => needsCard(id) !== undefined),
  );
  const entries: PendingEntry[] = [];
  const carded = new Set<AccountId>();
  for (const item of pending) {
    for (const id of pendingAccountIdsOf(item, content)) {
      const account = needsCard(id);
      if (account === undefined || carded.has(id)) continue;
      carded.add(id);
      entries.push({ kind: "login", account });
    }
    if (item.kind === "account" && cardedAnywhere.has(item.account.id)) continue;
    entries.push(item);
  }
  return entries;
};
