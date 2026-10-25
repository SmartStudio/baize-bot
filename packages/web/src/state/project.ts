import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChecklistItem,
  GroupId,
  MetricSource,
  ProjectGoal,
  ProjectResponse,
  ReadMetric,
  TaskMetric,
} from "@baize/shared";
import { useApp } from "./app.js";

type ProjectLoad =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: ProjectResponse; error: string | null }
  | { status: "failed"; data: null; error: string };

const REFRESH_DEBOUNCE_MS = 100;
const REFRESH_ERROR = "项目页刷新失败。";

// 标题、目标和清单读会话里的任务卡，task_updated 已经把它推新了。本周勾掉几项只有服务端算得出，勾着的项变了就重拉。
// 等你、在做、成果、轮数跟着卡片和稿子的推送（todayVersion）、这个群的消息条数、群里谁在说走。
export const useProject = (groupId: GroupId, checklist: readonly ChecklistItem[]) => {
  const { state, actions } = useApp();
  const loadProject = actions.loadProject;
  const ready = state.status === "ready" ? state : null;
  // 每条 task_updated 都换一份新数组，只有勾着的项变了才值得重拉。
  const checked = checklist
    .filter((item) => item.done)
    .map((item) => item.text)
    .join("\n");
  const todayVersion = ready?.todayVersion ?? 0;
  const messageCount = ready?.messages.rows[groupId]?.length ?? 0;
  const speaking = ready?.groupTurns[groupId]?.current ?? null;
  const [load, setLoad] = useState<ProjectLoad & { groupId: GroupId }>({
    status: "loading",
    data: null,
    error: null,
    groupId,
  });
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const loadedFor = useRef<GroupId | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchProject = useCallback(async () => {
    const currentRequest = requestVersion.current + 1;
    requestVersion.current = currentRequest;
    try {
      const data = await loadProject(groupId);
      if (data === undefined) return;
      if (mounted.current && requestVersion.current === currentRequest)
        setLoad({ status: "ready", data, error: null, groupId });
    } catch {
      if (!mounted.current || requestVersion.current !== currentRequest) return;
      setLoad((current) =>
        current.data === null || current.groupId !== groupId
          ? { status: "failed", data: null, error: "项目页没取到。", groupId }
          : { ...current, error: REFRESH_ERROR },
      );
    }
  }, [loadProject, groupId]);

  useEffect(() => {
    const first = loadedFor.current !== groupId;
    loadedFor.current = groupId;
    const timer = setTimeout(() => void fetchProject(), first ? 0 : REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fetchProject, groupId, todayVersion, messageCount, speaking, checked]);

  // 换了项目，上一个项目的数据不能顶着新标题露出来。
  const current: ProjectLoad = load.groupId === groupId ? load : { status: "loading", data: null, error: null };
  return { ...current, refresh: fetchProject };
};

export type Project = ReturnType<typeof useProject>;

export type GoalProgress =
  | { readonly kind: "unread"; readonly target: number; readonly unit: string }
  | {
      readonly kind: "read";
      readonly current: number;
      readonly target: number;
      readonly unit: string;
      readonly weekDelta: number;
    };

// 周一 00:00 上海时区，和控制面 usage.ts#weekStart 同一个周界（D18）。
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const weekStartOf = (now: Date): number => {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return day - ((local.getUTCDay() + 6) % 7) * 86_400_000 - SHANGHAI_OFFSET_MS;
};

// 会话里的卡可能是上周推来的，跨过周界又没有新样本，服务端此刻算的本周变化就是 0。
export const weekDeltaOf = (metric: ReadMetric, now: Date): number =>
  Date.parse(metric.sampledAt) < weekStartOf(now) ? 0 : metric.weekDelta;

export const goalProgressOf = (goal: ProjectGoal | null, metric: TaskMetric, now: Date): GoalProgress | null => {
  if (goal === null) return null;
  if (metric.kind === "unread") return { kind: "unread", target: goal.target, unit: goal.unit };
  return {
    kind: "read",
    current: metric.current,
    target: goal.target,
    unit: goal.unit,
    weekDelta: weekDeltaOf(metric, now),
  };
};

export const metricNameOf = (source: MetricSource): string => {
  switch (source.kind) {
    case "github_stars":
      return `GitHub 星数 · ${source.repo}`;
    case "x_followers":
      return "X 粉丝数";
    case "reported":
      return source.label;
  }
};

// 样本可以是小数，减出来的变化会带浮点尾巴；目标数常到四位，不加千分位，和原型的「412 / 1000」一致。
const NUMBER = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false });
export const numberText = (value: number): string => NUMBER.format(value);

export const UNREAD_TEXT = "还没读到数";

export const goalText = (progress: GoalProgress): string =>
  progress.kind === "unread"
    ? `${numberText(progress.target)} ${progress.unit} · ${UNREAD_TEXT}`
    : `${numberText(progress.current)} / ${numberText(progress.target)} ${progress.unit}`;

// 进度条超过目标就画满，掉成负数画空。
export const goalBarValue = (progress: GoalProgress & { kind: "read" }): number =>
  Math.min(Math.max(progress.current, 0), progress.target);

export const weekDeltaText = (delta: number): string | null =>
  delta === 0 ? null : `本周 ${delta > 0 ? "+" : ""}${numberText(delta)}`;
