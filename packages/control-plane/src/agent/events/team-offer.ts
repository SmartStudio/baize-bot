import type { AgentToControl } from "@baize/shared";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type TeamOfferEvent = Extract<AgentToControl, { type: "team_offer" }>;

/** 第 2 期形状占位。p2-team-offer-cp 在这里接上：只收主助理、只落在主助理单聊、目标群必须是自己的项目群。 */
export async function handleTeamOffer(
  _deps: AgentEventDeps,
  _conn: AgentConnection,
  _event: TeamOfferEvent,
): Promise<void> {
  throw new Error("未实现：team_offer 由 p2-team-offer-cp 接上");
}
