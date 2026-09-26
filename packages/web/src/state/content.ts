import type { Action, ContentBook, ReadyState } from "./types.js";

export const EMPTY_CONTENT: ContentBook = { drafts: {}, plans: {}, accounts: {}, computers: {}, publications: {} };

const keyed = <T extends { id: string }>(table: Record<string, T>, rows: T[]): Record<string, T> => {
  const next = { ...table };
  for (const row of rows) next[row.id] = row;
  return next;
};

const filled = <T extends { id: string }>(table: Record<string, T>, rows: T[]): Record<string, T> => {
  const next = { ...table };
  for (const row of rows) next[row.id] ??= row;
  return next;
};

const withContent = (state: ReadyState, content: ContentBook): ReadyState => ({ ...state, content });

// 草稿不是只进不退的：批过的被 Bot 改了会回到 pending，所以不能像审批那样拿「已有结论」挡旧数据。
// 接口响应和推送谁后到谁作数；首页快照照 SnapshotMerge 只补缺。
export const reduceContent = (state: ReadyState, action: Action): ReadyState => {
  const content = state.content;
  switch (action.type) {
    case "content_loaded":
      return withContent(state, {
        ...content,
        drafts: keyed(content.drafts, action.drafts),
        plans: keyed(content.plans, action.plans),
      });
    case "today_snapshot_loaded": {
      const merge = action.merge === "resync" ? keyed : filled;
      return withContent(state, {
        ...content,
        drafts: merge(content.drafts, action.drafts),
        plans: merge(content.plans, action.plans),
      });
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
