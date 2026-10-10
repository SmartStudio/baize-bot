import {
  ProjectResponse,
  ProjectReviewId,
  type Group,
  type GroupId,
  type Message,
  type ProjectAchievement,
  type TaskMetric,
  type TopicTask,
} from "@baize/shared";
import { writeTask } from "./groups.js";
import { pendingOf } from "./today.js";
import {
  bots,
  checkedAt,
  currentGeneration,
  drafts,
  groups,
  isTeamGroup,
  messagesByGroupId,
  plans,
  publications,
  routines,
} from "./store.js";

type Review = Extract<ProjectAchievement, { kind: "review" }>;
type Sample = { readonly value: number; readonly at: number };

// 样本和复盘挂在 mock 的代上，/api/test/reset 换代就整份作废，不用去 reseed 里登记。
let goalState = { generation: -1, samples: new Map<string, Sample[]>(), reviews: new Map<string, Review[]>() };
const goalStateNow = () => {
  if (goalState.generation !== currentGeneration()) {
    goalState = { generation: currentGeneration(), samples: new Map(), reviews: new Map() };
  }
  return goalState;
};

// 周一 00:00 上海时区，和控制面 usage.ts#weekStart 同一个周界（D18）。
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
export const weekStartOf = (now: Date): Date => {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  return new Date(day - sinceMonday * 86_400_000 - SHANGHAI_OFFSET_MS);
};

// 和控制面 metrics.ts#metricsOf 同一套口径：最新值减周一之前最后一个；周一之前没有就减本周第一个；最新的本身在周一之前就记 0。
export const metricOf = (groupId: string, now: Date): TaskMetric | null => {
  const samples = goalStateNow().samples.get(groupId) ?? [];
  const latest = samples.at(-1);
  if (latest === undefined) return null;
  const start = weekStartOf(now).getTime();
  const baseline =
    latest.at < start
      ? latest
      : (samples.findLast((sample) => sample.at < start) ?? samples.find((sample) => sample.at >= start));
  return {
    current: latest.value,
    weekDelta: baseline === undefined ? 0 : latest.value - baseline.value,
    sampledAt: new Date(latest.at).toISOString(),
  };
};

// mock 删 Bot 不改群的 botIds，成员还在不在要看 Bot 本身还在不在。控制面的 groupHasMembers 是同一个意思。
export const hasMembers = (group: Group): boolean => group.botIds.some((botId) => bots.has(botId));

/** 记一个样本，回带着最新指标的任务卡。只认还有成员的多 Bot 群，别的回 null 让路由回 404。 */
export const recordSample = (groupId: string, value: number, at = Date.now()): TopicTask | null => {
  const group = groups.get(groupId);
  if (group === undefined || !isTeamGroup(group) || !hasMembers(group)) return null;
  const samples = goalStateNow().samples;
  samples.set(
    groupId,
    [...(samples.get(groupId) ?? []), { value, at }].toSorted((left, right) => left.at - right.at),
  );
  return writeTask(group.taskId, {});
};

// 项目目标用例的数据：订单群定下年底 1000 星，上周末记过 375，刚才 412，本周 +37；再交一份周复盘。
export const seedProjectGoal = (): TopicTask | null => {
  const group = groups.get("grp_order");
  if (group === undefined) return null;
  writeTask(group.taskId, { goal: { target: 1000, unit: "星", dueAt: null } });
  const now = Date.now();
  const monday = weekStartOf(new Date(now));
  recordSample(group.id, 375, monday.getTime() - 86_400_000);
  goalStateNow().reviews.set(group.id, [
    {
      kind: "review",
      id: ProjectReviewId.parse("rev_order_week41"),
      at: new Date(now - 30 * 60_000).toISOString(),
      title: "第 41 周复盘",
      weekStart: monday.toISOString().slice(0, 10),
      body: "## 这周\n\n星数这周涨了 37，最好的一条是讲交期的小红书。\n\n## 下周\n\n多发两条讲排产看板的。",
    },
  ]);
  return recordSample(group.id, 412, now);
};

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

// 和控制面同一套口径：只看这一个多 Bot 群，成果是发布记录和周复盘按时间倒序。mock 没有 run 表，在做的事恒为空。
export const projectOf = (groupId: string): ProjectResponse | null => {
  const group = groups.get(groupId);
  if (group === undefined || !isTeamGroup(group)) return null;
  const inGroup = (id: GroupId | null) => id === group.id;
  const published = [...publications.values()].filter((publication) => inGroup(publication.groupId));
  const achievements: ProjectAchievement[] = [
    ...published.map((publication) => ({
      kind: "publication" as const,
      id: publication.id,
      at: publication.publishedAt,
      title: titleOf(publication.draftId),
      platform: publication.platform,
      url: publication.url,
    })),
    ...(goalStateNow().reviews.get(group.id) ?? []),
  ]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 20);
  const plan = [...plans.values()]
    .filter((item) => inGroup(item.groupId) && item.status === "approved")
    .sort((left, right) => (right.decidedAt ?? "").localeCompare(left.decidedAt ?? ""))[0];
  const scheduled = [...drafts.values()]
    .filter((draft) => inGroup(draft.groupId) && draft.status === "approved" && draft.scheduledAt !== null)
    .sort((left, right) => (left.scheduledAt ?? "").localeCompare(right.scheduledAt ?? ""))[0];
  return ProjectResponse.parse({
    groupId: group.id,
    // 成果只给最近 20 条，发布数照控制面单独数，不跟着成果截断。
    weekPublished: published.length,
    // 和 weekPublished 一样不按周切：mock 里的勾选都是这次进程里刚勾的。
    weekChecked: checkedAt.get(group.taskId)?.size ?? 0,
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
        case "team_offer":
          return item.message.body.kind === "team_offer" && inGroup(item.message.body.groupId);
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
        state: routine.state,
        nextAt: null,
      })),
  });
};
