import type { BotId, Group, GroupId, Message, MessageId, TopicTask } from "@baize/shared";
import { shelfLoad, shelfRow, shelfWrite, type Seq } from "./stamped.js";
import type { Action, Conversation, Delta, MessageGap, ReadyState } from "./types.js";

// 消息那一架按 revision 取号，不按客户端收到的先后：同一条消息经推送、历史几条路到，谁先到都只认服务端写得更晚的那份。
// 加一是因为新建的消息 revision 为 0，而没见过的条目号按 0 算，要严格更大才写得进。
const messageStamp = (message: Message): Seq => (message.revision + 1) as Seq;

const signerOf = (conversation: Conversation | undefined, known: Message | undefined): BotId | null => {
  if (known?.body.kind === "bot") return known.body.botId;
  if (conversation === undefined) return null;
  return conversation.kind === "solo" ? conversation.botId : conversation.task.currentBotId;
};

// 没有空壳的 delta 没有服务端时间可用。取群里已知最新一条的时间，配合稳定排序落在已知消息之后，不受本地时钟快慢影响；
// 群里一条都没有才退回本地时间。同 id 的完整消息到了会整条覆盖，以服务端时间为准。
const latestKnownAt = (state: ReadyState, groupId: GroupId): string | undefined =>
  (state.messages.rows[groupId] ?? state.messages.early[groupId] ?? []).reduce<string | undefined>(
    (latest, message) =>
      latest === undefined || Date.parse(message.createdAt) > Date.parse(latest) ? message.createdAt : latest,
    undefined,
  );

const streamedInto = (previous: Message | undefined, botId: BotId, delta: Delta, fallbackAt: string): Message => {
  const grown = previous?.body.kind === "bot" ? previous.body : null;
  return {
    id: delta.messageId,
    groupId: delta.groupId,
    body: { kind: "bot", botId, text: (grown?.text ?? "") + delta.delta, streaming: !delta.done },
    createdAt: previous?.createdAt ?? fallbackAt,
    revision: delta.revision,
  };
};

// 晚到的旧消息不顶掉 lastMessage：同 id 的要 revision 比现在这份新，不同 id 的看时间不早于现在这条。
const supersedes = (current: Message | null, candidate: Message): boolean =>
  current === null ||
  (current.id === candidate.id
    ? candidate.revision > current.revision
    : Date.parse(candidate.createdAt) >= Date.parse(current.createdAt));

const touchGroup = (conversations: Conversation[], groupId: GroupId, rows: readonly Message[]): Conversation[] =>
  conversations.map((c) => {
    if (c.groupId !== groupId) return c;
    const lastMessage = rows.reduce((current, row) => (supersedes(current, row) ? row : current), c.lastMessage);
    return lastMessage === c.lastMessage ? c : { ...c, lastMessage };
  });

// 漏档的消息拿到了不旧于漏档那一版的完整消息，这条就补齐了。
const closeGaps = (gaps: Gaps, rows: readonly Message[]): Gaps => {
  const satisfied = rows.filter((row) => (gaps[row.id]?.revision ?? Infinity) <= row.revision);
  if (satisfied.length === 0) return gaps;
  const next = { ...gaps };
  for (const row of satisfied) delete next[row.id];
  return next;
};

type Gaps = ReadyState["messageGaps"];

// 补不齐的漏档：消息没了、群没了或群里没有 Bot 了，单拉只会回 404，留着只会被别的漏档带着反复去拉。
const dropGaps = (gaps: Gaps, doomed: (gap: MessageGap, messageId: MessageId) => boolean): Gaps => {
  const entries = Object.entries(gaps) as [MessageId, MessageGap][];
  if (!entries.some(([id, gap]) => doomed(gap, id))) return gaps;
  return Object.fromEntries(entries.filter(([id, gap]) => !doomed(gap, id))) as Gaps;
};

// 单拉失败到了上限的漏档，在重连或重拉历史时重新给一轮机会。每轮都要外部事件触发，不会自己无限重拉。
export const rearmGaps = (gaps: Gaps, groupId?: GroupId): Gaps => {
  const entries = Object.entries(gaps) as [MessageId, MessageGap][];
  const rearmed = (gap: MessageGap) => gap.attempts > 0 && (groupId === undefined || gap.groupId === groupId);
  if (!entries.some(([, gap]) => rearmed(gap))) return gaps;
  return Object.fromEntries(entries.map(([id, gap]) => [id, rearmed(gap) ? { ...gap, attempts: 0 } : gap])) as Gaps;
};

