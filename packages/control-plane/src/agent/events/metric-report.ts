import { reportedMetricKey, type AgentToControl } from "@baize/shared";
import { log } from "../../log.js";
import { recordSample } from "../../repo/metrics.js";
import { findGroupId } from "../../repo/messages.js";
import { runBelongsTo, whileRunOpen } from "../../repo/runs.js";
import { findTaskByGroup } from "../../repo/tasks.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type MetricReportEvent = Extract<AgentToControl, { type: "metric_report" }>;

/**
 * Bot 在项目群里读到一个数报上来（D1）。群要是这台电脑主人的，run 要是这台电脑上这个 Bot 在这个群里的活，
 * 群还得是项目群（recordSample 只认多 Bot 群）；任一不成立整条静默丢弃，不然一个 run 能往别的项目里记数。
 * 和其他 run 名下的写一样过 whileRunOpen：收尾之后晚到的数作废，不然旧 run 的旧数会顶成当前值。
 */
export async function handleMetricReport(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: MetricReportEvent,
): Promise<void> {
  const { runId, botId, groupId } = event;
  if ((await findGroupId(deps.db, conn.ownerId, groupId)) === null) return;
  if (!(await runBelongsTo(deps.db, runId, botId, groupId, conn.computerId))) {
    log.warn("电脑报的 run 不是它在这个群里的活，整条丢掉", { computerId: conn.computerId, runId, groupId });
    return;
  }
  const reported = reportedMetricKey(event.label);
  const recorded = await whileRunOpen(deps.db, { runId, botId, groupId }, (tx) =>
    recordSample(tx, conn.ownerId, groupId, event.value, "reported", ({ keys, goal }) =>
      keys.includes(reported) ? reported : goal,
    ),
  );
  if (recorded?.kind !== "recorded") return;
  const task = await findTaskByGroup(deps.db, recorded.groupId);
  if (task !== null) deps.push.push(conn.ownerId, { type: "task_updated", task });
}
