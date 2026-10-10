import type { Approval, Handoff } from "@baize/shared";
import type { Action, ReadyState } from "./types.js";

type Settling = { id: string; status: Approval["status"] | Handoff["status"] };

// 这里只管卡片。角标不在这里加减，只认 groups_loaded 和 pending_counts_loaded 两份绝对快照，见 groups.ts。
// 本地已有结论的卡不退回 pending：说 pending 的那份是拉取在飞时拍下的旧快照，收下它审批卡会重新长出两颗按钮。
const merged = <T extends Settling>(table: Record<string, T>, incoming: readonly T[]): Record<string, T> => {
  const next = { ...table };
  for (const record of incoming) {
    const previous = next[record.id];
    if (previous !== undefined && previous.status !== "pending" && record.status === "pending") continue;
    next[record.id] = record;
  }
  return next;
};

export const reduceApprovals = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "approvals_loaded":
      return { ...state, approvals: merged(state.approvals, action.approvals) };
    case "approval_pushed":
      return { ...state, approvals: merged(state.approvals, [action.approval]) };
    case "handoffs_loaded":
      return { ...state, handoffs: merged(state.handoffs, action.handoffs) };
    case "handoff_pushed":
      return { ...state, handoffs: merged(state.handoffs, [action.handoff]) };
    default:
      return state;
  }
};
