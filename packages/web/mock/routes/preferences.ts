import { DecidePreferenceOfferRequest, UpdatePreferenceRequest } from "@baize/shared";
import {
  bots,
  findMessage,
  forgetPreference,
  markPreferencePrivate,
  preferencesOf,
  profileOf,
  rememberPreference,
  writeMessageBody,
} from "../state.js";
import { readBody, send, type Route } from "./http.js";

export const preferenceRoutes: Route = async ({ req, res, path, method, push }) => {
  const botSide = /^\/api\/bots\/([^/]+)\/(preferences|profile)$/.exec(path);
  if (botSide !== null && method === "GET") {
    const botId = decodeURIComponent(botSide[1] ?? "");
    if (!bots.has(botId)) send(res, 404, { error: "没有这个 Bot" });
    else if (botSide[2] === "profile") send(res, 200, profileOf(botId));
    else send(res, 200, { items: preferencesOf(botId) });
    return true;
  }

  const offerMatch = /^\/api\/messages\/([^/]+)\/preference-offer$/.exec(path);
  if (offerMatch !== null && method === "POST") {
    const messageId = decodeURIComponent(offerMatch[1] ?? "");
    const parsed = DecidePreferenceOfferRequest.safeParse(await readBody(req));
    const body = findMessage(messageId)?.body;
    if (body === undefined || body.kind !== "preference_offer") send(res, 404, { error: "这条消息不是一张记偏好的卡" });
    else if (!parsed.success) send(res, 400, { error: "结论只能是记住或不用" });
    else if (body.status !== "offered") send(res, 409, { error: "这条卡已经有结论了" });
    else {
      const preference =
        parsed.data.decision === "save"
          ? rememberPreference(body.botId, body.text, body.private, body.sourceMessageId)
          : null;
      const message = writeMessageBody(
        messageId,
        preference === null
          ? { ...body, status: "dismissed" }
          : { ...body, status: "saved", preferenceId: preference.id },
      );
      if (message === null) send(res, 404, { error: "这条消息不是一张记偏好的卡" });
      else {
        push({ type: "message", message });
        if (preference !== null) push({ type: "preference_updated", preference });
        send(res, 200, { message, preference });
      }
    }
    return true;
  }

  const single = /^\/api\/preferences\/([^/]+)$/.exec(path);
  if (single === null) return false;
  const id = decodeURIComponent(single[1] ?? "");
  if (method === "DELETE") {
    const removed = forgetPreference(id);
    if (removed === null) send(res, 404, { error: "没有这条偏好" });
    else {
      push({ type: "preference_deleted", preferenceId: removed.id, botId: removed.botId });
      send(res, 204);
    }
    return true;
  }
  if (method === "PATCH") {
    const parsed = UpdatePreferenceRequest.safeParse(await readBody(req));
    if (!parsed.success) {
      send(res, 400, { error: "只能改私人与否" });
      return true;
    }
    const next = markPreferencePrivate(id, parsed.data.private);
    if (next === null) send(res, 404, { error: "没有这条偏好" });
    else {
      push({ type: "preference_updated", preference: next });
      send(res, 200, { preference: next });
    }
    return true;
  }
  return false;
};
