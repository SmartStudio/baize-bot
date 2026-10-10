import { DecideTeamOfferRequest } from "@baize/shared";
import { decideTeamOffer, seedHelperTool, seedTeamOffer } from "../state.js";
import { readBody, send, type Route } from "./http.js";

// 先放着点两次是 200，回卡现在的样子；确认过或放弃了的卡再点任何结论都是 409，和控制面一致。
export const teamOfferRoutes: Route = async ({ req, res, path, method, push }) => {
  if (method === "POST" && path === "/api/test/team-offer") {
    const { message, group, task } = seedTeamOffer();
    push({ type: "group_created", group, task });
    push({ type: "message", message });
    send(res, 200, { groupId: group.id, messageId: message.id });
    return true;
  }
  if (method === "POST" && path === "/api/test/helper-tool") {
    push({ type: "message", message: seedHelperTool() });
    send(res, 200, {});
    return true;
  }

  const match = /^\/api\/messages\/([^/]+)\/team-offer$/.exec(path);
  if (method !== "POST" || match === null) return false;
  const parsed = DecideTeamOfferRequest.safeParse(await readBody(req));
  if (!parsed.success) {
    send(res, 400, { error: "结论只能是确认或先放着" });
    return true;
  }
  const outcome = decideTeamOffer(decodeURIComponent(match[1] ?? ""), parsed.data);
  switch (outcome.kind) {
    case "missing":
      send(res, 404, { error: "这条消息不是一张建队卡" });
      break;
    case "closed":
      send(res, 409, { error: "这张建队卡已经处理过了" });
      break;
    case "rejected":
      send(res, 400, { error: outcome.error });
      break;
    case "gone":
      send(res, 409, { error: `卡上第 ${outcome.position} 位已经不在了，重新勾一下` });
      break;
    case "deferred":
      push({ type: "message", message: outcome.message });
      send(res, 200, { message: outcome.message, group: null, bots: [] });
      break;
    case "confirmed":
      for (const { bot, groupId } of outcome.created) push({ type: "bot_created", bot, groupId });
      push({ type: "group_updated", group: outcome.group });
      push({ type: "message", message: outcome.message });
      send(res, 200, { message: outcome.message, group: outcome.group, bots: outcome.created.map(({ bot }) => bot) });
      break;
  }
  return true;
};
