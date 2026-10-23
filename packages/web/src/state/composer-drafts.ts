import { useSyncExternalStore } from "react";
import type { GroupId } from "@baize/shared";

const draftsUntilReload = new Map<GroupId, string>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// 发送的结果可能在输入框卸载之后才回来，清空或写回都得照样落到那个群上。
export const setDraft = (groupId: GroupId, text: string) => {
  if (text === "") draftsUntilReload.delete(groupId);
  else draftsUntilReload.set(groupId, text);
  for (const listener of listeners) listener();
};

export const useComposerDraft = (groupId: GroupId): string =>
  useSyncExternalStore(subscribe, () => draftsUntilReload.get(groupId) ?? "");
