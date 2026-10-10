import { BotId, DecideRoutineOfferRequest, GroupId, Routine } from "@baize/shared";
import { z } from "zod";
import {
  appendMessage,
  bots,
  createRoutine,
  findMessage,
  groupIdByBotId,
  groups,
  routines,
  writeMessageBody,
  TEAM_GROUP_ID,
} from "../state.js";
import { readBody, send, type Route } from "./http.js";

const ASSISTANT_ID = BotId.parse("bot_assistant");

// 测试种卡时可以换掉几样，造出长文本、执行者不在群里这些情形。
const OfferSeed = z
  .object({
    name: z.string().min(1).max(40).default("同类项目周报"),
    instruction: z.string().min(1).max(4000).default("每周五汇总这个项目的进度、卡点和下周要做的事"),
    executorBotId: BotId.default(BotId.parse("bot_service")),
    groupId: GroupId.nullable().default(GroupId.parse(TEAM_GROUP_ID)),
  })
  .strict();

// 例行的结果落在它挂的项目群，不挂项目的落在执行者自己的单聊。
const resultGroupOf = (routine: Routine): string | undefined => routine.groupId ?? groupIdByBotId.get(routine.botId);

export const routineOfferRoutes: Route = async ({ req, res, path, method, push }) => {
  if (method === "POST" && path === "/api/test/routine-offer") {
    const groupId = groupIdByBotId.get(ASSISTANT_ID);
    const seed = OfferSeed.safeParse(await readBody(req));
    if (!seed.success) send(res, 400, { error: "种卡参数不对" });
    else if (groupId === undefined) send(res, 404, { error: "没有主助理" });
    else {
      const message = appendMessage(groupId, {
        kind: "routine_offer",
        botId: ASSISTANT_ID,
        ...seed.data,
        cron: "0 17 * * 5",
        boundary: "read_only",
        purpose: "plan",
        onToday: true,
        status: "offered",
        routineId: null,
      });
      push({ type: "message", message });
      send(res, 201, { message });
    }
    return true;
  }

  const seenMatch = /^\/api\/groups\/([^/]+)\/seen$/.exec(path);
  if (seenMatch !== null && method === "POST") {
    const groupId = decodeURIComponent(seenMatch[1] ?? "");
    if (!groups.has(groupId)) send(res, 404, { error: "没有这个群" });
    else {
      const now = new Date().toISOString();
      for (const routine of routines.values()) {
        if (resultGroupOf(routine) !== groupId) continue;
        const unseen = (run: Routine["runs"][number]) => run.status !== "running" && run.seenAt === null;
        if (!routine.runs.some(unseen)) continue;
        const runs = routine.runs.map((run) => (unseen(run) ? { ...run, seenAt: now } : run));
        const stamped = Routine.parse({ ...routine, runs });
        routines.set(stamped.id, stamped);
        // 照控制面：盖了章的例行各推一遍，别的窗口的「没人看」计数跟着清。
        push({ type: "routine_updated", routine: stamped });
      }
      send(res, 204);
    }
    return true;
  }

  const match = /^\/api\/messages\/([^/]+)\/routine-offer$/.exec(path);
  if (match === null || method !== "POST") return false;
  // 控制面靠 WHERE status = 'offered' 让同一张卡只有一个请求拍得动。mock 的对应做法是读完请求体才认卡，
  // 认卡、判状态、写卡之间不 await；先认卡再等请求体，后到的请求手里就是作废的 offered。
  const parsed = DecideRoutineOfferRequest.safeParse(await readBody(req));
  const message = findMessage(decodeURIComponent(match[1] ?? ""));
  const body = message?.body;
  if (message === null || body === undefined || body.kind !== "routine_offer") {
    send(res, 404, { error: "没有这个对象" });
    return true;
  }
  if (!parsed.success) send(res, 400, { error: "decision 只能是 add 或 dismiss" });
  else if (body.status !== "offered") send(res, 409, { error: "这条卡已经有结论了" });
  else if (parsed.data.decision === "dismiss") {
    const next = writeMessageBody(message.id, { ...body, status: "dismissed" });
    if (next !== null) push({ type: "message", message: next });
    send(res, 200, { message: next, routine: null });
  } else if (!bots.has(body.executorBotId)) send(res, 404, { error: "执行这条例行的 Bot 已经不在了" });
  // 照控制面：挂了项目的卡，执行者得还在那个群里；群没了也算不在。
  else if (body.groupId !== null && groups.get(body.groupId)?.botIds.includes(body.executorBotId) !== true)
    send(res, 400, { error: "执行者不在那个项目群里" });
  else {
    const routine = createRoutine(body.executorBotId, {
      name: body.name,
      instruction: body.instruction,
      triggers: [{ kind: "cron", expr: body.cron }],
      onFailure: "stop_and_tell",
      groupId: body.groupId,
      purpose: body.purpose,
      state: "on",
      boundary: body.boundary,
      onToday: body.onToday,
    });
    const next = writeMessageBody(message.id, { ...body, status: "added", routineId: routine.id });
    if (next !== null) push({ type: "message", message: next });
    push({ type: "routine_updated", routine });
    send(res, 200, { message: next, routine });
  }
  return true;
};
