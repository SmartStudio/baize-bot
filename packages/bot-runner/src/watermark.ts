import { type ControlToAgent, MessageId } from "@baize/shared";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;
type ContextLine = PromptMessage["context"][number];

// 水位记在会话 JSONL 里，和模型看到的历史同生同灭：会话目录清空，水位也跟着没了。
const WATERMARK_TYPE = "baize.context-watermark";
// messageId 是这次的触发消息，它已经作为「当前这条」拼过。contextEnd 是这次上下文的最后一条：
// 多 Bot 回合里后开口的 Bot 拿到的上下文带着触发之后的队友发言，只记触发会让这些下一轮再出现一次。
// 旧会话只有 messageId，记的是上下文最后一条，按同样的规矩从它之后拼。
const Watermark = z.object({ messageId: MessageId, contextEnd: MessageId.optional() });
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

/** 水位之后的消息。水位记的几条都不在这批里（没有水位，或中间来的消息多到把它挤出了窗口），整批都算新的。 */
export function contextSince(context: readonly ContextLine[], watermark: Watermark | null): readonly ContextLine[] {
  const seen = Math.max(
    ...[watermark?.messageId, watermark?.contextEnd].map((id) =>
      id === undefined ? -1 : context.findIndex((line) => line.messageId === id),
    ),
  );
  return context.slice(seen + 1);
}

export function recordWatermark(sessions: SessionManager, message: PromptMessage, previous: Watermark | null): void {
  const contextEnd = message.context.at(-1)?.messageId;
  if (previous?.messageId === message.messageId && previous.contextEnd === contextEnd) return;
  sessions.appendCustomEntry(WATERMARK_TYPE, {
    messageId: message.messageId,
    ...(contextEnd === undefined ? {} : { contextEnd }),
  } satisfies Watermark);
}
