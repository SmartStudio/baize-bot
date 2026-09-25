import type { Settings } from "@baize/shared";
import type { Action, AppState } from "./types.js";
import type { ServerPush } from "@baize/shared";
import { notifyNotice } from "./notify.js";

export type PushHandlers = {
  [K in ServerPush["type"]]: (push: Extract<ServerPush, { type: K }>) => void;
};

type PushContext = {
  dispatch: (action: Action) => void;
  stateRef: { current: AppState };
  settingsRef: { current: Settings | null };
  refreshPendingCounts: () => void;
};

export const createPushHandlers = ({
  dispatch,
  stateRef,
  settingsRef,
  refreshPendingCounts,
}: PushContext): PushHandlers => {
  const bumpToday = () => dispatch({ type: "today_version_bumped" });
  return {
    message: (push) => dispatch({ type: "message_upserted", message: push.message }),
    message_delta: (push) =>
      dispatch({
        type: "message_delta",
        messageId: push.messageId,
        groupId: push.groupId,
        delta: push.delta,
        done: push.done,
      }),
    bot_updated: (push) => dispatch({ type: "bot_updated", bot: push.bot }),
    bot_deleted: (push) => dispatch({ type: "bot_removed", botId: push.botId }),
    group_created: (push) => {
      // 建群的人已经从 POST 的响应知道了这个群。这条推送是给同一个账号别的窗口看的，不抢它们当下的选中。
      dispatch({ type: "group_created", group: push.group, task: push.task });
    },
    group_updated: (push) => dispatch({ type: "group_updated", group: push.group }),
    group_turn: (push) => dispatch({ type: "group_turn", turn: push }),
    task_updated: (push) => dispatch({ type: "task_updated", task: push.task }),
    approval_updated: (push) => {
      const unseenTerminal =
        push.approval.status !== "pending" &&
        stateRef.current.status === "ready" &&
        stateRef.current.approvals[push.approval.id] === undefined;
      dispatch({ type: "approval_pushed", approval: push.approval });
      if (unseenTerminal) refreshPendingCounts();
      bumpToday();
    },
    grant_deleted: () => undefined,
    handoff_updated: (push) => {
      // 交接是 Bot 等 Bot，不是等你。它记角标，但不该弹一个系统通知把你从别的事上拽回来。
      const unseenTerminal =
        push.handoff.status !== "pending" &&
        stateRef.current.status === "ready" &&
        stateRef.current.handoffs[push.handoff.id] === undefined;
      dispatch({ type: "handoff_pushed", handoff: push.handoff });
      if (unseenTerminal) refreshPendingCounts();
    },
    routine_updated: (push) => dispatch({ type: "routine_upserted", routine: push.routine }),
    routine_deleted: (push) => dispatch({ type: "routine_removed", botId: push.botId, routineId: push.routineId }),
    skill_updated: (push) => dispatch({ type: "skill_upserted", skill: push.skill }),
    skill_deleted: (push) => dispatch({ type: "skill_removed", botId: push.botId, skillId: push.skillId }),
    draft_updated: () => bumpToday(),
    plan_updated: () => bumpToday(),
    account_updated: () => bumpToday(),
    account_deleted: () => bumpToday(),
    publication_created: () => bumpToday(),
    computer_updated: () => undefined,
    notify: (push) => {
      bumpToday();
      const current = settingsRef.current;
      if (current !== null) notifyNotice(push.notice, current);
    },
  };
};

export const dispatchServerPush = (handlers: PushHandlers, push: ServerPush): void => {
  const handler = handlers[push.type] as (push: ServerPush) => void;
  handler(push);
};
