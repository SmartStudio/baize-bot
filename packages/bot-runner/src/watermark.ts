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

/** 只留这一批和触发消息：窗口只往后滑，掉出窗口的行不会再回来，水位因此不涨。 */
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
