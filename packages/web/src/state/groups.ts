import type { BotId, GroupId, Message } from "@baize/shared";
import type { Action, Conversation, Delta, ReadyState } from "./types.js";

const upsert = (list: Message[], message: Message): Message[] =>
  list.some((m) => m.id === message.id) ? list.map((m) => (m.id === message.id ? message : m)) : [...list, message];

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
      const joined: Conversation = {
        kind: "team",
        groupId: action.group.id,
        botIds: action.group.botIds,
        chiefBotId: action.group.chiefBotId,
        task: action.task,
        lastMessage: null,
        pendingApprovals: 0,
        pendingHandoffs: 0,
      };
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
    case "messages_set":
      // 拉取在飞的时候推回来的消息已经在本地了，本地那份可能还带着历史里没有的流式正文，所以让它压住返回的历史。
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.groupId]: (state.messages[action.groupId] ?? []).reduce(upsert, action.messages),
        },
      };
    case "message_upserted": {
      const groupId = action.message.groupId;
      const known = state.messages[groupId];
      return {
        ...state,
        // messages 里有没有这个键就是「这组历史拉过没有」，所以没拉过的组只更侧栏摘要，不能凭一条推送造出一份假历史。
        messages:
          known === undefined ? state.messages : { ...state.messages, [groupId]: upsert(known, action.message) },
        conversations: touchGroup(state.conversations, groupId, { lastMessage: action.message }),
      };
    }
    case "message_delta": {
      const conversation = state.conversations.find((c) => c.groupId === action.groupId);
      const known = state.messages[action.groupId];
      const botId = signerOf(
        conversation,
        known?.find((m) => m.id === action.messageId),
      );
      if (botId === null) return state;
      const grown = streamedInto(
        known?.find((m) => m.id === action.messageId),
        botId,
        action,
      );
      return {
        ...state,
        messages: known === undefined ? state.messages : { ...state.messages, [action.groupId]: upsert(known, grown) },
        conversations: touchGroup(state.conversations, action.groupId, { lastMessage: grown }),
      };
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
