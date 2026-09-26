import { DecideProjectOfferRequest } from "@baize/shared";
import { findMessage, startProject, writeMessageBody } from "../state.js";
import { readBody, send, type Route } from "./http.js";

export const projectRoutes: Route = async ({ req, res, path, method, push }) => {
  const match = /^\/api\/messages\/([^/]+)\/project-offer$/.exec(path);
  if (match === null || method !== "POST") return false;
  const messageId = decodeURIComponent(match[1] ?? "");
  const parsed = DecideProjectOfferRequest.safeParse(await readBody(req));
  if (!parsed.success) {
    send(res, 400, { error: "结论只能是开始或不要" });
    return true;
  }
  if (parsed.data.decision === "dismiss") {
    const card = findMessage(messageId);
    const body = card?.body;
    if (card === null || body?.kind !== "project_offer") send(res, 404, { error: "这条消息不是一张方案卡" });
    else if (body.status !== "offered") send(res, 200, { message: card, group: null });
    else {
      const message = writeMessageBody(card.id, { ...body, status: "dismissed" });
      if (message !== null) push({ type: "message", message });
      send(res, 200, { message, group: null });
    }
    return true;
  }
  const started = startProject(messageId, parsed.data.name);
  if (started.kind === "missing") send(res, 404, { error: "这条消息不是一张方案卡" });
  else if (started.kind === "settled") send(res, 200, { message: started.message, group: started.group });
  else {
    push({ type: "message", message: started.message });
    for (const bot of started.members) push({ type: "bot_updated", bot });
    push({ type: "group_created", group: started.group, task: started.task });
    send(res, 200, { message: started.message, group: started.group });
  }
  return true;
};
