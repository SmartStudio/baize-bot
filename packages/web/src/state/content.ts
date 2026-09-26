import { loadTable, removeFromTable, writeTable } from "./stamped.js";
import type { Account, AccountId } from "@baize/shared";
import type { Action, ContentBook, LoginFlow, ReadyState } from "./types.js";

export const EMPTY_CONTENT: ContentBook = {
  drafts: {},
  plans: {},
  accounts: {},
  computers: {},
  publications: {},
  logins: {},
  stamps: {},
};

const withContent = (state: ReadyState, content: ContentBook): ReadyState => ({ ...state, content });

// 登上是账号的事实，不看是哪次点击等来的：点过登录的号只要读到 valid，卡就说已登录。
const signedIn = (logins: ContentBook["logins"], accounts: Record<AccountId, Account>): ContentBook["logins"] => {
  let next = logins;
  for (const [id, flow] of Object.entries(logins) as [AccountId, LoginFlow | undefined][]) {
    if (flow === undefined || flow.status === "signed_in" || accounts[id]?.login !== "valid") continue;
    next = { ...next, [id]: { status: "signed_in" } };
  }
  return next;
};

export const reduceContent = (state: ReadyState, action: Action): ReadyState => {
  const content = state.content;
  switch (action.type) {
    case "content_loaded": {
      // 草稿不是只进不退的：批过的被 Bot 改了会回到 pending，所以不能像审批那样拿「已有结论」挡旧数据，只能比先后。
      const drafts = writeTable(content.drafts, content.stamps, action.seq, action.drafts);
      const plans = writeTable(content.plans, drafts.stamps, action.seq, action.plans);
      return withContent(state, { ...content, drafts: drafts.rows, plans: plans.rows, stamps: plans.stamps });
    }
    case "accounts_loaded": {
      const accounts = loadTable(content.accounts, content.stamps, action.seq, action.accounts);
      const computers = loadTable(content.computers, accounts.stamps, action.seq, action.computers);
      return withContent(state, {
        ...content,
        accounts: accounts.rows,
        computers: computers.rows,
        logins: signedIn(content.logins, accounts.rows),
        stamps: computers.stamps,
      });
    }
    case "account_upserted": {
      const accounts = writeTable(content.accounts, content.stamps, action.seq, [action.account]);
      return withContent(state, {
        ...content,
        accounts: accounts.rows,
        logins: signedIn(content.logins, accounts.rows),
        stamps: accounts.stamps,
      });
    }
    case "account_removed": {
      const accounts = removeFromTable(content.accounts, content.stamps, action.seq, action.accountId);
      const { [action.accountId]: _flow, ...logins } = content.logins;
      return withContent(state, { ...content, accounts: accounts.rows, logins, stamps: accounts.stamps });
    }
    case "login_opened":
      return withContent(state, {
        ...content,
        logins: {
          ...content.logins,
          [action.accountId]: { status: "opening", startedAt: action.startedAt, attempt: action.attempt },
        },
      });
    case "login_flow": {
      const flow = content.logins[action.accountId];
      if (flow?.status !== "opening" || flow.startedAt !== action.startedAt) return state;
      return withContent(state, { ...content, logins: { ...content.logins, [action.accountId]: action.flow } });
    }
    case "login_failed": {
      // 卡一开就带着这次的号，失败要对上号才算，旧尝试的失败不盖新尝试。
      const flow = content.logins[action.accountId];
      if (flow?.status !== "opening" || flow.attempt !== action.attempt) return state;
      const failed: LoginFlow = { status: "failed", reason: action.reason };
      return withContent(state, { ...content, logins: { ...content.logins, [action.accountId]: failed } });
    }
    case "logins_settled": {
      const logins = { ...content.logins };
      for (const [id, flow] of Object.entries(content.logins) as [AccountId, LoginFlow | undefined][]) {
        if (flow?.status !== "opening" || flow.startedAt >= action.before) continue;
        if (action.computerId !== null && content.accounts[id]?.computerId !== action.computerId) continue;
        logins[id] = action.flow;
      }
      return withContent(state, { ...content, logins });
    }
    case "computer_upserted": {
      const computers = writeTable(content.computers, content.stamps, action.seq, [action.computer]);
      return withContent(state, { ...content, computers: computers.rows, stamps: computers.stamps });
    }
    case "publications_loaded": {
      const publications = { ...content.publications };
      for (const publication of action.publications) {
        if (publication.draftId !== null) publications[publication.draftId] = publication;
      }
      return withContent(state, { ...content, publications });
    }
    default:
      return state;
  }
};
