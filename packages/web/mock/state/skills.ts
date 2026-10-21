import { Skill, SkillId, type SkillSource } from "@baize/shared";
import { nextSuffix, skills } from "./store.js";

export const skillsOf = (botId: string): Skill[] => [...skills.values()].filter((skill) => skill.botId === botId);

export const skillNameTaken = (botId: string, name: string, exceptId?: string): boolean =>
  [...skills.values()].some((skill) => skill.botId === botId && skill.name === name && skill.id !== exceptId);

export const createSkill = (
  botId: string,
  input: { name: string; steps: readonly string[] },
  source: SkillSource,
  origin: string | null = null,
): Skill => {
  const skill = Skill.parse({
    id: SkillId.parse(`skl_new_${nextSuffix()}`),
    botId,
    name: input.name,
    source,
    steps: input.steps,
    origin,
    useCount: 0,
    createdAt: new Date().toISOString(),
  });
  skills.set(skill.id, skill);
  return skill;
};

export const writeSkill = (id: string, patch: { name: string; steps: readonly string[] }): Skill | null => {
  const skill = skills.get(id);
  if (skill === undefined) return null;
  const next = Skill.parse({ ...skill, ...patch });
  skills.set(next.id, next);
  return next;
};
