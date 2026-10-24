import type { AgentToControl } from "@baize/shared";
import { log } from "../../log.js";
import { findAssistant } from "../../repo/bots.js";
import { appendMessage } from "../../repo/messages.js";
import { runBelongsTo, whileRunOpen } from "../../repo/runs.js";
import { lockOfferTarget } from "../../repo/team-offers.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type TeamOfferEvent = Extract<AgentToControl, { type: "team_offer" }>;

/**
 * 主助理出的建队卡，只落一条消息，谁都不加，要等用户点确认。
 * 只认主助理在自己单聊里发的、目标是这个用户的项目群、existing 的人都是他的 Bot；任一不成立整条丢掉。
 * 单聊是按归属人查出来的，所以 run 归属只剩 runBelongsTo 一道：这台电脑上主助理在单聊里的活。
 */
export async function handleTeamOffer(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: TeamOfferEvent,
): Promise<void> {
  const assistant = await findAssistant(deps.db, conn.ownerId);
  if (assistant === null || assistant.bot.id !== event.botId || assistant.groupId !== event.groupId) {
    log.warn("电脑报的建队卡不是主助理在它单聊里发的，整条丢掉", {
      computerId: conn.computerId,
      runId: event.runId,
      groupId: event.groupId,
      botId: event.botId,
    });
    return;
  }
  const groupId = assistant.groupId;
  if (!(await runBelongsTo(deps.db, event.runId, event.botId, groupId, conn.computerId))) {
    log.warn("电脑报的 run 不是主助理在单聊里的活，建队卡整条丢掉", {
      computerId: conn.computerId,
      runId: event.runId,
      groupId,
      botId: event.botId,
    });
    return;
  }
  const existing = event.members.flatMap((member) => (member.kind === "existing" ? [member.botId] : []));
  // 目标群和人选在落卡的事务里先锁后查：事务外查、或查完不锁，查到落卡之间目标被删空，落下的卡就永远确认不了。
  const message = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, async (tx) => {
    const projectGroupId = await lockOfferTarget(tx, conn.ownerId, event.projectGroupId, existing);
    if (projectGroupId === null) {
      log.warn("电脑报的建队卡指向的不是这个用户的项目群，或人选不是这个用户的 Bot，整条丢掉", {
        computerId: conn.computerId,
        runId: event.runId,
        projectGroupId: event.projectGroupId,
      });
      return null;
    }
    return appendMessage(tx, groupId, {
      kind: "team_offer",
      botId: event.botId,
      members: event.members,
      status: "offered",
      groupId: projectGroupId,
    });
  });
  if (message !== null) deps.push.push(conn.ownerId, { type: "message", message });
}
