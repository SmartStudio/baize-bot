import type { ComputerId, GroupId, ServerPush } from "@baize/shared";
import type { Action, AppState, ReadyState, SessionId } from "./types.js";
import { finishingElsewhere } from "./computer-choices.js";
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
  // 重拉这个群每个成员选的电脑和正在跑的那台，after 是触发它的推送的号。
  reloadChoices: (groupId: GroupId, after: Seq) => void;
};

export const createPushHandlers = ({
  session,
  live,
  dispatch,
  stateRef,
  refreshPendingCounts,
  recoverLogins,
  reloadChoices,
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
  // runningOn 没有自己的推送。换了电脑、这一轮还在原来那台上时，这个群接下来的消息和回合推送里有一条是这一轮跑完的那条。
  const recheckChoices = (groupId: GroupId, seq: Seq) => {
    if (finishingElsewhere(mine(), groupId)) reloadChoices(groupId, seq);
  };
  return {
    message: (push, seq) => {
      dispatch({ type: "message_upserted", message: push.message, seq });
      const { body, groupId } = push.message;
      if (body.kind === "bot" && !body.streaming && body.text !== "" && inAssistantChat(groupId)) bumpToday();
      // 建队卡和例行确认卡都是首页「等你」里的一行，新卡落地、别的窗口拍了板都得重拉。
      if (body.kind === "team_offer" || body.kind === "routine_offer") bumpToday();
      recheckChoices(groupId, seq);
    },
    message_delta: (push, seq) => {
      dispatch({
        type: "message_delta",
        messageId: push.messageId,
        groupId: push.groupId,
        delta: push.delta,
        done: push.done,
        revision: push.revision,
        visibleTo: push.visibleTo,
        seq,
      });
      if (push.done && inAssistantChat(push.groupId)) bumpToday();
    },
    bot_created: (push) => dispatch({ type: "bot_created", bot: push.bot, groupId: push.groupId }),
    bot_updated: (push) => dispatch({ type: "bot_updated", bot: push.bot }),
    bot_deleted: (push) => dispatch({ type: "bot_removed", botId: push.botId }),
    group_created: (push, seq) => {
      // 建群的人已经从 POST 的响应知道了这个群。这条推送是给同一个账号别的窗口看的，不抢它们当下的选中。
      dispatch({ type: "group_created", group: push.group, task: push.task, seq });
      // 电脑 hello 补建主助理时首页的快照里 assistantGroupId 还是 null，输入框禁用着，要重拉才解开。
      bumpToday();
    },
    group_updated: (push, seq) => {
      dispatch({ type: "group_updated", group: push.group, seq });
      if (mine()?.computerChoices.rows[push.group.id] !== undefined) reloadChoices(push.group.id, seq);
    },
    group_archived: (push, seq) => {
      dispatch({ type: "group_archived", groupId: push.groupId, seq });
      // 首页的「等你」和项目列表都是服务端快照，解散的群得重拉才从里面消失。
      bumpToday();
    },
    group_turn: (push, seq) => {
      dispatch({ type: "group_turn", turn: push });
      recheckChoices(push.groupId, seq);
    },
    task_updated: (push) => dispatch({ type: "task_updated", task: push.task }),
    // 审批、交接的推送只改卡，角标等补拉回来的服务端数。
    approval_updated: (push) => {
      dispatch({ type: "approval_pushed", approval: push.approval });
      refreshPendingCounts();
      bumpToday();
    },
    grant_deleted: (push) => dispatch({ type: "grant_deleted", grantId: push.grantId }),
    handoff_updated: (push) => {
      // 交接是 Bot 等 Bot，不是等你。它记角标，但不该弹一个系统通知把你从别的事上拽回来。
      dispatch({ type: "handoff_pushed", handoff: push.handoff });
      refreshPendingCounts();
    },
    // 项目页折叠行的例行三态读项目快照，跟着 todayVersion 重拉。
    routine_updated: (push, seq) => {
      dispatch({ type: "routine_upserted", routine: push.routine, seq });
      bumpToday();
    },
    routine_deleted: (push, seq) => {
      dispatch({ type: "routine_removed", routineId: push.routineId, seq });
      bumpToday();
    },
    skill_updated: (push, seq) => dispatch({ type: "skill_upserted", skill: push.skill, seq }),
    skill_deleted: (push, seq) => dispatch({ type: "skill_removed", botId: push.botId, skillId: push.skillId, seq }),
    preference_updated: (push, seq) => dispatch({ type: "preference_upserted", preference: push.preference, seq }),
    preference_deleted: (push, seq) =>
      dispatch({ type: "preference_removed", botId: push.botId, preferenceId: push.preferenceId, seq }),
    brand_updated: (push) => dispatch({ type: "brand_set", brand: push.brand }),
    live_session: (push, seq) => dispatch({ type: "live_upserted", session: push.session, seq }),
    live_closed: (push, seq) => dispatch({ type: "live_removed", liveId: push.liveId, seq }),
    poker_table_updated: (push) => dispatch({ type: "poker_table_set", table: push.table }),
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
    // 换过去的那一刻这一轮可能还在原来那台上跑，拉过的群重拉一趟拿 runningOn。
    computer_choice_updated: (push, seq) => {
      dispatch({ type: "computer_choice_set", groupId: push.groupId, botId: push.botId, kind: push.kind, seq });
      if (mine()?.computerChoices.rows[push.groupId] !== undefined) reloadChoices(push.groupId, seq);
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
