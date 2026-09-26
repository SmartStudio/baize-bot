import { ProjectResponse, type GroupId, type Message } from "@baize/shared";
import { pendingOf } from "./today.js";
import { drafts, groups, isTeamGroup, messagesByGroupId, plans, publications, routines } from "./store.js";

const titleOf = (draftId: string | null): string => {
  const draft = draftId === null ? undefined : drafts.get(draftId);
  if (draft === undefined) return "成果已发布";
  return draft.content.kind === "post"
    ? (draft.content.title ?? draft.content.text.slice(0, 80))
    : `回复 ${draft.content.replyTo.author}`;
};

// 和控制面同一套口径：按 createdAt 挑你最后说的那句，之后的消息不含 cost，最多给最近的 50 条。
// mock 没有 seq，同一时刻的先后按写入顺序。
const turnOf = (messages: readonly Message[]): Pick<ProjectResponse, "latestTurn" | "olderTurns"> => {
  const ordered = messages.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const at = ordered.findLastIndex((message) => message.body.kind === "user");
  const said = ordered[at];
  if (said === undefined) return { latestTurn: null, olderTurns: 0 };
  return {
    latestTurn: {
      said,
      replies: ordered
        .slice(at + 1)
        .filter((message) => message.body.kind !== "cost")
        .slice(-50),
    },
    olderTurns: ordered.filter((message) => message.body.kind === "user").length - 1,
  };
};

// 和控制面同一套口径：只看这一个多 Bot 群，成果只读发布记录。mock 没有 run 表，在做的事恒为空。
export const projectOf = (groupId: string): ProjectResponse | null => {
  const group = groups.get(groupId);
  if (group === undefined || !isTeamGroup(group)) return null;
  const inGroup = (id: GroupId | null) => id === group.id;
  const achievements = [...publications.values()]
    .filter((publication) => inGroup(publication.groupId))
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .slice(0, 20)
    .map((publication) => ({
      id: publication.id,
      at: publication.publishedAt,
      title: titleOf(publication.draftId),
      platform: publication.platform,
      url: publication.url,
    }));
  const plan = [...plans.values()]
    .filter((item) => inGroup(item.groupId) && item.status === "approved")
    .sort((left, right) => (right.decidedAt ?? "").localeCompare(left.decidedAt ?? ""))[0];
  const scheduled = [...drafts.values()]
    .filter((draft) => inGroup(draft.groupId) && draft.status === "approved" && draft.scheduledAt !== null)
    .sort((left, right) => (left.scheduledAt ?? "").localeCompare(right.scheduledAt ?? ""))[0];
  return ProjectResponse.parse({
    groupId: group.id,
    weekPublished: achievements.length,
    ...turnOf(messagesByGroupId.get(groupId) ?? []),
    working: [],
    pending: pendingOf().filter((item) => {
      switch (item.kind) {
        case "approval":
          return inGroup(item.approval.groupId);
        case "plan":
          return inGroup(item.plan.groupId);
        case "draft":
          return inGroup(item.draft.groupId);
        case "account":
          return false;
      }
    }),
    plan:
      plan === undefined
        ? null
        : {
            plan,
            drafts: plan.draftIds.flatMap((id) => {
              const draft = drafts.get(id);
              return draft === undefined ? [] : [draft];
            }),
          },
    next:
      scheduled === undefined || scheduled.scheduledAt === null
        ? null
        : { kind: "draft", at: scheduled.scheduledAt, draft: scheduled },
    achievements,
    routines: [...routines.values()]
      .filter((routine) => inGroup(routine.groupId))
      .map((routine) => ({
        routineId: routine.id,
        botId: routine.botId,
        name: routine.name,
        enabled: routine.enabled,
        nextAt: null,
      })),
  });
};
