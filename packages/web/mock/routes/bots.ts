import { Bot, CreateBotRequest, UpdateBotRequest } from "@baize/shared";
import {
  bots,
  createBot,
  groupIdByBotId,
  groups,
  lastMessageOf,
  messagesByGroupId,
  pendingApprovalsOf,
  pendingHandoffsOf,
} from "../state.js";
import { defined, readBody, send, type Route } from "./http.js";

const botListItems = () =>
  [...bots.values()].map((bot) => {
    const groupId = groupIdByBotId.get(bot.id);
    if (groupId === undefined) throw new Error(`Bot ${bot.id} 没有群，mock 状态坏了`);
    return {
      bot,
      groupId,
      lastMessage: lastMessageOf(groupId),
      pendingApprovals: pendingApprovalsOf(groupId),
      pendingHandoffs: pendingHandoffsOf(groupId),
    };
  });

export const botRoutes: Route = async ({ req, res, path, method, push }) => {
  if (method === "GET" && path === "/api/bots") {
    send(res, 200, { items: botListItems() });
    return true;
  }

  if (method === "POST" && path === "/api/bots") {
    const parsed = CreateBotRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "Bot 字段不对" });
    else send(res, 200, createBot(parsed.data));
    return true;
  }

  const match = /^\/api\/bots\/([^/]+)$/.exec(path);
  if (match === null) return false;
  const rawBotId = match[1];
  if (rawBotId === undefined) {
    send(res, 404, { error: "没有这个 Bot" });
    return true;
  }
  const botId = decodeURIComponent(rawBotId);
  const bot = bots.get(botId);
  if (bot === undefined) send(res, 404, { error: "没有这个 Bot" });
  else if (method === "PATCH") {
    const parsed = UpdateBotRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "Bot 字段不对" });
    else {
      const next = Bot.parse({ ...bot, ...defined(parsed.data) });
      bots.set(botId, next);
      push({ type: "bot_updated", bot: next });
      send(res, 200, { bot: next });
    }
  } else if (method === "DELETE") {
    bots.delete(botId);
    const groupId = groupIdByBotId.get(botId);
    if (groupId) {
      groups.delete(groupId);
      messagesByGroupId.delete(groupId);
      groupIdByBotId.delete(botId);
    }
    push({ type: "bot_deleted", botId: bot.id });
    send(res, 204);
  } else return false;
  return true;
};
