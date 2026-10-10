import type { Routine } from "@baize/shared";
import type { Conversation } from "../../state/app.js";

export type RoutineSection = { key: string; title: string; note: string; routines: Routine[] };

export const DAILY_TITLE = "日常";

// 挂在项目群上的跟着那个项目走，其余的（不挂群、挂的群已经不在侧栏里）都算日常。日常在前，项目按侧栏顺序，空组不出。
export const routineSectionsOf = (routines: readonly Routine[], conversations: readonly Conversation[]) => {
  const projects = conversations.filter((c) => c.kind === "team");
  const projectOf = new Set<string>(projects.map((project) => project.groupId));
  const daily: RoutineSection = {
    key: "daily",
    title: DAILY_TITLE,
    note: "只属于你，不挂项目",
    routines: routines.filter((routine) => routine.groupId === null || !projectOf.has(routine.groupId)),
  };
  const byProject = projects.map((project): RoutineSection => ({
    key: project.groupId,
    title: project.task.title,
    note: "跟着项目走，项目停了它也停",
    routines: routines.filter((routine) => routine.groupId === project.groupId),
  }));
  return [daily, ...byProject].filter((section) => section.routines.length > 0);
};
