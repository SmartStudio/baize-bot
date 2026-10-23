import { useCallback, useEffect, useState } from "react";
import type { GroupId } from "@baize/shared";

type Drafts = Partial<Record<GroupId, string>>;

let draftsUntilReload: Drafts = {};

const withDraft = (drafts: Drafts, groupId: GroupId, text: string): Drafts => {
  const { [groupId]: _old, ...rest } = drafts;
  return text === "" ? rest : { ...rest, [groupId]: text };
};

export const useComposerDraft = (groupId: GroupId): [string, (groupId: GroupId, text: string) => void] => {
  const [drafts, setDrafts] = useState(() => draftsUntilReload);
  useEffect(() => {
    draftsUntilReload = drafts;
  }, [drafts]);
  const setDraft = useCallback(
    (target: GroupId, text: string) => setDrafts((current) => withDraft(current, target, text)),
    [],
  );
  return [drafts[groupId] ?? "", setDraft];
};
