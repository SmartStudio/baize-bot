import { randomBytes } from "node:crypto";
import {
  Routine,
  RoutineId,
  type RoutineRun,
  type CreateRoutineRequest,
  type Message,
  type TriggerInput,
  type UpdateRoutineRequest,
} from "@baize/shared";
import { appendMessage } from "./messages.js";
import { groupIdByBotId, groups, nextSuffix, routines } from "./store.js";

export const routinesOf = (botId: string): Routine[] =>
  [...routines.values()].filter((routine) => routine.botId === botId);

export const routineByToken = (token: string): Routine | null =>
  [...routines.values()].find((routine) =>
    routine.triggers.some((trigger) => trigger.kind === "webhook" && trigger.token === token),
  ) ?? null;

const RUN_CAP = 20;

const tokensFrom = (previous: Routine["triggers"], inputs: TriggerInput[]): Routine["triggers"] => {
  const mine = new Set(previous.filter((trigger) => trigger.kind === "webhook").map((trigger) => trigger.token));
  return inputs.map((input) =>
    input.kind === "cron"
      ? { kind: "cron", expr: input.expr }
      : {
          kind: "webhook",
          token: input.token !== undefined && mine.has(input.token) ? input.token : randomBytes(16).toString("hex"),
        },
  );
};

export const createRoutine = (botId: string, input: CreateRoutineRequest): Routine => {
  const routine = Routine.parse({
    id: RoutineId.parse(`rtn_new_${nextSuffix()}`),
    botId,
    name: input.name,
    instruction: input.instruction,
    triggers: tokensFrom([], input.triggers),
    onFailure: input.onFailure,
    groupId: input.groupId ?? null,
    purpose: input.purpose ?? "plan",
    state: input.state,
    boundary: input.boundary,
    onToday: input.onToday,
    runs: [],
  });
  routines.set(routine.id, routine);
  return routine;
};

export const writeRoutine = (id: string, patch: UpdateRoutineRequest): Routine | null => {
  const routine = routines.get(id);
  if (routine === undefined) return null;
  const { executorBotId, ...fields } = patch;
  const triggers = patch.triggers === undefined ? routine.triggers : tokensFrom(routine.triggers, patch.triggers);
  const moved =
    executorBotId === undefined || executorBotId === routine.botId
      ? {}
      : {
          botId: executorBotId,
          groupId: routine.groupId !== null && groups.get(routine.groupId)?.kind === "team" ? routine.groupId : null,
        };
  const next = Routine.parse({ ...routine, ...fields, ...moved, triggers });
  routines.set(next.id, next);
  return next;
};

export const runRoutine = (id: string): { routine: Routine; groupId: string; messages: Message[] } | null => {
  const routine = routines.get(id);
  if (routine === undefined) return null;
  // 和控制面一样：挂了项目群的发进项目群，不挂的发进这个 Bot 的单 Bot 群。
  const groupId = routine.groupId ?? groupIdByBotId.get(routine.botId);
  if (groupId === undefined) return null;
  const messages = [
    appendMessage(groupId, { kind: "user", text: routine.instruction, routine: { name: routine.name } }),
  ];
  const runs = [
    { startedAt: new Date().toISOString(), status: "running", note: "", seenAt: null },
    ...routine.runs,
  ].slice(0, RUN_CAP);
  const next = Routine.parse({ ...routine, runs });
  routines.set(next.id, next);
  return { routine: next, groupId, messages };
};

// 照控制面收尾：跑完记完成；中途出审批时 stop_and_tell 就地停下，retry_next_time 只补一句话接着挂。
// 按开跑时刻认是哪一次，已经收过尾或者重置之后对不上就不动。
export const settleRoutineRun = (id: string, startedAt: string, outcome: "done" | "held"): Routine | null => {
  const routine = routines.get(id);
  if (routine === undefined || !routine.runs.some((run) => run.startedAt === startedAt && run.status === "running"))
    return null;
  const settled = (run: RoutineRun): RoutineRun => {
    if (outcome === "done") return { ...run, status: "ok" };
    return routine.onFailure === "stop_and_tell"
      ? { ...run, status: "stopped", note: "1 条等你点头" }
      : { ...run, note: "等你点头，下次照常跑" };
  };
  const runs = routine.runs.map((run) => (run.startedAt === startedAt ? settled(run) : run));
  const next = Routine.parse({ ...routine, runs });
  routines.set(next.id, next);
  return next;
};
