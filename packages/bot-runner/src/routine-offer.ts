import { type AgentToControl, BotId, ModelPurpose, RoutineBoundary } from "@baize/shared";
import { type Static, Type } from "typebox";
import { parseOrThrow, resultText } from "./assistant.js";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

// 长度范围不写进 schema，理由同 propose_team：交给 AgentToControl 校验，再把 issue 翻成中文。
const PROPOSE_ROUTINE_PARAMS = Type.Object({
  name: Type.String(),
  instruction: Type.String(),
  cron: Type.String(),
  boundary: Type.Union(RoutineBoundary.options.map((boundary) => Type.Literal(boundary))),
  projectGroupId: Type.Optional(Type.String()),
  executorBotId: Type.Optional(Type.String()),
  purpose: Type.Optional(Type.Union(ModelPurpose.options.map((purpose) => Type.Literal(purpose)))),
  onToday: Type.Optional(Type.Boolean()),
});

const BOUNDARY_LABELS: Readonly<Record<RoutineBoundary, string>> = {
  read_only: "只读",
  draft: "草稿等你批",
};

const CRON_FIELDS = 5;

/** 控制面用 croner 校验 cron，运行器没有它，这里只拦段数不对的：那种卡点了「加上」也建不出例行。 */
const cronOf = (raw: string): string => {
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== CRON_FIELDS) {
    throw new Error(
      `例行卡没发出去，改好再调：cron 要写 ${CRON_FIELDS} 段（分 时 日 月 周），比如每周五 18:00 写 0 18 * * 5，你写的是「${raw}」。`,
    );
  }
  return fields.join(" ");
};

/** 没指定项目时，在项目群里说的就是这个项目；单聊里说的是日常例行，不挂项目。 */
const projectOf = (active: ActiveRun, requested: string | undefined): ActiveRun["projects"][number] | null => {
  const wanted = requested ?? active.run.groupId;
  const project = active.projects.find((candidate) => candidate.groupId === wanted);
  if (project !== undefined || requested === undefined) return project ?? null;
  const hint =
    active.projects.length === 0
      ? "你手上还没有项目。"
      : `能挂的是：${active.projects.map((candidate) => `${candidate.title}（projectGroupId：${candidate.groupId}）`).join("、")}`;
  throw new Error(`没有 projectGroupId 是「${requested}」的项目。${hint}`);
};

/**
 * 不写执行者就是主助理自己。只有卡挂在当前这个项目群上时，成员名单才等于执行者的候选范围，才能在这里核对；
 * 其余情况（单聊里看不到别的 Bot，或者挂在别的项目上）核对留给控制面，它在点「加上」时按目标项目群的成员查。
 */
const executorOf = (active: ActiveRun, project: ReturnType<typeof projectOf>, requested: string | undefined): BotId => {
  if (requested === undefined) return active.run.botId;
  const parsed = BotId.safeParse(requested.trim());
  if (!parsed.success) throw new Error("例行卡没发出去，改好再调：executorBotId 是空的，不写就是你自己来做。");
  const inThisGroup = project !== null && project.groupId === active.run.groupId;
  if (inThisGroup && !active.members.some((member) => member.id === parsed.data)) {
    const roster = active.members.map((member) => `${member.name}（botId：${member.id}）`).join("、");
    throw new Error(`没有 botId 是「${parsed.data}」的成员。能当执行者的是：${roster}`);
  }
  return parsed.data;
};

/** 主助理专属，index.ts 只在 role = assistant 时挂它；队员的工具列表里不能出现 propose_routine。 */
export function createRoutineOfferTools(options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  return [
    {
      name: "propose_routine",
      label: "出例行卡",
      description:
        "用户想让某件事按时自己做（每周五出周报、每天早上读一遍消息）时，出一张例行卡给用户看，用户点「加上」才建例行。" +
        "name 是例行的名字，instruction 写每次到点要做的事，写到换一个人读也能照做。" +
        "cron 写 5 段（分 时 日 月 周），比如每周五 18:00 写 0 18 * * 5。" +
        "boundary 写 read_only 是只读：只读取和汇报，不起草、不发布、不联系人、不在网页上点填；" +
        "写 draft 是草稿等你批：可以起草，用户批了才发。能只读就别写 draft。" +
        "projectGroupId 照「你管的项目」里写的抄，是这条例行挂在哪个项目；在项目群里提议可以不写，就是这个项目，" +
        "在单聊里不写就是不挂项目的日常例行，结果发到执行者的单聊。" +
        "executorBotId 是谁来做，不写就是你自己。" +
        "purpose 写 fast 是读数、巡检这类轻活，不写就是 plan。onToday 写 true 是把这条放上首页，不写就不放。" +
        "发出去之后等用户点「加上」，别自己建例行，也别再出第二张。",
      parameters: PROPOSE_ROUTINE_PARAMS,
      execute: async (_callId, params) => {
        const active = options.activeRun();
        if (active === null) throw new Error("这次工具调用不属于任何一次运行，没法出例行卡。");
        const input = params as Static<typeof PROPOSE_ROUTINE_PARAMS>;
        const cron = cronOf(input.cron);
        const project = projectOf(active, input.projectGroupId);
        const executorBotId = executorOf(active, project, input.executorBotId);
        const name = input.name.trim();
        options.send(
          parseOrThrow(
            {
              type: "routine_offer",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              name,
              instruction: input.instruction.trim(),
              cron,
              executorBotId,
              boundary: input.boundary,
              purpose: input.purpose ?? "plan",
              onToday: input.onToday ?? false,
              projectGroupId: project?.groupId ?? null,
            },
            "例行卡",
          ),
        );
        const where = project === null ? "不挂项目，结果发到执行者的单聊" : `挂在项目「${project.title}」下`;
        const who =
          executorBotId === active.run.botId
            ? "你自己"
            : (active.members.find((member) => member.id === executorBotId)?.name ?? executorBotId);
        return resultText(
          `例行卡已经发出去：「${name}」${where}，由${who}执行，边界是${BOUNDARY_LABELS[input.boundary]}，等用户点「加上」。别自己建例行，也别再出第二张。`,
        );
      },
    },
  ];
}
