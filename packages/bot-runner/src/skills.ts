import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentToControl, SkillOrigin, type RunId, type Skill, type SkillChange } from "@baize/shared";
import { type Static, Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

// skill 的真相源是控制面的 skills 表，方向只有一个：config 下发，运行器落盘。运行器不往回同步文件。
// 两个方向都能写的文件没有真相源，用户在卡上点定的步骤和 Bot 自己写的文件谁覆盖谁说不清。

/** 系统提示里那段管 skill 的规则。放在 Bot 描述之后，`appendSystemPrompt` 的最后一段。 */
export const PROPOSE_SKILL_RULE =
  "会做的活：只有两种时候用 propose_skill 把刚才的步骤写成清单问用户存不存，" +
  "一是群里看得到用户以前就让你做过同一类活，这次又要；二是用户明说了「以后也这样做」。" +
  "只做一次的活不问，用了多少工具都不问。" +
  "用户要你学会某类活或去装个 skill 时，先找现成公开的 SKILL.md（比如 GitHub 上的 anthropics/skills），读完改写成中文步骤，用 propose_skill 带上 source 原链接。" +
  "用户要改或删已有的 skill 时，用 propose_skill_edit 或 propose_skill_removal。" +
  "同一个 skill 一次运行只问一次，用户不答也别再提。" +
  "skill 只有用户在卡上点了才生效，不要自己往 skills 目录写文件。";

// 和 shared 里 `SkillChange` 的 schema 对齐：这里挡不住的会在 AgentToControl.parse 变成一坨英文 ZodError。
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
  const origin = skill.origin === null ? [] : ["", `来源：${skill.origin}`];
  return [
    "---",
    `name: ${yamlString(skill.name)}`,
    `description: ${yamlString(description)}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    ...body,
    ...origin,
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
const PROPOSE_PARAMS = Type.Object({
  name: Type.String({ description: "这件活叫什么" }),
  steps: Type.Array(Type.String(), { description: "按先后写的步骤，至少两步" }),
  source: Type.Optional(Type.String({ description: "从公开仓库装时填那份 SKILL.md 的原链接，自己总结的不填" })),
});
const EDIT_PARAMS = Type.Object({
  skill: Type.String({ description: "要改的 skill 现在的名字" }),
  name: Type.Optional(Type.String({ description: "改名才填新名字" })),
  steps: Type.Array(Type.String(), { description: "改完的整份步骤，至少两步" }),
});
const REMOVAL_PARAMS = Type.Object({ skill: Type.String({ description: "要删的 skill 现在的名字" }) });

function checkName(name: string): void {
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new Error(`名字要 1 到 ${NAME_MAX} 个字，这个有 ${name.length} 个。`);
  }
}

function checkSteps(steps: readonly string[]): void {
  if (steps.length < STEPS_MIN || steps.length > STEPS_MAX) {
    throw new Error(`步骤要 ${STEPS_MIN} 到 ${STEPS_MAX} 条，这次给了 ${steps.length} 条。`);
  }
  const blank = steps.findIndex((step) => step.trim() === "");
  if (blank !== -1) throw new Error(`第 ${blank + 1} 步是空的，每一步都要写上做什么。`);
  const long = steps.findIndex((step) => step.length > STEP_CHARS_MAX);
  if (long !== -1) {
    throw new Error(`第 ${long + 1} 步有 ${steps[long]?.length} 个字，每步最多 ${STEP_CHARS_MAX} 个，写短点。`);
  }
}

function checkOrigin(source: string): SkillOrigin {
  const parsed = SkillOrigin.safeParse(source);
  if (!parsed.success) throw new Error(`source 要填那份 SKILL.md 的 http 或 https 原链接，「${source}」不是。`);
  return parsed.data;
}

/** 名字按这个 Bot 当前的 skill 解析成 id。控制面只认 id，名字对不上就把现有的名字列给模型照着改。 */
function resolveSkill(skills: readonly Skill[], name: string): Skill {
  const found = skills.find((skill) => skill.name === name);
  if (found !== undefined) return found;
  if (skills.length === 0) throw new Error(`没有叫「${name}」的 skill，你现在还没有存下任何 skill。`);
  throw new Error(`没有叫「${name}」的 skill。你现在会的：${skills.map((skill) => `「${skill.name}」`).join("、")}。`);
}

type Proposal = { readonly key: string; readonly change: SkillChange; readonly reply: string };

export function createSkillTools(options: {
  readonly activeRun: () => ActiveRun | null;
  /** 这个 Bot 当前 config 里的 skill。 */
  readonly skills: () => readonly Skill[];
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  // 一个 Bot 的运行是串行的，手里最多一次运行，记住这次问过哪些 skill 就够，换一次运行整个换掉。
  let asked: { readonly runId: RunId; readonly names: Set<string> } | null = null;

  const propose = (build: () => Proposal) => {
    const active = options.activeRun();
    if (active === null) throw new Error("这次工具调用不属于任何一次运行，没法问用户。");
    const { key, change, reply } = build();
    if (asked?.runId === active.run.runId && asked.names.has(key)) throw new Error(`「${key}」这次已经问过了。`);

    options.send(
      AgentToControl.parse({
        type: "skill_offer",
        runId: active.run.runId,
        botId: active.run.botId,
        groupId: active.run.groupId,
        change,
      }),
    );
    // 报文真发出去了才算问过。parse 挂在这一步的话，模型改好参数还能再问一次。
    if (asked?.runId !== active.run.runId) asked = { runId: active.run.runId, names: new Set() };
    asked.names.add(key);
    return { content: [{ type: "text" as const, text: reply }], details: {} };
  };

  return [
    {
      name: "propose_skill",
      label: "问要不要存",
      description:
        "出一张卡问用户存不存成会做的活（skill）。两种用法：把刚做完的活的步骤写成清单；或者从公开仓库找到现成的 SKILL.md，读完改写成中文步骤，source 填原链接。名字写这件活叫什么，步骤按先后写，至少两步。用户点了才生效。",
      parameters: PROPOSE_PARAMS,
      execute: async (_callId, params) =>
        propose(() => {
          const { name, steps, source } = params as Static<typeof PROPOSE_PARAMS>;
          checkName(name);
          checkSteps(steps);
          const origin = source === undefined ? null : checkOrigin(source);
          const reply =
            origin === null
              ? `已经在群里问用户存不存「${name}」了，等用户点。`
              : `已经在群里问用户要不要从 ${new URL(origin).host} 装「${name}」了，等用户点。`;
          return { key: name, change: { op: "add", name, steps, origin }, reply };
        }),
    },
    {
      name: "propose_skill_edit",
      label: "问要不要改",
      description:
        "用户要改你已有的某个 skill 时用：出一张卡列出改完的整份步骤，用户点了才改。skill 填它现在的名字，改名才填 name，steps 是改完的全部步骤，至少两步。",
      parameters: EDIT_PARAMS,
      execute: async (_callId, params) =>
        propose(() => {
          const { skill, name, steps } = params as Static<typeof EDIT_PARAMS>;
          const target = resolveSkill(options.skills(), skill);
          const next = name ?? target.name;
          checkName(next);
          checkSteps(steps);
          return {
            key: target.name,
            change: { op: "edit", targetId: target.id, name: next, steps },
            reply: `已经在群里问用户改不改「${target.name}」了，等用户点。`,
          };
        }),
    },
    {
      name: "propose_skill_removal",
      label: "问要不要删",
      description: "用户说某个 skill 不要了时用：出一张卡问用户删不删，用户点了才删。skill 填它现在的名字。",
      parameters: REMOVAL_PARAMS,
      execute: async (_callId, params) =>
        propose(() => {
          const { skill } = params as Static<typeof REMOVAL_PARAMS>;
          const target = resolveSkill(options.skills(), skill);
          return {
            key: target.name,
            change: { op: "remove", targetId: target.id, name: target.name },
            reply: `已经在群里问用户删不删「${target.name}」了，等用户点。`,
          };
        }),
    },
  ];
}
