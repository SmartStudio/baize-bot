import type { AgentToControl, ControlToAgent } from "@baize/shared";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;

/**
 * 牌桌 prompt 自成一套，不走 composePrompt 的群聊拼法：玩家看自己的 SeatView 和公共日志，
 * 解说看用户视角加问题，复盘看整场的手牌。第 3 期形状提交只占位，U-牌桌 填实。
 */
export function composeTablePrompt(_message: PromptMessage): string {
  return "";
}

/**
 * 牌桌工具：玩家角色的 poker_act（出牌，带一句台词），复盘角色的 poker_review。
 * 按 ActiveRun 上的牌桌角色决定给哪个，解说没有牌桌工具。第 3 期形状提交回空，U-牌桌 填实。
 */
export function createTableTools(_options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  return [];
}
