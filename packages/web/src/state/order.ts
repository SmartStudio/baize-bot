import type { Message } from "@baize/shared";

// 消息先后以服务端写下的时间为准，到达顺序不算。同一毫秒的返回 0，由 toSorted 的稳定性保留输入顺序：
// 群历史、推送、项目页的 known 都已是服务端给的次序，id 是随机 UUID，拿它破平局会把已排好的同毫秒消息翻过来。
// 唯一例外是用户自己的话：它随发送的回包到，晚于它引出的推送，同一毫秒时到达顺序正好颠倒，所以让它排前。
export const byCreatedAt = (left: Message, right: Message): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
  Number(right.body.kind === "user") - Number(left.body.kind === "user");
