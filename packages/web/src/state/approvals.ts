import type { Approval, GroupId, Handoff } from "@baize/shared";
import type { Action, Conversation, ReadyState } from "./types.js";

type SettlingStatus = Approval["status"] | Handoff["status"];
type Settling = { id: string; groupId: GroupId; status: SettlingStatus };
type PendingCount = "pendingApprovals" | "pendingHandoffs";

const reconcile = <T extends Settling>(
  previous: T | undefined,
  next: T,
  from: "history" | "push",
): { record: T; delta: number } | null => {
  // 拉历史带回来的那批，GET /api/bots 和 /api/groups 的计数已经算进去了，这里再加一次就翻倍。
  if (previous === undefined) return { record: next, delta: from === "push" && next.status === "pending" ? 1 : 0 };
  if (previous.status === "pending") return { record: next, delta: next.status === "pending" ? 0 : -1 };
  // 本地已经有结论了。结论不会退回 pending，所以说 pending 的那份是拉取在飞时拍下的旧快照。收下它，审批卡会
  // 重新长出两颗按钮，而角标早就减过了，再点只会拿到一个 409。
  return next.status === "pending" ? null : { record: next, delta: 0 };
};

const bumped = (conversation: Conversation, count: PendingCount, delta: number): Conversation =>
  count === "pendingApprovals"
    ? { ...conversation, pendingApprovals: Math.max(0, conversation.pendingApprovals + delta) }
    : { ...conversation, pendingHandoffs: Math.max(0, conversation.pendingHandoffs + delta) };

const settled = <T extends Settling>(
  state: ReadyState,
  table: Record<string, T>,
  incoming: T[],
  from: "history" | "push",
  count: PendingCount,
): { table: Record<string, T>; conversations: Conversation[] } => {
  const next = { ...table };
  const deltaByGroup = new Map<GroupId, number>();
  for (const record of incoming) {
    const merged = reconcile(next[record.id], record, from);
    if (merged === null) continue;
    next[merged.record.id] = merged.record;
    if (merged.delta !== 0) deltaByGroup.set(record.groupId, (deltaByGroup.get(record.groupId) ?? 0) + merged.delta);
  }
  if (deltaByGroup.size === 0) return { table: next, conversations: state.conversations };
  return {
    table: next,
    conversations: state.conversations.map((c) => {
      const delta = deltaByGroup.get(c.groupId) ?? 0;
      return delta === 0 ? c : bumped(c, count, delta);
    }),
  };
};

const withApprovals = (state: ReadyState, incoming: Approval[], from: "history" | "push"): ReadyState => {
  const { table, conversations } = settled(state, state.approvals, incoming, from, "pendingApprovals");
  return { ...state, approvals: table, conversations };
};

const withHandoffs = (state: ReadyState, incoming: Handoff[], from: "history" | "push"): ReadyState => {
  const { table, conversations } = settled(state, state.handoffs, incoming, from, "pendingHandoffs");
  return { ...state, handoffs: table, conversations };
};

export const reduceApprovals = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "approvals_loaded":
      return withApprovals(state, action.approvals, "history");
    case "approval_pushed":
      return withApprovals(state, [action.approval], "push");
    case "handoffs_loaded":
      return withHandoffs(state, action.handoffs, "history");
    case "handoff_pushed":
      return withHandoffs(state, [action.handoff], "push");
    default:
      return state;
  }
};
