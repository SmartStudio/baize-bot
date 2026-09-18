/** 一个群里两条用户消息之间，Bot 发起的 @ 最多派这么多次。 */
export const MENTION_LOOP_LIMIT = 10;

/**
 * Bot 之间 @ 的防循环计数。计数在内存里，进程重启归零。
 * 限额是「两条用户消息之间」，所以用户一说话就归零。
 */
export class MentionLoopGuard {
  readonly #counts = new Map<string, number>();

  /** 用户发消息时调用。 */
  reset(groupId: string): void {
    this.#counts.delete(groupId);
  }

  /** 记一条 Bot 发起的 @。allow 还能派；stop 是第一条越线的，群里留一句话；silent 是越线之后的，只是不派。 */
  record(groupId: string): "allow" | "stop" | "silent" {
    const count = (this.#counts.get(groupId) ?? 0) + 1;
    this.#counts.set(groupId, count);
    if (count <= MENTION_LOOP_LIMIT) return "allow";
    return count === MENTION_LOOP_LIMIT + 1 ? "stop" : "silent";
  }
}
