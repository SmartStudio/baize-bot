import { type AgentToControl, BotId, type TeamOfferMember } from "@baize/shared";
import { type Static, Type } from "typebox";
import { parseOrThrow, resultText } from "./assistant.js";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

/** 项目群连主助理最多 6 个 Bot，主助理自己占一个，一张卡最多再请 5 个，与协议上限一致。 */
export const MAX_TEAM_OFFER_MEMBERS = 5;

// 长度范围不写进 schema，理由同 propose_project：交给 AgentToControl 校验，再把 issue 翻成中文。
const PROPOSE_TEAM_PARAMS = Type.Object({
  projectGroupId: Type.String(),
  members: Type.Array(
    Type.Union([
      Type.Object({
        kind: Type.Literal("existing"),
        botId: Type.String(),
        note: Type.String(),
        suggested: Type.Optional(Type.Boolean()),
      }),
      Type.Object({
        kind: Type.Literal("new"),
        name: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
        description: Type.String(),
        note: Type.String(),
        suggested: Type.Optional(Type.Boolean()),
      }),
    ]),
  ),
});

type Candidate = Static<typeof PROPOSE_TEAM_PARAMS>["members"][number];

const botIdOf = (raw: string): BotId => {
  const parsed = BotId.safeParse(raw);
  if (!parsed.success) throw new Error("建队卡没发出去，改好再调：existing 人选的 botId 是空的。");
  return parsed.data;
};

/** 协议里人选是 strict 对象，模型多写一个键就整条被拒，所以只挑协议要的字段。 */
const toOfferMember = (candidate: Candidate): TeamOfferMember =>
  candidate.kind === "existing"
    ? {
        kind: "existing",
        botId: botIdOf(candidate.botId),
        note: candidate.note,
        suggested: candidate.suggested ?? false,
      }
    : {
        kind: "new",
        name: candidate.name,
        tags: candidate.tags ?? [],
        description: candidate.description,
        note: candidate.note,
        suggested: candidate.suggested ?? false,
      };

/** 主助理专属，index.ts 只在 role = assistant 时挂它；队员的工具列表里不能出现 propose_team。 */
export function createTeamTools(options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  return [
    {
      name: "propose_team",
      label: "出建队卡",
      description:
        "项目缺人时，出一张建队卡给用户看：往哪个项目群加谁。projectGroupId 照「你管的项目」里写的抄。" +
        `members 是人选，最多 ${MAX_TEAM_OFFER_MEMBERS} 个：kind 写 existing 是已有的 Bot（给 botId），` +
        "写 new 是要新请的（给 name、tags、description，description 写一句他干什么、不干什么）。" +
        "每个人选的 note 写一句为什么要他；suggested 写 true 是可有可无的建议人选，卡上默认不勾，用户点「加上」才算，" +
        "不写或写 false 是你认为该有的。卡上只问用户要不要这个人，不问权限和模型。" +
        "发出去之后等用户确认，别自己拉人。只能在你和用户的单聊里用，项目群里调会报错。",
      parameters: PROPOSE_TEAM_PARAMS,
      execute: async (_callId, params) => {
        const active = options.activeRun();
        if (active === null) throw new Error("这次工具调用不属于任何一次运行，没法出建队卡。");
        // 控制面只收主助理单聊里的建队卡，别的群发来的静默丢掉；不在这里拦，模型会以为发出去了。
        if (active.groupKind !== "solo") {
          throw new Error(
            "建队卡只能在你和用户的单聊里出，这里是项目群，没发出去。在这里把想法说给用户听，请用户回单聊找你出建队卡。",
          );
        }
        const { projectGroupId, members } = params as Static<typeof PROPOSE_TEAM_PARAMS>;
        const project = active.projects.find((candidate) => candidate.groupId === projectGroupId);
        if (project === undefined) {
          const hint =
            active.projects.length === 0
              ? "你手上还没有项目。"
              : `能加人的是：${active.projects.map((candidate) => `${candidate.title}（projectGroupId：${candidate.groupId}）`).join("、")}`;
          throw new Error(`没有 projectGroupId 是「${projectGroupId}」的项目。${hint}`);
        }
        if (members.length > MAX_TEAM_OFFER_MEMBERS) {
          throw new Error(
            `建队卡没发出去，改好再调：成员最多 ${MAX_TEAM_OFFER_MEMBERS} 个（项目群连主助理最多 6 个 Bot），现在有 ${members.length} 个。`,
          );
        }
        // 协议允许空串，但确认时拿这一句建新 Bot，空了建出来的 Bot 就没有边界。
        const blank = members.find((candidate) => candidate.kind === "new" && candidate.description.trim() === "");
        if (blank?.kind === "new") {
          throw new Error(
            `建队卡没发出去，改好再调：新人「${blank.name}」的 description 是空的，写一句他干什么、不干什么。`,
          );
        }
        options.send(
          parseOrThrow(
            {
              type: "team_offer",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              projectGroupId: project.groupId,
              members: members.map(toOfferMember),
            },
            "建队卡",
          ),
        );
        return resultText(
          `建队卡已经发到单聊里（给「${project.title}」加 ${members.length} 个人选），等用户确认。别自己拉人进群，也别再出第二张。`,
        );
      },
    },
  ];
}
