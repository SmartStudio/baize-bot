import { randomBytes } from "node:crypto";
import {
  Routine,
  RoutineId,
  type CreateRoutineRequest,
  type Message,
  type TriggerInput,
  type UpdateRoutineRequest,
} from "@baize/shared";
import { appendMessage } from "./messages.js";
import { groupIdByBotId, nextSuffix, routines } from "./store.js";

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
    enabled: input.enabled,
    runs: [],
  });
  routines.set(routine.id, routine);
  return routine;
};

export const writeRoutine = (id: string, patch: UpdateRoutineRequest): Routine | null => {
  const routine = routines.get(id);
  if (routine === undefined) return null;
  const triggers = patch.triggers === undefined ? routine.triggers : tokensFrom(routine.triggers, patch.triggers);
  const next = Routine.parse({ ...routine, ...patch, triggers });
  routines.set(next.id, next);
  return next;
};

export const runRoutine = (id: string): { routine: Routine; messages: Message[] } | null => {
  const routine = routines.get(id);
  if (routine === undefined) return null;
  const groupId = groupIdByBotId.get(routine.botId);
  if (groupId === undefined) return null;
  const messages = [
    appendMessage(groupId, { kind: "system", text: `例行任务「${routine.name}」自动运行` }),
    appendMessage(groupId, { kind: "user", text: routine.instruction }),
  ];
  const runs = [{ startedAt: new Date().toISOString(), status: "running", note: "" }, ...routine.runs].slice(
    0,
    RUN_CAP,
  );
  const next = Routine.parse({ ...routine, runs });
  routines.set(next.id, next);
  return { routine: next, messages };
};
