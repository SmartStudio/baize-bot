import { randomUUID } from "node:crypto";
import { type AgentToControl, type ControlToAgent, MessageId } from "@baize/shared";

export type ConfigMessage = Extract<ControlToAgent, { type: "config" }>;
export type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;

export interface RunnerConfig {
  readonly bots: ConfigMessage["bots"];
  readonly tools: ConfigMessage["tools"];
  readonly modelGateway: ConfigMessage["modelGateway"];
  readonly send: (message: AgentToControl) => void;
}

export interface Runner {
  prompt(message: PromptMessage): Promise<void>;
  stop(): Promise<void>;
}

// Pi 还没接入，prompt 一律回这一条。接入后这个常量和它的测试一起删。
export const PLACEHOLDER_REPLY = "运行器骨架已就位，Pi 会话还没接入，这条是占位回复。";

type RunnerState = "ready" | "stopped";

export function createRunner(config: RunnerConfig): Runner {
  let state: RunnerState = "ready";

  return {
    async prompt(message) {
      if (state === "stopped") return;
      config.send({
        type: "bot_text",
        runId: message.runId,
        botId: message.botId,
        groupId: message.groupId,
        messageId: MessageId.parse(randomUUID()),
        delta: PLACEHOLDER_REPLY,
        done: true,
      });
    },
    async stop() {
      state = "stopped";
    },
  };
}
