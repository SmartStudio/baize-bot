import type { AgentToControl } from "@baize/shared";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type ReviewSubmitEvent = Extract<AgentToControl, { type: "review_submit" }>;

/** 第 2 期形状占位。p2-review 在这里接上：只收项目群例行里的 run，落 project_reviews，同一周再交覆盖。 */
export async function handleReviewSubmit(
  _deps: AgentEventDeps,
  _conn: AgentConnection,
  _event: ReviewSubmitEvent,
): Promise<void> {
  throw new Error("未实现：review_submit 由 p2-review 接上");
}
