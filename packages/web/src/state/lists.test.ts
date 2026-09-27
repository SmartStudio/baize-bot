import { describe, expect, it } from "vitest";
import { BotId, Routine, Skill } from "@baize/shared";
import { MY_ROUTINES, reduceRoutines } from "./routines.js";
import { reduceSkills } from "./skills.js";
import { createClock, emptyShelf } from "./stamped.js";
import type { ReadyState } from "./types.js";

const BOT_ID = BotId.parse("bot_sales");
const at = "2026-09-26T08:00:00.000Z";

const routine = (id: string) =>
  Routine.parse({
    id,
    botId: BOT_ID,
    groupId: null,
    purpose: "fast",
    name: `例行 ${id}`,
    instruction: "看一眼询价邮箱",
    triggers: [],
    onFailure: "stop_and_tell",
    enabled: true,
    runs: [],
  });

const skill = (id: string) =>
  Skill.parse({
    id,
    botId: BOT_ID,
    name: `做法 ${id}`,
    source: "chat",
    steps: ["先查库存"],
    useCount: 0,
    createdAt: at,
  });

// 这几条动作只读写例行任务和 skill，别的字段用不上。
const initial = { routines: emptyShelf(), skills: emptyShelf() } as unknown as ReadyState;

const routineIds = (state: ReadyState) => state.routines.rows[MY_ROUTINES]?.map((r) => r.id);
const skillIds = (state: ReadyState) => state.skills.rows[BOT_ID]?.map((s) => s.id);

describe("删除推送和在途的列表", () => {
  it("例行任务删了以后，删之前发出的列表晚到也不把它加回来", () => {
    const next = createClock();
    const loaded = reduceRoutines(initial, {
      type: "routines_loaded",
      routines: [routine("routine_1"), routine("routine_2")],
      seq: next(),
    });
    const inFlight = next();
    const removed = reduceRoutines(loaded, {
      type: "routine_removed",
      routineId: "routine_1" as Routine["id"],
      seq: next(),
    });
    const late = reduceRoutines(removed, {
      type: "routines_loaded",
      routines: [routine("routine_1"), routine("routine_2")],
      seq: inFlight,
    });
    expect(routineIds(late)).toEqual(["routine_2"]);
  });

  it("skill 删了以后，删之前发出的列表晚到也不把它加回来", () => {
    const next = createClock();
    const loaded = reduceSkills(initial, {
      type: "skills_loaded",
      botId: BOT_ID,
      skills: [skill("skill_1"), skill("skill_2")],
      seq: next(),
    });
    const inFlight = next();
    const removed = reduceSkills(loaded, {
      type: "skill_removed",
      botId: BOT_ID,
      skillId: "skill_1" as Skill["id"],
      seq: next(),
    });
    const late = reduceSkills(removed, {
      type: "skills_loaded",
      botId: BOT_ID,
      skills: [skill("skill_1"), skill("skill_2")],
      seq: inFlight,
    });
    expect(skillIds(late)).toEqual(["skill_2"]);
  });

  it("新列表里没有的条目算删了，列表发出之后才建的照留", () => {
    const next = createClock();
    const loaded = reduceSkills(initial, {
      type: "skills_loaded",
      botId: BOT_ID,
      skills: [skill("skill_1"), skill("skill_2")],
      seq: next(),
    });
    const request = next();
    const created = reduceSkills(loaded, { type: "skill_upserted", skill: skill("skill_3"), seq: next() });
    const reloaded = reduceSkills(created, {
      type: "skills_loaded",
      botId: BOT_ID,
      skills: [skill("skill_2")],
      seq: request,
    });
    expect(skillIds(reloaded)).toEqual(["skill_2", "skill_3"]);
  });

  it("例行任务新列表里没有的条目算删了，列表发出之后才建的照留", () => {
    const next = createClock();
    const loaded = reduceRoutines(initial, {
      type: "routines_loaded",
      routines: [routine("routine_1"), routine("routine_2")],
      seq: next(),
    });
    const request = next();
    const created = reduceRoutines(loaded, { type: "routine_upserted", routine: routine("routine_3"), seq: next() });
    const reloaded = reduceRoutines(created, {
      type: "routines_loaded",
      routines: [routine("routine_2")],
      seq: request,
    });
    expect(routineIds(reloaded)).toEqual(["routine_2", "routine_3"]);
  });

  it("列表发出之后改过的条目留本地那份，新列表里也有它时只出现一次", () => {
    const next = createClock();
    const loaded = reduceSkills(initial, {
      type: "skills_loaded",
      botId: BOT_ID,
      skills: [skill("skill_1"), skill("skill_2")],
      seq: next(),
    });
    const request = next();
    const renamed = { ...skill("skill_1"), name: "改过的名字" };
    const edited = reduceSkills(loaded, { type: "skill_upserted", skill: renamed, seq: next() });
    const reloaded = reduceSkills(edited, {
      type: "skills_loaded",
      botId: BOT_ID,
      skills: [skill("skill_1"), skill("skill_2")],
      seq: request,
    });
    expect(reloaded.skills.rows[BOT_ID]).toEqual([renamed, skill("skill_2")]);
  });
});

describe("首次列表还在路上时到的推送", () => {
  it("例行任务删除推送先到，在途的列表晚到也不把它加回来", () => {
    const next = createClock();
    const request = next();
    const removed = reduceRoutines(initial, {
      type: "routine_removed",
      routineId: "routine_1" as Routine["id"],
      seq: next(),
    });
    expect(routineIds(removed), "推送不能把列表算成拉过").toBeUndefined();
    const late = reduceRoutines(removed, {
      type: "routines_loaded",
      routines: [routine("routine_1"), routine("routine_2")],
      seq: request,
    });
    expect(routineIds(late)).toEqual(["routine_2"]);
  });

  it("例行任务新建推送先到，列表里没有它也照留", () => {
    const next = createClock();
    const request = next();
    const created = reduceRoutines(initial, { type: "routine_upserted", routine: routine("routine_3"), seq: next() });
    expect(routineIds(created), "推送不能把列表算成拉过").toBeUndefined();
    const late = reduceRoutines(created, {
      type: "routines_loaded",
      routines: [routine("routine_1")],
      seq: request,
    });
    expect(routineIds(late)).toEqual(["routine_1", "routine_3"]);
  });

  it("skill 删除和改名推送先到，在途的列表晚到不复活、不盖回旧名", () => {
    const next = createClock();
    const request = next();
    const removed = reduceSkills(initial, {
      type: "skill_removed",
      botId: BOT_ID,
      skillId: "skill_1" as Skill["id"],
      seq: next(),
    });
    const renamed = { ...skill("skill_2"), name: "改过的名字" };
    const edited = reduceSkills(removed, { type: "skill_upserted", skill: renamed, seq: next() });
    expect(skillIds(edited), "推送不能把列表算成拉过").toBeUndefined();
    const late = reduceSkills(edited, {
      type: "skills_loaded",
      botId: BOT_ID,
      skills: [skill("skill_1"), skill("skill_2")],
      seq: request,
    });
    expect(late.skills.rows[BOT_ID]).toEqual([renamed]);
  });
});
