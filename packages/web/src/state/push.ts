import type { ComputerId, GroupId, ServerPush } from "@baize/shared";
import type { Action, AppState, ReadyState, SessionId } from "./types.js";
import { notifyNotice } from "./notify.js";
import type { Seq } from "./stamped.js";

// seq 是这条推送到达时取的号。
export type PushHandlers = {
  [K in ServerPush["type"]]: (push: Extract<ServerPush, { type: K }>, seq: Seq) => void;
};

// 一套处理函数只属于创建它的那次会话。dispatch 出去的动作由 reducer 按会话号把关；不经 reducer 的副作用
// （读当前状态、弹系统通知）得自己先问 live，读状态也只认这次会话的那份。
type PushContext = {
  session: SessionId;
  live: () => boolean;
  dispatch: (action: Action) => void;
  stateRef: { current: AppState };
  refreshPendingCounts: () => void;
  // 电脑不在线了，它上面等扫码的登录卡等不到结果：重拉账号，还在等的结成离线。
  recoverLogins: (computerId: ComputerId) => void;
};

export const createPushHandlers = ({
  session,
  live,
  dispatch,
  stateRef,
  refreshPendingCounts,
  recoverLogins,
}: PushContext): PushHandlers => {
  const bumpToday = () => dispatch({ type: "today_version_bumped" });
  const mine = (): ReadyState | null => {
    const state = stateRef.current;
    return live() && state.status === "ready" && state.session === session ? state : null;
  };
  // 首页那句「主助理最近一句」来自今天快照，主助理在单聊里说完一句就得重拉。
  const inAssistantChat = (groupId: GroupId): boolean => {
    const state = mine();
    const chat = state?.conversations.find((c) => c.groupId === groupId);
    return chat?.kind === "solo" && state?.bots[chat.botId]?.role === "assistant";
  };
  return {
    message: (push, seq) => {
      dispatch({ type: "message_upserted", message: push.message, seq });
      const { body, groupId } = push.message;
      if (body.kind === "bot" && !body.streaming && body.text !== "" && inAssistantChat(groupId)) bumpToday();
    },
    message_delta: (push, seq) => {
      dispatch({
        type: "message_delta",
        messageId: push.messageId,
        groupId: push.groupId,
        delta: push.delta,
        done: push.done,
        seq,
      });
      if (push.done && inAssistantChat(push.groupId)) bumpToday();
    },
    bot_updated: (push) => dispatch({ type: "bot_updated", bot: push.bot }),
    bot_deleted: (push) => dispatch({ type: "bot_removed", botId: push.botId }),
    group_created: (push) => {
      // 建群的人已经从 POST 的响应知道了这个群。这条推送是给同一个账号别的窗口看的，不抢它们当下的选中。
      dispatch({ type: "group_created", group: push.group, task: push.task });
      // 电脑 hello 补建主助理时首页的快照里 assistantGroupId 还是 null，输入框禁用着，要重拉才解开。
      bumpToday();
    },
    group_updated: (push) => dispatch({ type: "group_updated", group: push.group }),
    group_turn: (push) => dispatch({ type: "group_turn", turn: push }),
    task_updated: (push) => dispatch({ type: "task_updated", task: push.task }),
    approval_updated: (push) => {
      const state = mine();
      const unseenTerminal =
        push.approval.status !== "pending" && state !== null && state.approvals[push.approval.id] === undefined;
      dispatch({ type: "approval_pushed", approval: push.approval });
      if (unseenTerminal) refreshPendingCounts();
      bumpToday();
    },
    grant_deleted: (push) => dispatch({ type: "grant_deleted", grantId: push.grantId }),
    handoff_updated: (push) => {
      // 交接是 Bot 等 Bot，不是等你。它记角标，但不该弹一个系统通知把你从别的事上拽回来。
      const state = mine();
      const unseenTerminal =
        push.handoff.status !== "pending" && state !== null && state.handoffs[push.handoff.id] === undefined;
      dispatch({ type: "handoff_pushed", handoff: push.handoff });
      if (unseenTerminal) refreshPendingCounts();
    },
    routine_updated: (push, seq) => dispatch({ type: "routine_upserted", routine: push.routine, seq }),
    routine_deleted: (push, seq) => dispatch({ type: "routine_removed", routineId: push.routineId, seq }),
    skill_updated: (push, seq) => dispatch({ type: "skill_upserted", skill: push.skill, seq }),
    skill_deleted: (push, seq) => dispatch({ type: "skill_removed", botId: push.botId, skillId: push.skillId, seq }),
    draft_updated: (push, seq) => {
      dispatch({ type: "content_loaded", drafts: [push.draft], plans: [], seq });
      bumpToday();
    },
    plan_updated: (push, seq) => {
      dispatch({ type: "content_loaded", drafts: [], plans: [push.plan], seq });
      bumpToday();
    },
    account_updated: (push, seq) => {
      dispatch({ type: "account_upserted", account: push.account, seq });
      bumpToday();
    },
    account_deleted: (push, seq) => {
      dispatch({ type: "account_removed", accountId: push.accountId, seq });
      bumpToday();
    },
    publication_created: (push) => {
      dispatch({ type: "publications_loaded", publications: [push.publication] });
      bumpToday();
    },
    computer_updated: (push, seq) => {
      dispatch({ type: "computer_upserted", computer: push.computer, seq });
      if (push.computer.status !== "online") recoverLogins(push.computer.id);
    },
    login_failed: (push) =>
      dispatch({ type: "login_failed", accountId: push.accountId, attempt: push.attempt, reason: push.reason }),
    notify: (push) => {
      bumpToday();
      const state = mine();
      if (state !== null) notifyNotice(push.notice, state.settings);
    },
  };
};

export const dispatchServerPush = (handlers: PushHandlers, push: ServerPush, seq: Seq): void => {
  const handler = handlers[push.type] as (push: ServerPush, seq: Seq) => void;
  handler(push, seq);
};
