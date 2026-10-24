import { CreateRoutineRequest, UpdateRoutineRequest, type Routine } from "@baize/shared";
import {
  bots,
  createRoutine,
  groups,
  routineByToken,
  routines,
  routinesOf,
  runRoutine,
  settleRoutineRun,
  streamBotReply,
  writeRoutine,
} from "../state.js";
import { defined, readBody, send, type Push, type Route } from "./http.js";

export const fireRoutine = (routineId: string, push: Push): Routine | null => {
  const ran = runRoutine(routineId);
  if (ran === null) return null;
  push({ type: "routine_updated", routine: ran.routine });
  for (const message of ran.messages) push({ type: "message", message });
  const { botId, id, instruction, runs } = ran.routine;
  const startedAt = runs[0]?.startedAt;
  const settle = (outcome: "done" | "held") => {
    const settled = startedAt === undefined ? null : settleRoutineRun(id, startedAt, outcome);
    if (settled !== null) push({ type: "routine_updated", routine: settled });
  };
  void streamBotReply(ran.groupId, botId, instruction, push, () => settle("held"))
    .then(() => settle("done"))
    .catch((cause: unknown) => {
      process.stderr.write(`mock 例行回复跑挂了：${String(cause)}\n`);
    });
  return ran.routine;
};

export const hookRoutes: Route = async ({ res, path, method, push }) => {
  const match = /^\/api\/hooks\/([^/]+)$/.exec(path);
  if (match === null || method !== "POST") return false;
  const rawToken = match[1];
  const routine = routineByToken(rawToken === undefined ? "" : decodeURIComponent(rawToken));
  if (routine === null) send(res, 404, { error: "没有这个 webhook" });
  else if (routine.state !== "on") send(res, 409, { error: "这条例行任务停用了" });
  else send(res, fireRoutine(routine.id, push) === null ? 404 : 202);
  return true;
};

export const routineRoutes: Route = async ({ req, res, path, method, push }) => {
  if (path === "/api/routines" && method === "GET") {
    send(res, 200, { items: [...routines.values()] });
    return true;
  }
  const botMatch = /^\/api\/bots\/([^/]+)\/routines$/.exec(path);
  if (botMatch !== null) {
    const rawBotId = botMatch[1];
    const botId = rawBotId === undefined ? "" : decodeURIComponent(rawBotId);
    if (!bots.has(botId)) send(res, 404, { error: "没有这个 Bot" });
    else if (method === "GET") send(res, 200, { items: routinesOf(botId) });
    else if (method === "POST") {
      const parsed = CreateRoutineRequest.safeParse(await readBody(req));
      if (!parsed.success) send(res, 400, { error: "例行任务字段不对" });
      else {
        const routine = createRoutine(botId, parsed.data);
        push({ type: "routine_updated", routine });
        send(res, 201, { routine });
      }
    } else return false;
    return true;
  }

  const runMatch = /^\/api\/routines\/([^/]+)\/run$/.exec(path);
  if (runMatch !== null && method === "POST") {
    const rawRoutineId = runMatch[1];
    const ran = fireRoutine(rawRoutineId === undefined ? "" : decodeURIComponent(rawRoutineId), push);
    if (ran === null) send(res, 404, { error: "没有这条例行任务" });
    else send(res, 202, { routine: ran });
    return true;
  }

  const match = /^\/api\/routines\/([^/]+)$/.exec(path);
  if (match === null) return false;
  const rawRoutineId = match[1];
  const routineId = rawRoutineId === undefined ? "" : decodeURIComponent(rawRoutineId);
  const routine = routines.get(routineId);
  if (routine === undefined) send(res, 404, { error: "没有这条例行任务" });
  else if (method === "PATCH") {
    const parsed = UpdateRoutineRequest.safeParse(await readBody(req));
    const executor = parsed.success ? parsed.data.executorBotId : undefined;
    const bot = executor === undefined ? undefined : bots.get(executor);
    const project = routine.groupId === null ? undefined : groups.get(routine.groupId);
    if (!parsed.success) send(res, 400, { error: "例行任务字段不对" });
    else if (executor !== undefined && bot === undefined) send(res, 404, { error: "没有这个 Bot" });
    else if (bot !== undefined && (bot.role === "player" || bot.role === "host"))
      send(res, 400, { error: "牌友和老白不能执行例行任务" });
    else if (executor !== undefined && project?.kind === "team" && !project.botIds.includes(executor))
      send(res, 400, { error: "这个 Bot 不在例行任务的项目群里" });
    else {
      const next = writeRoutine(routineId, defined(parsed.data));
      if (next === null) send(res, 404, { error: "没有这条例行任务" });
      else {
        push({ type: "routine_updated", routine: next });
        send(res, 200, { routine: next });
      }
    }
  } else if (method === "DELETE") {
    routines.delete(routineId);
    push({ type: "routine_deleted", routineId: routine.id, botId: routine.botId });
    send(res, 204);
  } else return false;
  return true;
};
