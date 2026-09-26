import { AgentToControl, type ControlToAgent, Platform } from "@baize/shared";
import { type Static, Type } from "typebox";
import type { z } from "zod";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

// 主助理（role = assistant）比队员多的东西：系统提示里一段规则、prompt 里一段项目清单、两件工具。
// 两件工具都不走审批：用户当面说的话就是他的决定，再弹一张确认卡是多问一遍。

/** 队员的工具连接也不能占这两个名字：闸门按名字把它们归成内部工具直接放行。 */
export const ASSISTANT_TOOL_NAMES = ["set_cadence", "propose_project"] as const;

export type Project = NonNullable<Extract<ControlToAgent, { type: "prompt" }>["projects"]>[number];

/** 人设那一句还没定稿，先用中性的默认文案，定了直接换这里。 */
export const ASSISTANT_RULE =
  "你是这个人的主助理，替这个人管着所有项目。用户说的每句话，先判断归谁：自己能办的直接办；" +
  "属于某个项目的活，说清交给哪个项目、去哪个群看；要改某个项目的节奏（多久做一次、一次做多少），" +
  "调 set_cadence 改那个项目，别口头答应，改完在回复里说清下次在哪里看到结果。" +
  "用户想做成一件新的事，调 propose_project 出一张方案卡，发出去就等用户点开始，别自己接着建。" +
  "每条消息里的「你管的项目」就是你手上的全部项目。";

/** 清单是空的也出这一段：主助理得知道自己手上没项目，不然会拿猜的 id 去调 set_cadence。 */
export function renderProjects(projects: readonly Project[]): string {
  const lines =
    projects.length === 0
      ? ["（空）"]
      : projects.map(
          (project) =>
            `- ${project.title}（projectGroupId：${project.groupId}）节奏：${project.cadence === "" ? "未定" : project.cadence}`,
        );
  return ["你管的项目：", ...lines].join("\n");
}

const SET_CADENCE_PARAMS = Type.Object({ projectGroupId: Type.String(), cadence: Type.String() });

// 长度范围不写进 schema，理由同 propose_skill：交给 AgentToControl 校验，再把 issue 翻成中文。
const PROPOSE_PROJECT_PARAMS = Type.Object({
  name: Type.String(),
  goal: Type.String(),
  team: Type.Array(Type.Object({ name: Type.String(), tag: Type.Optional(Type.String()), description: Type.String() })),
  platforms: Type.Array(
    Type.Union([
      Type.Object({
        kind: Type.Literal("supported"),
        platform: Type.Union(Platform.options.map((platform) => Type.Literal(platform))),
      }),
      Type.Object({ kind: Type.Literal("unsupported"), name: Type.String() }),
    ]),
  ),
  cadence: Type.String(),
  firstStep: Type.String(),
});

const issueText = (issue: z.ZodIssue): string => {
  const at = issue.path.join(".");
  const unit = "type" in issue && issue.type === "array" ? "条" : "个字";
  if (issue.code === "too_small") return `${at} 至少要 ${issue.minimum} ${unit}`;
  if (issue.code === "too_big") return `${at} 最多 ${issue.maximum} ${unit}`;
  return `${at}：${issue.message}`;
};

/** 过协议 schema，不合格就抛一句中文，模型照着改完再调。 */
export function parseOrThrow(message: AgentToControl, what: string): AgentToControl {
  const parsed = AgentToControl.safeParse(message);
  if (!parsed.success) throw new Error(`${what}没发出去，改好再调：${parsed.error.issues.map(issueText).join("；")}`);
  return parsed.data;
}

export const resultText = (body: string): Awaited<ReturnType<RunnerTool["execute"]>> => ({
  content: [{ type: "text", text: body }],
  details: {},
});

export function createAssistantTools(options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  const activeOrThrow = (action: string): ActiveRun => {
    const active = options.activeRun();
    if (active === null) throw new Error(`这次工具调用不属于任何一次运行，没法${action}。`);
    return active;
  };

  return [
    {
      name: "set_cadence",
      label: "改节奏",
      description:
        "改一个项目的节奏：多久做一次、一次做多少。projectGroupId 照「你管的项目」里写的抄，cadence 写改完的完整节奏，比如「每周 3 篇小红书」。",
      parameters: SET_CADENCE_PARAMS,
      execute: async (_callId, params) => {
        const active = activeOrThrow("改节奏");
        const { projectGroupId, cadence } = params as Static<typeof SET_CADENCE_PARAMS>;
        if (cadence.trim() === "") throw new Error("节奏没发出去，改好再调：cadence 是空的，写改完的完整节奏。");
        const project = active.projects.find((candidate) => candidate.groupId === projectGroupId);
        if (project === undefined) {
          const hint =
            active.projects.length === 0
              ? "你手上还没有项目。"
              : `能改的是：${active.projects.map((candidate) => `${candidate.title}（projectGroupId：${candidate.groupId}）`).join("、")}`;
          throw new Error(`没有 projectGroupId 是「${projectGroupId}」的项目。${hint}`);
        }
        options.send(
          parseOrThrow(
            {
              type: "set_cadence",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              projectGroupId: project.groupId,
              cadence,
            },
            "节奏",
          ),
        );
        return resultText(
          `「${project.title}」的节奏改成了「${cadence}」。回复用户时说清楚下次在哪里看到结果，比如哪天的计划里。`,
        );
      },
    },
    {
      name: "propose_project",
      label: "出方案卡",
      description:
        "用户想做成一件新的事时，出一张项目方案卡给用户看：名字、目标、队员（1 到 5 个）、平台、节奏、第一步。" +
        "平台里 github、x、xiaohongshu 写成 supported，抖音这类还不支持的写成 unsupported 并写上名字。发出去之后等用户点开始。只能在你和用户的单聊里用，项目群里调会报错。",
      parameters: PROPOSE_PROJECT_PARAMS,
      execute: async (_callId, params) => {
        const active = activeOrThrow("出方案卡");
        // 控制面只收主助理单聊里的方案卡，别的群发来的静默丢掉；不在这里拦，模型会以为发出去了。
        if (active.groupKind !== "solo") {
          throw new Error(
            "方案卡只能在你和用户的单聊里出，这里是项目群，没发出去。在这里把想法说给用户听，请用户回单聊找你出方案卡。",
          );
        }
        const { name, goal, team, platforms, cadence, firstStep } = params as Static<typeof PROPOSE_PROJECT_PARAMS>;
        // 协议允许空串，但 P1-9 拿这一句建队员 Bot，空了建出来的 Bot 就没有边界。
        const blank = team.find((member) => member.description.trim() === "");
        if (blank !== undefined) {
          throw new Error(
            `方案卡没发出去，改好再调：队员「${blank.name}」的 description 是空的，写一句他干什么、不干什么。`,
          );
        }
        // 协议里队员和平台都是 strict 对象，模型多写一个键就整条被拒，所以在这里只挑协议要的字段。
        options.send(
          parseOrThrow(
            {
              type: "project_offer",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              name,
              goal,
              team: team.map((member) => ({
                name: member.name,
                tag: member.tag ?? "",
                description: member.description,
              })),
              platforms: platforms.map((platform) =>
                platform.kind === "supported"
                  ? { kind: "supported", platform: platform.platform }
                  : { kind: "unsupported", name: platform.name },
              ),
              cadence,
              firstStep,
            },
            "方案卡",
          ),
        );
        return resultText(`方案卡「${name}」已经发到群里，等用户点开始。别自己接着建项目或拉队员。`);
      },
    },
  ];
}
