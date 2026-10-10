import type { Bot, BotId, GroupId } from "@baize/shared";
import type { Conversation } from "../../state/app.js";

// 改例行、新建例行都回主助理的对话，预填一句话。预填跟着这一次跳转的 location state 走，刷新不会再填一遍。
export type PrefillState = { prefill: string };

export const prefillState = (text: string): PrefillState => ({ prefill: text });

export const prefillOf = (state: unknown): string | null =>
  typeof state === "object" && state !== null && "prefill" in state && typeof state.prefill === "string"
    ? state.prefill
    : null;

export const editPrefill = (name: string) => `把「${name}」改成`;

export const NEW_PREFILL = "加一条例行：";

export const assistantGroupOf = (conversations: readonly Conversation[], bots: Record<BotId, Bot>): GroupId | null =>
  conversations.find((c) => c.kind === "solo" && bots[c.botId]?.role === "assistant")?.groupId ?? null;
