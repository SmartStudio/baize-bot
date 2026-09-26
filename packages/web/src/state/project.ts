import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupId, ProjectResponse } from "@baize/shared";
import { useApp } from "./app.js";

type ProjectLoad =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: ProjectResponse; error: string | null }
  | { status: "failed"; data: null; error: string };

const REFRESH_DEBOUNCE_MS = 100;
const REFRESH_ERROR = "项目页刷新失败。";

// 标题、目标和清单读会话里的任务卡，task_updated 已经把它推新了，不用为它重拉。
// 等你、在做、成果、轮数跟着卡片和稿子的推送（todayVersion）、这个群的消息条数、群里谁在说走。
export const useProject = (groupId: GroupId) => {
  const { state, actions } = useApp();
  const loadProject = actions.loadProject;
  const ready = state.status === "ready" ? state : null;
  const todayVersion = ready?.todayVersion ?? 0;
  const messageCount = ready?.messages[groupId]?.length ?? 0;
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
  }, [fetchProject, groupId, todayVersion, messageCount, speaking]);

  // 换了项目，上一个项目的数据不能顶着新标题露出来。
  const current: ProjectLoad = load.groupId === groupId ? load : { status: "loading", data: null, error: null };
  return { ...current, refresh: fetchProject };
};

export type Project = ReturnType<typeof useProject>;
