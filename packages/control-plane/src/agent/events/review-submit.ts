import type { AgentToControl } from "@baize/shared";
import { log } from "../../log.js";
import { findSoloBotId } from "../../repo/groups.js";
import { findGroupId } from "../../repo/messages.js";
import { saveReview } from "../../repo/project-page.js";
import { routineRunOfRun } from "../../repo/routines.js";
import { runBelongsTo, whileRunOpen } from "../../repo/runs.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type ReviewSubmitEvent = Extract<AgentToControl, { type: "review_submit" }>;

/**
 * 主助理在项目群的例行里交一份周复盘，进项目页的「成果」。群要是这台电脑主人的项目群（单聊没有项目页），
 * run 要是这台电脑上这个 Bot 在这个群里的活，还得是例行派的：当面让它复盘那次是聊天，不该顶掉周五那份。
 * 任一不成立整条静默丢弃。receivedAt 是 hub 收到这一帧的时刻，等链、等锁都不改变它。
 */
export async function handleReviewSubmit(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: ReviewSubmitEvent,
  receivedAt: Date,
): Promise<void> {
  const { runId, botId, groupId } = event;
  if ((await findGroupId(deps.db, conn.ownerId, groupId)) === null) return;
  if ((await findSoloBotId(deps.db, groupId)) !== null) {
    log.warn("电脑报的复盘来自单聊，单聊没有项目页，整条丢掉", { computerId: conn.computerId, runId, groupId, botId });
    return;
  }
  if (!(await runBelongsTo(deps.db, runId, botId, groupId, conn.computerId))) {
    log.warn("电脑报的 run 不是它在这个群里的活，整条丢掉", { computerId: conn.computerId, runId, groupId });
    return;
  }
  if ((await routineRunOfRun(deps.db, runId)) === null) {
    log.warn("电脑报的复盘不是例行派的活，整条丢掉", { computerId: conn.computerId, runId, groupId, botId });
    return;
  }

  await whileRunOpen(deps.db, { runId, botId, groupId }, (tx) =>
    saveReview(tx, { groupId, runId, body: event.body, receivedAt }),
  );
}
