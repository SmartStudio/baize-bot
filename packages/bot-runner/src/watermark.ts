import { type ControlToAgent, MessageId } from "@baize/shared";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

type ContextLine = Extract<ControlToAgent, { type: "prompt" }>["context"][number];

// 水位记在会话 JSONL 里，和模型看到的历史同生同灭：会话目录清空，水位也跟着没了。
const WATERMARK_TYPE = "baize.context-watermark";
const Watermark = z.object({ messageId: MessageId });

/** 这份会话上次拼进 prompt 的最后一条群消息。JSONL 是外部输入，对不上形状就当没有水位。 */
export function readWatermark(sessions: SessionManager): MessageId | null {
  for (const entry of sessions.getBranch().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== WATERMARK_TYPE) continue;
    const parsed = Watermark.safeParse(entry.data);
    return parsed.success ? parsed.data.messageId : null;
  }
  return null;
}

/** 水位之后的消息。水位不在这批里（没有水位，或中间来的消息多到把它挤出了窗口），整批都算新的。 */
export function contextSince(context: readonly ContextLine[], watermark: MessageId | null): readonly ContextLine[] {
  const seen = context.findIndex((line) => line.messageId === watermark);
  return seen === -1 ? context : context.slice(seen + 1);
}

export function recordWatermark(
  sessions: SessionManager,
  context: readonly ContextLine[],
  previous: MessageId | null,
): void {
  const last = context.at(-1)?.messageId;
  if (last === undefined || last === previous) return;
  sessions.appendCustomEntry(WATERMARK_TYPE, { messageId: last } satisfies z.infer<typeof Watermark>);
}
