import type { AgentToControl } from "@baize/shared";
import { findSoloBotId } from "../../repo/groups.js";
import { appendMessage, findGroupId } from "../../repo/messages.js";
import { runBelongsTo, whileRunOpen } from "../../repo/runs.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type PreferenceOfferEvent = Extract<AgentToControl, { type: "preference_offer" }>;

/**
 * Bot 在单聊里提议记一条偏好（D10），落成一张等你点「记住」的卡，这里不写偏好。群要是这台电脑主人的、恰好是这个 Bot 的单聊，
 * run 要是这台电脑上它在这里的活，任一不成立整条静默丢弃：项目群里听到的话是对项目说的，不该变成这个 Bot 走到哪都套用的偏好。
 */
export async function handlePreferenceOffer(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: PreferenceOfferEvent,
): Promise<void> {
  const { runId, botId, groupId } = event;
  if ((await findGroupId(deps.db, conn.ownerId, groupId)) === null) return;
  if ((await findSoloBotId(deps.db, groupId)) !== botId) {
    console.warn(`电脑 ${conn.computerId} 报的偏好来自群 ${groupId}，不是 ${botId} 的单聊，整条丢掉`);
    return;
  }
  if (!(await runBelongsTo(deps.db, runId, botId, groupId, conn.computerId))) {
    console.warn(`电脑 ${conn.computerId} 报的 run ${runId} 不是它在群 ${groupId} 里的活，整条丢掉`);
    return;
  }

  const message = await whileRunOpen(deps.db, { runId, botId, groupId }, (tx) =>
    appendMessage(tx, groupId, {
      kind: "preference_offer",
      botId,
      text: event.text,
      private: event.private,
      sourceMessageId: event.sourceMessageId,
      status: "offered",
      preferenceId: null,
    }),
  );
  if (message === null) return;
  deps.push.push(conn.ownerId, { type: "message", message });
}
