import { type ControlToAgent, MessageId } from "@baize/shared";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;
type ContextLine = PromptMessage["context"][number];

// 水位记在会话 JSONL 里，和模型看到的历史同生同灭：会话目录清空，水位也跟着没了。
const WATERMARK_TYPE = "baize.context-watermark";
// 记的是上一轮看过的行，不是「看到哪一条为止」：别的 Bot 正在流的那条可能排在触发消息前面，
// 游标一越过触发就把它说完的整句跳过了。settled 是定稿的行加上触发消息，下一轮不再拼；
// partial 是没定稿的行和当时看到的字，下一轮字变了才再拼一次。
// 旧会话里的 { messageId, contextEnd } 对不上这个形状，按没有水位处理，整批照拼。
const Watermark = z.object({
  settled: z.array(MessageId),
  partial: z.array(z.object({ messageId: MessageId, text: z.string() })),
});
export type Watermark = z.infer<typeof Watermark>;

/** 这份会话最后一条水位。JSONL 是外部输入，对不上形状就当没有水位。 */
export function readWatermark(sessions: SessionManager): Watermark | null {
  for (const entry of sessions.getBranch().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== WATERMARK_TYPE) continue;
    const parsed = Watermark.safeParse(entry.data);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/** 这一批里上一轮没看过的行，以及看的时候还没说完、之后又长了的行。 */
export function contextSince(context: readonly ContextLine[], watermark: Watermark | null): readonly ContextLine[] {
  if (watermark === null) return context;
  const settled = new Set(watermark.settled);
  const partial = new Map(watermark.partial.map((line) => [line.messageId, line.text]));
  return context.filter((line) => !settled.has(line.messageId) && partial.get(line.messageId) !== line.text);
}

/** 只留这一批和触发消息：控制面在窗口前接着送的是它记下的上一次没定稿的行，定稿以后掉出这一批的行不会再回来，水位因此不涨。 */
export function recordWatermark(sessions: SessionManager, message: PromptMessage, previous: Watermark | null): void {
  const next: Watermark = {
    settled: [
      ...new Set([...message.context.filter((line) => line.settled).map((line) => line.messageId), message.messageId]),
    ],
    partial: message.context.filter((line) => !line.settled).map(({ messageId, text }) => ({ messageId, text })),
  };
  if (previous !== null && JSON.stringify(previous) === JSON.stringify(next)) return;
  sessions.appendCustomEntry(WATERMARK_TYPE, next satisfies Watermark);
}

// 偏好和手册不进会话历史，每次请求都整份放在系统提示里，所以不需要「送到哪了」的水位。
// 这里只记模型有没有见过它们：见过的东西后来没了，得明确说作废，压缩摘要和历史里的旧原文才不会继续生效；
// 从没见过就什么都不说，首次空会话的请求和基底逐字一致。记号只增不减，压缩也不抹掉。
const MEMORY_SHOWN_TYPE = "baize.memory-shown";
const MemoryShown = z.object({ brand: z.boolean(), preferences: z.boolean() });
export type MemoryShown = z.infer<typeof MemoryShown>;
const NEVER_SHOWN: MemoryShown = { brand: false, preferences: false };

/** 这份会话里模型见没见过手册、见没见过偏好。JSONL 是外部输入，对不上形状就当没见过。 */
export function readMemoryShown(sessions: SessionManager): MemoryShown {
  for (const entry of sessions.getBranch().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== MEMORY_SHOWN_TYPE) continue;
    const parsed = MemoryShown.safeParse(entry.data);
    return parsed.success ? parsed.data : NEVER_SHOWN;
  }
  return NEVER_SHOWN;
}

export function recordMemoryShown(sessions: SessionManager, next: MemoryShown, previous: MemoryShown): void {
  if (previous.brand === next.brand && previous.preferences === next.preferences) return;
  sessions.appendCustomEntry(MEMORY_SHOWN_TYPE, next satisfies MemoryShown);
}
