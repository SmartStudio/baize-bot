import { PutComputerChoiceRequest, type ComputerKind } from "@baize/shared";
import { appendMessage, bots, chooseComputer, choicesOf, groups, hasComputer } from "../state.js";
import { readBody, send, type Route } from "./http.js";

// 文案和控制面 agent/computer-choice.ts 一字不差，网页照登 409 的原文。
const MISSING: Record<ComputerKind, string> = {
  remote: "你还没有云电脑，选不了",
  local: "你还没有接上自己的电脑，选不了",
};
const CHOSEN_TEXT: Record<ComputerKind, string> = { remote: "云电脑", local: "你的电脑" };

export const computerChoiceRoutes: Route = async ({ req, res, path, method, push }) => {
  const list = /^\/api\/groups\/([^/]+)\/computer-choices$/.exec(path);
  if (list !== null && method === "GET") {
    // 在任何 await 之前读完：跑完那条推送一发出去就来拉的，读到的已经是跑完之后的。
    const group = groups.get(decodeURIComponent(list[1] ?? ""));
    if (group === undefined) send(res, 404, { error: "没有这个群" });
    else send(res, 200, choicesOf(group));
    return true;
  }

  const one = /^\/api\/groups\/([^/]+)\/bots\/([^/]+)\/computer$/.exec(path);
  if (one === null || method !== "PUT") return false;
  const group = groups.get(decodeURIComponent(one[1] ?? ""));
  const botId = decodeURIComponent(one[2] ?? "");
  const bot = bots.get(botId);
  const parsed = PutComputerChoiceRequest.safeParse(await readBody(req));
  if (group === undefined || bot === undefined || !group.botIds.some((id) => id === botId))
    send(res, 404, { error: "这个群里没有这个 Bot" });
  else if (!parsed.success) send(res, 400, { error: "只能选你的电脑或云电脑" });
  else if (!hasComputer(parsed.data.kind)) send(res, 409, { error: MISSING[parsed.data.kind] });
  else {
    if (chooseComputer(group.id, bot.id, parsed.data.kind)) {
      const text = `${bot.name}之后在这个群里用${CHOSEN_TEXT[parsed.data.kind]}`;
      push({ type: "message", message: appendMessage(group.id, { kind: "system", text }) });
      push({ type: "computer_choice_updated", groupId: group.id, botId: bot.id, kind: parsed.data.kind });
    }
    send(res, 204);
  }
  return true;
};
