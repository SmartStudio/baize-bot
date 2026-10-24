import { GroupId, type AgentToControl } from "@baize/shared";
import { log } from "../../log.js";
import { findAssistant, findBot } from "../../repo/bots.js";
import { appendMessage, findGroupId } from "../../repo/messages.js";
import { runBelongsTo, whileRunOpen } from "../../repo/runs.js";
import { isValidCron } from "../../routines/cron.js";
import type { AgentEventDeps } from "../events.js";
import type { AgentConnection } from "../hub.js";

export type RoutineOfferEvent = Extract<AgentToControl, { type: "routine_offer" }>;

/**
 * 主助理在自己单聊里提议一条例行，落成一张等你点「加上」的卡。别的 Bot 发的、发在别处的整条丢掉。
 * 目标群和执行者都是外部输入，先认归属；执行者在不在目标群里留到点加上那一刻再认，两者之间群成员会变。
 */
export async function handleRoutineOffer(
  deps: AgentEventDeps,
  conn: AgentConnection,
  event: RoutineOfferEvent,
): Promise<void> {
  const drop = (why: string) =>
    log.warn(`电脑报的例行卡整条丢掉：${why}`, { computerId: conn.computerId, runId: event.runId, botId: event.botId });

  const assistant = await findAssistant(deps.db, conn.ownerId);
  if (assistant === null) return drop("这个人没有主助理");
  // 主助理单聊里只有主助理的 run，所以 run 对得上这个群就是「主助理在它单聊里发的」，报文自报的群号不用再信。
  const groupId = assistant.groupId;
  if (!(await runBelongsTo(deps.db, event.runId, event.botId, groupId, conn.computerId))) {
    return drop("不是主助理在它单聊里发的");
  }
  if (!isValidCron(event.cron)) return drop(`cron 表达式不合法：${event.cron}`);
  if ((await findBot(deps.db, conn.ownerId, event.executorBotId)) === null) return drop("执行者不是这个人的 Bot");
  const target = event.projectGroupId === null ? null : await findGroupId(deps.db, conn.ownerId, event.projectGroupId);
  if (event.projectGroupId !== null && target === null) return drop("目标群不是这个人的");

  const { name, instruction, cron, executorBotId, boundary, purpose, onToday } = event;
  const message = await whileRunOpen(deps.db, { runId: event.runId, botId: event.botId, groupId }, (tx) =>
    appendMessage(tx, groupId, {
      kind: "routine_offer",
      botId: event.botId,
      name,
      instruction,
      cron,
      executorBotId,
      boundary,
      purpose,
      onToday,
      groupId: target === null ? null : GroupId.parse(target),
      status: "offered",
      routineId: null,
    }),
  );
  if (message !== null) deps.push.push(conn.ownerId, { type: "message", message });
}
