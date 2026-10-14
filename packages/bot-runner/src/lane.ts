import type { ControlToAgent, GroupId, RunId } from "@baize/shared";
import type { BotSession } from "./bot-session.js";
import type { BotGeneration } from "./index.js";
import type { RememberingRun } from "./memory.js";
import type { Recalls } from "./recall.js";
import { SerialQueue } from "./serial-queue.js";
import type { TakeoverSlot } from "./takeover.js";
import type { WorkMirror } from "./work-mirror.js";

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
  readonly recalls: Recalls;
  readonly mirrors: Map<"chat" | "table", WorkMirror>;
  active: LaneActive | null;
  /** 这个群里正挂着的 `browser_ask_user`，用户发新消息时按它作废。 */
  readonly takeover: TakeoverSlot;
  phase: "ready" | "stopped";
  stopping: Promise<void> | null;
}

export function createLane(groupId: GroupId): Lane {
  return {
    groupId,
    queue: new SerialQueue(),
    sessions: new Map(),
    recalls: new Map(),
    mirrors: new Map(),
    active: null,
    takeover: { current: null },
    phase: "ready",
    stopping: null,
  };
}

export function findLaneRun(lanes: Iterable<Lane>, runId: RunId) {
  for (const lane of lanes) {
    const found = lane.queue.find((message) => message.runId === runId);
    if (found !== null) return { lane, phase: found.phase, message: found.value };
  }
  return null;
}
