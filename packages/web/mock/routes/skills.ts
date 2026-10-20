import { CreateSkillRequest, DecideSkillOfferRequest, type MessageBody, type Skill } from "@baize/shared";
import {
  bots,
  createSkill,
  findMessage,
  skillNameTaken,
  skills,
  skillsOf,
  writeMessageBody,
  writeSkill,
} from "../state.js";
import { readBody, send, type Route } from "./http.js";

type SkillOffer = Extract<MessageBody, { kind: "skill_offer" }>;
type Applied =
  | { kind: "ok"; skillId: Skill["id"] | null; updated: Skill | null; deleted: Skill | null }
  | { kind: "refused"; error: string };

// 和控制面 decideSkillOffer 同样的分派：撞名、改的那条已经不在了回 409，卡留着；删的那条已经不在了照样收成已删。
const applyChange = (offer: SkillOffer): Applied => {
  const { change, botId } = offer;
  switch (change.op) {
    case "add": {
      if (skillNameTaken(botId, change.name)) return { kind: "refused", error: "这个 Bot 已经有同名的 skill 了" };
      const skill = createSkill(botId, change, change.origin === null ? "chat" : "installed", change.origin);
      return { kind: "ok", skillId: skill.id, updated: skill, deleted: null };
    }
    case "edit": {
      const target = skills.get(change.targetId);
      if (target === undefined || target.botId !== botId) return { kind: "refused", error: "这个技能已经不在了" };
      if (skillNameTaken(botId, change.name, target.id)) {
        return { kind: "refused", error: "这个 Bot 已经有同名的 skill 了" };
      }
      const skill = writeSkill(target.id, { name: change.name, steps: change.steps });
      return skill === null
        ? { kind: "refused", error: "这个技能已经不在了" }
        : { kind: "ok", skillId: skill.id, updated: skill, deleted: null };
    }
    case "remove": {
      const target = skills.get(change.targetId);
      const deleted = target !== undefined && target.botId === botId ? target : null;
      if (deleted !== null) skills.delete(deleted.id);
      return { kind: "ok", skillId: null, updated: null, deleted };
    }
  }
};

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

  const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(path);
  if (skillMatch !== null) {
    const rawSkillId = skillMatch[1];
    const skillId = rawSkillId === undefined ? "" : decodeURIComponent(rawSkillId);
    const skill = skills.get(skillId);
    if (skill === undefined) send(res, 404, { error: "没有这条 skill" });
    else if (method === "DELETE") {
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
    const applied: Applied =
      parsed.data.decision === "save" ? applyChange(body) : { kind: "ok", skillId: null, updated: null, deleted: null };
    if (applied.kind === "refused") send(res, 409, { error: applied.error });
    else {
      const message = writeMessageBody(messageId, {
        ...body,
        status: parsed.data.decision === "save" ? "saved" : "dismissed",
        skillId: applied.skillId,
      });
      if (message === null) send(res, 404, { error: "这条消息不是一张存 skill 的卡" });
      else {
        push({ type: "message", message });
        if (applied.updated !== null) push({ type: "skill_updated", skill: applied.updated });
        if (applied.deleted !== null) {
          push({ type: "skill_deleted", skillId: applied.deleted.id, botId: applied.deleted.botId });
        }
        send(res, 200, { message, skill: applied.updated });
      }
    }
  }
  return true;
};
