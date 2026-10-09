import type { AgentToControl } from "@baize/shared";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type RoutineOfferEvent = Extract<AgentToControl, { type: "routine_offer" }>;

/** 第 2 期形状占位。p2-routine-offer-cp 在这里接上：只收主助理，落成 routine_offer 消息。 */
export async function handleRoutineOffer(
  _deps: AgentEventDeps,
  _conn: AgentConnection,
  _event: RoutineOfferEvent,
): Promise<void> {
  throw new Error("未实现：routine_offer 由 p2-routine-offer-cp 接上");
}
