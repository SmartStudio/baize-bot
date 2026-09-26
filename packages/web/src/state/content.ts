import { writeTable } from "./stamped.js";
import type { Action, ContentBook, ReadyState } from "./types.js";

export const EMPTY_CONTENT: ContentBook = {
  drafts: {},
  plans: {},
  accounts: {},
  computers: {},
  publications: {},
  stamps: {},
};

const keyed = <T extends { id: string }>(table: Record<string, T>, rows: T[]): Record<string, T> => {
  const next = { ...table };
  for (const row of rows) next[row.id] = row;
  return next;
};

const withContent = (state: ReadyState, content: ContentBook): ReadyState => ({ ...state, content });

export const reduceContent = (state: ReadyState, action: Action): ReadyState => {
  const content = state.content;
  switch (action.type) {
    case "content_loaded": {
      // 草稿不是只进不退的：批过的被 Bot 改了会回到 pending，所以不能像审批那样拿「已有结论」挡旧数据，只能比先后。
      const drafts = writeTable(content.drafts, content.stamps, action.seq, action.drafts);
      const plans = writeTable(content.plans, drafts.stamps, action.seq, action.plans);
      return withContent(state, { ...content, drafts: drafts.rows, plans: plans.rows, stamps: plans.stamps });
    }
    case "accounts_loaded":
      return withContent(state, {
        ...content,
        accounts: keyed({}, action.accounts),
        computers: keyed({}, action.computers),
      });
    case "account_upserted":
      return withContent(state, { ...content, accounts: keyed(content.accounts, [action.account]) });
    case "account_removed": {
      const { [action.accountId]: _removed, ...accounts } = content.accounts;
      return withContent(state, { ...content, accounts });
    }
    case "computer_upserted":
      return withContent(state, { ...content, computers: keyed(content.computers, [action.computer]) });
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
