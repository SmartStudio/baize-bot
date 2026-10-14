import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentToControl, type RunId, type Skill } from "@baize/shared";
import { type Static, Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

// skill 的真相源是控制面的 skills 表，方向只有一个：config 下发，运行器落盘。运行器不往回同步文件。
// 两个方向都能写的文件没有真相源，用户在 Web 改的步骤和 Bot 刚存的文件谁覆盖谁说不清。

/** 系统提示里那句提议存 skill 的规则。放在 Bot 描述之后，`appendSystemPrompt` 的最后一段。 */
export const PROPOSE_SKILL_RULE =
  "存下会做的活：一件活要是用了三次以上工具才做完，收尾时用 propose_skill 把刚才的步骤写成清单，问用户存不存。" +
  "一次运行最多提一次，用户不答也别再提。";

// 和 protocol.ts 里 `skill_offer` 的 schema 对齐：这里挡不住的会在 AgentToControl.parse 变成一坨英文 ZodError。
const NAME_MAX = 40;
const STEPS_MIN = 2;
const STEPS_MAX = 20;
const STEP_CHARS_MAX = 500;

/** JSON 字符串就是合法的 YAML 双引号标量。名字里的冒号、井号、引号全靠它挡住，frontmatter 才不会崩。 */
const yamlString = (value: string): string => JSON.stringify(value);

/**
 * 一条 skill 的 SKILL.md。frontmatter 的 description 用第一步：Pi 把没有 description 的文件整条丢掉
 * （`core/skills.js` 的 `loadSkillFromFile`），所以步骤为空时回落到名字，不能留空。
 */
function renderSkillFile(skill: Skill): string {
  const description = skill.steps[0] ?? skill.name;
  const body = skill.steps.length === 0 ? ["（还没写步骤）"] : skill.steps.map((step, i) => `${i + 1}. ${step}`);
  return [
    "---",
    `name: ${yamlString(skill.name)}`,
    `description: ${yamlString(description)}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    ...body,
    "",
  ].join("\n");
}

const readIfExists = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * skillId 直接拿来当目录名，而 shared 的 `SkillId` 只保证非空字符串。带路径分隔符或 `..` 的 id
 * 会把 SKILL.md 写到 dataDir 外面，所以在这道边界上挡掉：这种 id 不落盘。
 */
const isSafeDirName = (id: string): boolean => id !== "." && id !== ".." && !/[/\\]/.test(id);

/**
 * 把一个 Bot 的 skill 列表对到盘上：多的删、少的加、变了的重写。目录名就是 skillId。
 * 内容一样的不动，重跑同一份列表不改任何文件的 mtime。
 */
export function reconcileSkillDir(skillsDir: string, skills: readonly Skill[]): void {
  mkdirSync(skillsDir, { recursive: true });
  const wanted = new Map<string, string>(
    skills.filter((skill) => isSafeDirName(skill.id)).map((skill) => [skill.id, renderSkillFile(skill)]),
  );

  for (const entry of readdirSync(skillsDir)) {
    if (wanted.has(entry)) continue;
    rmSync(join(skillsDir, entry), { recursive: true, force: true });
  }

  for (const [id, content] of wanted) {
    const file = join(skillsDir, id, "SKILL.md");
    if (readIfExists(file) === content) continue;
    // 要写的位置上可能是个普通文件或者 SKILL.md 是个目录，直接写会 EEXIST/EISDIR 把整个 createRunner 炸掉。
    // 先清掉再建，对账就能从盘上任何一种状态收敛过来。
    rmSync(join(skillsDir, id), { recursive: true, force: true });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
}

// 范围不写进 schema：Pi 拿 schema 挡下的参数，模型收到的是一条英文 Validation 报错，看不出该写几条。
// 交给下面的检查统一报，给的是能照着改的中文。
const PROPOSE_PARAMS = Type.Object({ name: Type.String(), steps: Type.Array(Type.String()) });

export function createSkillTools(options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  // 一个 Bot 的运行是串行的，手里最多一次运行，记住刚提过的那个 runId 就够，不用攒一张表。
  let offeredRunId: RunId | null = null;

  return [
    {
      name: "propose_skill",
      label: "问要不要存",
      description:
        "把刚做完的这件活的步骤写成清单，问用户存不存成会做的活。名字写这件活叫什么，步骤按先后写，至少两步。一次运行只能问一次。",
      parameters: PROPOSE_PARAMS,
      execute: async (_callId, params) => {
        const active = options.activeRun();
        if (active === null) throw new Error("这次工具调用不属于任何一次运行，没法问要不要存。");
        if (offeredRunId === active.run.runId) throw new Error("这次已经问过了。");

        const { name, steps } = params as Static<typeof PROPOSE_PARAMS>;
        if (name.length < 1 || name.length > NAME_MAX) {
          throw new Error(`名字要 1 到 ${NAME_MAX} 个字，这个有 ${name.length} 个。`);
        }
        if (steps.length < STEPS_MIN || steps.length > STEPS_MAX) {
          throw new Error(`步骤要 ${STEPS_MIN} 到 ${STEPS_MAX} 条，这次给了 ${steps.length} 条。`);
        }
        const blank = steps.findIndex((step) => step.trim() === "");
        if (blank !== -1) throw new Error(`第 ${blank + 1} 步是空的，每一步都要写上做什么。`);
        const long = steps.findIndex((step) => step.length > STEP_CHARS_MAX);
        if (long !== -1) {
          throw new Error(`第 ${long + 1} 步有 ${steps[long]?.length} 个字，每步最多 ${STEP_CHARS_MAX} 个，写短点。`);
        }

        options.send(
          AgentToControl.parse({
            type: "skill_offer",
            runId: active.run.runId,
            botId: active.run.botId,
            groupId: active.run.groupId,
            name,
            steps,
          }),
        );
        // 报文真发出去了才算问过。parse 挂在这一步的话，模型改好参数还能再问一次。
        offeredRunId = active.run.runId;
        return { content: [{ type: "text", text: `已经在群里问用户存不存「${name}」了，等用户点。` }], details: {} };
      },
    },
  ];
}
