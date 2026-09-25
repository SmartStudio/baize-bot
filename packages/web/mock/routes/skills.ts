import { CopySkillRequest, CreateSkillRequest, DecideSkillOfferRequest, UpdateSkillRequest } from "@baize/shared";
import {
  bots,
  copySkillTo,
  createSkill,
  findMessage,
  skillNameTaken,
  skills,
  skillsOf,
  writeMessageBody,
  writeSkill,
} from "../state.js";
import { defined, readBody, send, type Route } from "./http.js";

export const skillRoutes: Route = async ({ req, res, path, method, push }) => {
  const botSkillsMatch = /^\/api\/bots\/([^/]+)\/skills$/.exec(path);
  if (botSkillsMatch !== null) {
    const rawBotId = botSkillsMatch[1];
    const botId = rawBotId === undefined ? "" : decodeURIComponent(rawBotId);
    if (!bots.has(botId)) send(res, 404, { error: "没有这个 Bot" });
    else if (method === "GET") send(res, 200, { items: skillsOf(botId) });
    else if (method === "POST") {
      const parsed = CreateSkillRequest.safeParse(await readBody(req));
      if (!parsed.success) send(res, 400, { error: "skill 字段不对" });
      else if (skillNameTaken(botId, parsed.data.name)) send(res, 409, { error: "这个 Bot 已经有同名的 skill 了" });
      else {
        const skill = createSkill(botId, parsed.data, "taught");
        push({ type: "skill_updated", skill });
        send(res, 201, { skill });
      }
    } else return false;
    return true;
  }

  const copyMatch = /^\/api\/skills\/([^/]+)\/copy$/.exec(path);
  if (copyMatch !== null && method === "POST") {
    const rawSkillId = copyMatch[1];
    const skillId = rawSkillId === undefined ? "" : decodeURIComponent(rawSkillId);
    const parsed = CopySkillRequest.safeParse(await readBody(req));
    const skill = skills.get(skillId);
    if (skill === undefined) send(res, 404, { error: "没有这条 skill" });
    else if (!parsed.success) send(res, 400, { error: "skill 字段不对" });
    else if (!bots.has(parsed.data.botId)) send(res, 404, { error: "没有这个 Bot" });
    else if (skillNameTaken(parsed.data.botId, skill.name)) {
      send(res, 409, { error: "这个 Bot 已经有同名的 skill 了" });
    } else {
      const copy = copySkillTo(skillId, parsed.data.botId);
      if (copy === null) send(res, 404, { error: "没有这条 skill" });
      else {
        push({ type: "skill_updated", skill: copy });
        send(res, 201, { skill: copy });
      }
    }
    return true;
  }

  const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(path);
  if (skillMatch !== null) {
    const rawSkillId = skillMatch[1];
    const skillId = rawSkillId === undefined ? "" : decodeURIComponent(rawSkillId);
    const skill = skills.get(skillId);
    if (skill === undefined) send(res, 404, { error: "没有这条 skill" });
    else if (method === "PATCH") {
      const parsed = UpdateSkillRequest.safeParse(await readBody(req));
      if (!parsed.success) send(res, 400, { error: "skill 字段不对" });
      else {
        const patch = defined(parsed.data);
        if (patch.name !== undefined && skillNameTaken(skill.botId, patch.name, skill.id)) {
          send(res, 409, { error: "这个 Bot 已经有同名的 skill 了" });
        } else {
          const next = writeSkill(skillId, patch);
          if (next === null) send(res, 404, { error: "没有这条 skill" });
          else {
            push({ type: "skill_updated", skill: next });
            send(res, 200, { skill: next });
          }
        }
      }
    } else if (method === "DELETE") {
      skills.delete(skillId);
      push({ type: "skill_deleted", skillId: skill.id, botId: skill.botId });
      send(res, 204);
    } else return false;
    return true;
  }

  const offerMatch = /^\/api\/messages\/([^/]+)\/skill-offer$/.exec(path);
  if (offerMatch === null || method !== "POST") return false;
  const rawMessageId = offerMatch[1];
  const messageId = rawMessageId === undefined ? "" : decodeURIComponent(rawMessageId);
  const parsed = DecideSkillOfferRequest.safeParse(await readBody(req));
  const card = findMessage(messageId);
  const body = card?.body;
  if (body === undefined || body.kind !== "skill_offer") send(res, 404, { error: "这条消息不是一张存 skill 的卡" });
  else if (!parsed.success) send(res, 400, { error: "结论只能是存或不存" });
  else if (body.status !== "offered") send(res, 409, { error: "这张卡已经有结论了" });
  else {
    const saving = parsed.data.decision === "save";
    if (saving && skillNameTaken(body.botId, body.name)) send(res, 409, { error: "这个 Bot 已经有同名的 skill 了" });
    else {
      const skill = saving ? createSkill(body.botId, { name: body.name, steps: body.steps }, "chat") : null;
      const message = writeMessageBody(
        messageId,
        skill === null ? { ...body, status: "dismissed" } : { ...body, status: "saved", skillId: skill.id },
      );
      if (message === null) send(res, 404, { error: "这条消息不是一张存 skill 的卡" });
      else {
        push({ type: "message", message });
        if (skill !== null) push({ type: "skill_updated", skill });
        send(res, 200, { message, skill });
      }
    }
  }
  return true;
};
