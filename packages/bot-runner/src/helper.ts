import type { AgentToControl } from "@baize/shared";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

/** 第 2 期形状占位。p2-helper-runner 在这里实现 call_helper：主助理拉一个一次性的帮手会话，结果文字回给主助理。名字已登记在 gate.ts 的 INTERNAL_TOOLS。 */
export function createHelperTools(_options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  return [];
}
