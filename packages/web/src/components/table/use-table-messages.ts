import { useEffect } from "react";
import type { GroupId, Message } from "@baize/shared";
import { useApp } from "../../state/app.js";
import type { Seq } from "../../state/stamped.js";

const NONE: readonly Message[] = [];

export type TableMessages = {
  messages: readonly Message[];
  history: "loading" | "ready" | "failed";
  retry: () => void;
};

// 牌桌页不走群页的历史拉取，右栏和老白的建议自己把这个群的消息拉回来。
// 拉取的判定和主窗口一致：比最近一次重连新的那趟历史才算拉过；失败了不自动再拉，等用户点重试。
export const useTableMessages = (groupId: GroupId): TableMessages => {
  const { state, actions } = useApp();
  const ready = state.status === "ready" ? state : null;
  const signedIn = ready !== null;
  const reconnectedAt = ready?.reconnectedAt ?? (0 as Seq);
  const loaded = ready !== null && (ready.messagesLoadedAt[groupId] ?? 0) > reconnectedAt;

  useEffect(() => {
    if (signedIn && !loaded) void actions.loadMessages(groupId, reconnectedAt);
  }, [groupId, signedIn, loaded, reconnectedAt, actions]);

  if (ready === null) return { messages: NONE, history: "loading", retry: () => undefined };
  const failed = ready.loads[`messages:${groupId}`] === "failed";
  return {
    messages: ready.messages.rows[groupId] ?? ready.messages.early[groupId] ?? NONE,
    history: loaded ? "ready" : failed ? "failed" : "loading",
    retry: () => void actions.loadMessages(groupId, reconnectedAt),
  };
};
