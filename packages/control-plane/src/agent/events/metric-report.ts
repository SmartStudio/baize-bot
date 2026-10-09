import type { AgentToControl } from "@baize/shared";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type MetricReportEvent = Extract<AgentToControl, { type: "metric_report" }>;

/** 第 2 期形状占位。p2-metric-cp 在这里接上：只收属于这个项目群的 run，落一条 metric_samples 样本。 */
export async function handleMetricReport(
  _deps: AgentEventDeps,
  _conn: AgentConnection,
  _event: MetricReportEvent,
): Promise<void> {
  throw new Error("未实现：metric_report 由 p2-metric-cp 接上");
}
