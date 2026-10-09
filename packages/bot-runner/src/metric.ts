import type { AgentToControl } from "@baize/shared";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

/** 第 2 期形状占位。p2-metric-runner 在这里实现 report_metric：项目群里报一个指标值，上行 metric_report。名字已登记在 gate.ts 的 INTERNAL_TOOLS。 */
export function createMetricTools(_options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  return [];
}
