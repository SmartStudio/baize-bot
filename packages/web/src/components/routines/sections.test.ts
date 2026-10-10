import { describe, expect, it } from "vitest";
import { Routine } from "@baize/shared";
import type { Conversation } from "../../state/app.js";
import { routineSectionsOf } from "./sections.js";

const routine = (name: string, groupId: string | null) =>
  Routine.parse({
    id: `rtn_${name}`,
    botId: "bot_a",
    groupId,
    purpose: "plan",
    name,
    instruction: "做事",
    triggers: [{ kind: "cron", expr: "0 9 * * *" }],
    onFailure: "stop_and_tell",
    state: "on",
    boundary: "draft",
    onToday: false,
    runs: [],
  });

const solo = (groupId: string) => ({ kind: "solo", groupId, botId: "bot_a" }) as unknown as Conversation;
const team = (groupId: string, title: string) =>
  ({ kind: "team", groupId, task: { title } }) as unknown as Conversation;

const shape = (sections: ReturnType<typeof routineSectionsOf>) =>
  sections.map((section) => [section.title, section.routines.map((item) => item.name)]);

describe("routineSectionsOf", () => {
  it("日常在前，项目按侧栏顺序，各自只装挂在自己群上的", () => {
    const conversations = [team("grp_b", "乙项目"), solo("grp_solo"), team("grp_a", "甲项目")];
    const routines = [routine("甲周报", "grp_a"), routine("早报", null), routine("乙日报", "grp_b")];
    expect(shape(routineSectionsOf(routines, conversations))).toEqual([
      ["日常", ["早报"]],
      ["乙项目", ["乙日报"]],
      ["甲项目", ["甲周报"]],
    ]);
  });

  it("挂在单聊或已经不在侧栏的群上的算日常，不丢", () => {
    const routines = [routine("单聊里的", "grp_solo"), routine("项目没了", "grp_gone")];
    expect(shape(routineSectionsOf(routines, [solo("grp_solo")]))).toEqual([["日常", ["单聊里的", "项目没了"]]]);
  });

  it("没有例行的组不出，日常空了也不出", () => {
    const conversations = [team("grp_a", "甲项目"), team("grp_b", "乙项目")];
    expect(shape(routineSectionsOf([routine("甲周报", "grp_a")], conversations))).toEqual([["甲项目", ["甲周报"]]]);
    expect(routineSectionsOf([], conversations)).toEqual([]);
  });
});
