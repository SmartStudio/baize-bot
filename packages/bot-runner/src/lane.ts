import type { ControlToAgent, GroupId, RunId } from "@baize/shared";
import type { BotSession } from "./bot-session.js";
import type { BotGeneration } from "./index.js";
import type { RememberingRun } from "./memory.js";
import { SerialQueue } from "./serial-queue.js";

type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;
export type LaneActive = RememberingRun & {
  readonly table: PromptMessage["table"];
  readonly control: AbortController;
  generation: BotGeneration | null;
};
export type LaneSession = BotSession & {
  readonly fingerprint: string;
  readonly tableRole: NonNullable<PromptMessage["table"]>["role"] | null;
};

export interface Lane {
  readonly groupId: GroupId;
  readonly queue: SerialQueue<PromptMessage>;
  readonly sessions: Map<"chat" | "table", LaneSession>;
  active: LaneActive | null;
  phase: "ready" | "stopped";
  stopping: Promise<void> | null;
}

export function createLane(groupId: GroupId): Lane {
  return { groupId, queue: new SerialQueue(), sessions: new Map(), active: null, phase: "ready", stopping: null };
}

export function findLaneRun(lanes: Iterable<Lane>, runId: RunId) {
  for (const lane of lanes) {
    const found = lane.queue.find((message) => message.runId === runId);
    if (found !== null) return { lane, phase: found.phase, message: found.value };
  }
  return null;
}
