import type { AgentToControl } from "@baize/shared";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

/** 第 2 期形状占位。p2-routine-runner 在这里实现 propose_routine：主助理提议一条例行，上行 routine_offer。名字已登记在 gate.ts 的 INTERNAL_TOOLS。 */
export function createRoutineOfferTools(_options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  return [];
}