// 没拉过历史的群，推送先记进 messages.early，历史到了再合并，见 stamped.ts 的 Shelf。
// 群有没有拉过历史只看 messagesLoadedAt，推送不算。shelfWrite 比不过时也回新对象，写没写进去看架上是不是这一份。
const written = (state: ReadyState, groupId: GroupId, message: Message): ReadyState => {
  const messages = shelfWrite(state.messages, groupId, messageStamp(message), message);
  if (shelfRow(messages, groupId, message.id) !== message) return state;
  return {
    ...state,
    messages,
    conversations: touchGroup(state.conversations, groupId, [message]),
    messageGaps: closeGaps(state.messageGaps, [message]),
  };
};

const conversationOf = (group: Group, task: TopicTask): Conversation => {
  const base = { groupId: group.id, lastMessage: null, pendingApprovals: 0, pendingHandoffs: 0 };
  if (group.kind === "solo") return { kind: "solo", botId: group.botIds[0], ...base };
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
      const deletedBotIds = [...state.deletedBotIds, action.botId];
      // 单聊跟着 Bot 一起删了；团队群的 botIds 不随删 Bot 更新，成员都确认删了才是空群，服务端也不再给它的消息。
      const gone = new Set(
        state.conversations
          .filter((c) =>
            c.kind === "solo" ? c.botId === action.botId : c.botIds.every((id) => deletedBotIds.includes(id)),
          )
          .map((c) => c.groupId),
      );
      return {
        ...state,
        bots,
        conversations,
        deletedBotIds,
        messageGaps: dropGaps(state.messageGaps, (gap) => gone.has(gap.groupId)),
      };
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
      // 历史不是全量，本地有它没有的消息照留。侧栏的最近一条和漏档记录跟着这份历史一起刷新。
      const messages = shelfLoad(state.messages, action.groupId, messageStamp, action.messages, "kept");
      const rows = messages.rows[action.groupId] ?? [];
      return {
        ...state,
        messages,
        messagesLoadedAt: { ...state.messagesLoadedAt, [action.groupId]: action.seq },
        conversations: touchGroup(state.conversations, action.groupId, rows),
        messageGaps: rearmGaps(closeGaps(state.messageGaps, rows), action.groupId),
      };
    }
    case "message_upserted":
      return written(state, action.message.groupId, action.message);
    case "message_delta": {
      const conversation = state.conversations.find((c) => c.groupId === action.groupId);
      // 这条消息手上最新的一份：架上的和侧栏的取 revision 大的。都没有就是没见过，按 0 版空壳算，第一段 delta 是 1 版。
      const shelved = shelfRow(state.messages, action.groupId, action.messageId);
      const summary = conversation?.lastMessage?.id === action.messageId ? conversation.lastMessage : undefined;
      const base = summary !== undefined && summary.revision > (shelved?.revision ?? -1) ? summary : shelved;
      const known = base?.revision ?? 0;
      // delta 只接在紧挨着的上一版上。不比手上的新，是晚到的旧帧或重复帧，丢掉；比它大不止一，中间漏了，
      // 接上去正文就缺一段，不接，记下这一条要单独拉回来：它可能早已落出历史最近的那一页。
      if (action.revision <= known) return state;
      if (action.revision > known + 1) {
        const known = state.messageGaps[action.messageId];
        const revision = Math.max(action.revision, known?.revision ?? 0);
        const gap = { groupId: action.groupId, revision, seq: action.seq, attempts: known?.attempts ?? 0 };
        return { ...state, messageGaps: { ...state.messageGaps, [action.messageId]: gap } };
      }
      const botId = signerOf(conversation, base);
      if (botId === null) return state;
      const fallbackAt = latestKnownAt(state, action.groupId) ?? new Date().toISOString();
      return written(state, action.groupId, streamedInto(base, botId, action, fallbackAt));
    }
    case "message_gap_failed": {
      const gap = state.messageGaps[action.messageId];
      if (gap === undefined) return state;
      return {
        ...state,
        messageGaps: { ...state.messageGaps, [action.messageId]: { ...gap, attempts: gap.attempts + 1 } },
      };
    }
    case "message_gone":
      return { ...state, messageGaps: dropGaps(state.messageGaps, (_, id) => id === action.messageId) };
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
