import { UpdatePreferenceRequest } from "@baize/shared";
import { bots, forgetPreference, markPreferencePrivate, preferencesOf, profileOf } from "../state.js";
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
