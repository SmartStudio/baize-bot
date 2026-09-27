import type { BotId, Group, GroupId, Message, TopicTask } from "@baize/shared";
import { shelfLoad, shelfRow, shelfWrite, type Seq } from "./stamped.js";
import type { Action, Conversation, Delta, ReadyState } from "./types.js";

const signerOf = (conversation: Conversation | undefined, known: Message | undefined): BotId | null => {
  if (known?.body.kind === "bot") return known.body.botId;
  if (conversation === undefined) return null;
  return conversation.kind === "solo" ? conversation.botId : conversation.task.currentBotId;
};

const streamedInto = (previous: Message | undefined, botId: BotId, delta: Delta): Message => {
  const grown = previous?.body.kind === "bot" ? previous.body : null;
  return {
    id: delta.messageId,
    groupId: delta.groupId,
    body: { kind: "bot", botId, text: (grown?.text ?? "") + delta.delta, streaming: !delta.done },
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
};

const touchGroup = (conversations: Conversation[], groupId: GroupId, patch: { lastMessage: Message }): Conversation[] =>
  conversations.map((c) => (c.groupId === groupId ? { ...c, ...patch } : c));

// 没拉过历史的群，推送先记进 messages.early，历史到了再合并，见 stamped.ts 的 Shelf。
// 群有没有拉过历史只看 messagesLoadedAt，推送不算。
const written = (state: ReadyState, groupId: GroupId, message: Message, seq: Seq): ReadyState => {
  const messages = shelfWrite(state.messages, groupId, seq, message);
  if (messages.stamps[message.id] !== seq) return state;
  return {
    ...state,
    messages,
    conversations: touchGroup(state.conversations, groupId, { lastMessage: message }),
  };
};

// Group 不带 kind。建出来那一刻只有单聊是一个成员、没有首席：手建的群至少两个 Bot，项目群的首席是主助理。
// 之后删队员删到只剩一个的项目群不再推 group_created，所以这条只在建群推送上用。
const conversationOf = (group: Group, task: TopicTask): Conversation => {
  const [only] = group.botIds;
  const base = { groupId: group.id, lastMessage: null, pendingApprovals: 0, pendingHandoffs: 0 };
  if (only !== undefined && group.botIds.length === 1 && group.chiefBotId === null)
    return { kind: "solo", botId: only, ...base };
  return { kind: "team", botIds: group.botIds, chiefBotId: group.chiefBotId, task, ...base };
};

export const reduceGroups = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "bot_created": {
      const bots = { ...state.bots, [action.bot.id]: action.bot };
      if (state.conversations.some((c) => c.groupId === action.groupId)) return { ...state, bots };
      return {
        ...state,
        bots,
        conversations: [
          ...state.conversations,
          {
            kind: "solo",
            groupId: action.groupId,
            botId: action.bot.id,
            lastMessage: null,
            pendingApprovals: 0,
            pendingHandoffs: 0,
          },
        ],
      };
    }
    case "bot_updated":
      return { ...state, bots: { ...state.bots, [action.bot.id]: action.bot } };
    case "bot_removed": {
      const bots = { ...state.bots };
      delete bots[action.botId];
      const conversations = state.conversations.filter((c) => !(c.kind === "solo" && c.botId === action.botId));
      return { ...state, bots, conversations };
    }
    case "group_created": {
      if (state.conversations.some((c) => c.groupId === action.group.id)) return state;
      const joined = conversationOf(action.group, action.task);
      return {
        ...state,
        conversations: [...state.conversations, joined],
      };
    }
    case "group_updated":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.kind === "team" && c.groupId === action.group.id
            ? { ...c, botIds: action.group.botIds, chiefBotId: action.group.chiefBotId }
            : c,
        ),
      };
    case "group_turn": {
      const { turn } = action;
      if (turn.epoch < (state.turnEpochs[turn.groupId] ?? -1)) return state;
      const groupTurns = { ...state.groupTurns };
      if (turn.current === null && turn.next.length === 0) delete groupTurns[turn.groupId];
      else groupTurns[turn.groupId] = turn;
      return {
        ...state,
        groupTurns,
        turnEpochs: { ...state.turnEpochs, [turn.groupId]: turn.epoch },
      };
    }
    case "turns_cleared":
      return { ...state, groupTurns: {}, turnEpochs: {} };
    case "task_updated":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.kind === "team" && c.task.id === action.task.id ? { ...c, task: action.task } : c,
        ),
      };
    case "messages_set": {
      // 历史不是全量，本地有它没有的消息照留。
      return {
        ...state,
        messages: shelfLoad(state.messages, action.groupId, action.seq, action.messages, "kept"),
        messagesLoadedAt: { ...state.messagesLoadedAt, [action.groupId]: action.seq },
      };
    }
    case "message_upserted":
      return written(state, action.message.groupId, action.message, action.seq);
    case "message_delta": {
      const conversation = state.conversations.find((c) => c.groupId === action.groupId);
      const previous = shelfRow(state.messages, action.groupId, action.messageId);
      const botId = signerOf(conversation, previous);
      if (botId === null) return state;
      const grown = streamedInto(previous, botId, action);
      // 历史没拉回来、手里也没有这条的空壳，说明它在历史请求之前就开始了，这段 delta 前面缺的正文只有历史里有。
      // 记下来只会拿半截盖掉历史，所以只更侧栏。
      if (state.messages.rows[action.groupId] === undefined && previous === undefined)
        return { ...state, conversations: touchGroup(state.conversations, action.groupId, { lastMessage: grown }) };
      return written(state, action.groupId, grown, action.seq);
    }
    case "pending_counts_loaded": {
      const counts = new Map(
        [...action.bots, ...action.groups].map((item) => [
          "bot" in item ? item.groupId : item.group.id,
          { pendingApprovals: item.pendingApprovals, pendingHandoffs: item.pendingHandoffs },
        ]),
      );
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          const current = counts.get(conversation.groupId);
          return current === undefined ? conversation : { ...conversation, ...current };
        }),
      };
    }
    default:
      return state;
  }
};
