import type { AgentToControl } from "@baize/shared";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

/** 第 2 期形状占位。p2-memory-runner 在这里实现 remember_preference：单聊里当场记一条偏好，上行 preference_add。名字已登记在 gate.ts 的 INTERNAL_TOOLS。 */
export function createMemoryTools(_options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  return [];
}
