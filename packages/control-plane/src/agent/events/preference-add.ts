import type { AgentToControl } from "@baize/shared";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type PreferenceAddEvent = Extract<AgentToControl, { type: "preference_add" }>;

/** 第 2 期形状占位。p2-pref-cp 在这里接上：只收该 Bot 单聊里的 run，写 bot_preferences、推 preference_updated、重发 config。 */
export async function handlePreferenceAdd(
  _deps: AgentEventDeps,
  _conn: AgentConnection,
  _event: PreferenceAddEvent,
): Promise<void> {
  throw new Error("未实现：preference_add 由 p2-pref-cp 接上");
}
