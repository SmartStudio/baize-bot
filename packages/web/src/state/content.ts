import { loadTable, removeFromTable, writeTable } from "./stamped.js";
import type { Account, AccountId, LiveSession, LoginAttemptId } from "@baize/shared";
import { closeScreens, loginScreen } from "./live.js";
import type { Action, ContentBook, LiveEntry, LoginFlow, ReadyState } from "./types.js";

export const EMPTY_CONTENT: ContentBook = {
  drafts: {},
  plans: {},
  accounts: {},
  computers: {},
  publications: {},
  logins: {},
  live: {},
  stamps: {},
};

const entryOf = (session: LiveSession): LiveEntry => ({ ...session, id: session.liveId });

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

const sameAttempt = (flow: LoginFlow | undefined, attempt: LoginAttemptId): boolean =>
  (flow?.status === "opening" || flow?.status === "closed") && flow.attempt === attempt;

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
      // 网页这边的计时到点时画面还开着，就是电脑还在等人登，不算没等到。不用再计一轮：画面收起时卡会改成 closed。
      if (action.flow.status === "lapsed" && loginScreen(content.live, flow.attempt) !== null) return state;
      return withContent(state, { ...content, logins: { ...content.logins, [action.accountId]: action.flow } });
    }
    case "login_failed": {
      // 卡一开就带着这次的号，失败要对上号才算，旧尝试的失败不盖新尝试。
      const flow = content.logins[action.accountId];
      if (!sameAttempt(flow, action.attempt)) return state;
      const failed: LoginFlow = { status: "failed", reason: action.reason };
      return withContent(state, { ...content, logins: { ...content.logins, [action.accountId]: failed } });
    }
    case "login_dismissed": {
      // 用户在画面上点了「不登了」：复位按钮，不记失败。
      if (!sameAttempt(content.logins[action.accountId], action.attempt)) return state;
      const { [action.accountId]: _flow, ...logins } = content.logins;
      return withContent(state, { ...content, logins });
    }
    case "logins_settled": {
      const logins = { ...content.logins };
      for (const [id, flow] of Object.entries(content.logins) as [AccountId, LoginFlow | undefined][]) {
        // 画面收起后结果还会晚到，不算没等到；电脑离线了结果就不会再来，收起的也结成 offline。
        if (flow?.status !== "opening" && !(flow?.status === "closed" && action.flow.status === "offline")) continue;
        if (flow.startedAt >= action.before) continue;
        if (action.computerId !== null && content.accounts[id]?.computerId !== action.computerId) continue;
        // 画面还开着就是还在登，不算没等到；电脑离线时画面跟着没了，照样结成 offline。
        if (action.flow.status === "lapsed" && loginScreen(content.live, flow.attempt) !== null) continue;
        logins[id] = action.flow;
      }
      return withContent(state, { ...content, logins });
    }
    case "live_loaded": {
      const live = loadTable(content.live, content.stamps, action.seq, action.sessions.map(entryOf));
      return withContent(state, {
        ...content,
        live: live.rows,
        logins: closeScreens(content.logins, content.live, live.rows),
        stamps: live.stamps,
      });
    }
    case "live_upserted": {
      const live = writeTable(content.live, content.stamps, action.seq, [entryOf(action.session)]);
      return withContent(state, { ...content, live: live.rows, stamps: live.stamps });
    }
    case "live_removed": {
      const live = removeFromTable(content.live, content.stamps, action.seq, action.liveId);
      return withContent(state, {
        ...content,
        live: live.rows,
        logins: closeScreens(content.logins, content.live, live.rows),
        stamps: live.stamps,
      });
    }
    case "computers_loaded": {
      const computers = loadTable(content.computers, content.stamps, action.seq, action.computers);
      return withContent(state, { ...content, computers: computers.rows, stamps: computers.stamps });
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
