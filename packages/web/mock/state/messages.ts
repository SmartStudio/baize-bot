import { Message, MessageId, type MessageBody } from "@baize/shared";
import { messagesByGroupId, nextSuffix } from "./store.js";

// 测试钩子：按消息记接下来几次单拉回 503，造「单拉失败了一次」。
export const messageFetchFaults = new Map<string, number>();

export const appendMessage = (
  groupId: string,
  body: MessageBody,
  {
    createdAt = new Date().toISOString(),
    id = `msg_${nextSuffix()}`,
    revision = 0,
  }: { createdAt?: string | undefined; id?: string | undefined; revision?: number | undefined } = {},
): Message => {
  const message = Message.parse({
    id: MessageId.parse(id),
    groupId,
    body,
    createdAt,
    revision,
    visibleTo: null,
  });
  const list = messagesByGroupId.get(groupId);
  if (list) list.push(message);
  else messagesByGroupId.set(groupId, [message]);
  return message;
};

export const rewriteMessage = (groupId: string, id: MessageId, body: MessageBody): Message => {
  const list = messagesByGroupId.get(groupId) ?? [];
  const at = list.findIndex((message) => message.id === id);
  const previous = list[at];
  if (previous === undefined) throw new Error(`消息 ${id} 不在 ${groupId} 里，mock 状态坏了`);
  const next = Message.parse({ ...previous, body, revision: previous.revision + 1 });
  list[at] = next;
  return next;
};

export const findMessage = (id: string): Message | null => {
  for (const list of messagesByGroupId.values()) {
    const found = list.find((message) => message.id === id);
    if (found !== undefined) return found;
  }
  return null;
};

export const writeMessageBody = (id: string, body: MessageBody): Message | null => {
  const message = findMessage(id);
  return message === null ? null : rewriteMessage(message.groupId, message.id, body);
};

export const lastMessageOf = (groupId: string): Message | null => (messagesByGroupId.get(groupId) ?? []).at(-1) ?? null;
