// 假上游。按脚本产出 OpenAI chat completions 的流式分片，形状照 openai 的 SSE 约定。
// 搬自 spikes/pi-embed/src/openai-sse.ts，一字未改。测试不打付费接口。

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly content?: unknown;
    readonly tool_call_id?: string;
  }>;
  readonly stream?: boolean;
}

export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ScriptedTurn {
  readonly textChunks: readonly string[];
  readonly toolCall?: ScriptedToolCall;
  readonly usage: { readonly input: number; readonly output: number };
}

/** 一次 chat/completions 请求产出的 SSE data 载荷序列，最后一条是 "[DONE]"。 */
export type Upstream = (req: ChatCompletionRequest, key: string) => AsyncIterable<string>;

const chunk = (model: string, delta: unknown, finishReason: string | null): string =>
  JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1758153600,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

export function scriptedUpstream(script: (req: ChatCompletionRequest, key: string) => ScriptedTurn): Upstream {
  return async function* (req, key) {
    const turn = script(req, key);
    yield chunk(req.model, { role: "assistant" }, null);
    for (const text of turn.textChunks) {
      yield chunk(req.model, { content: text }, null);
    }
    if (turn.toolCall) {
      const serialized = JSON.stringify(turn.toolCall.args);
      yield chunk(
        req.model,
        {
          tool_calls: [
            { index: 0, id: turn.toolCall.id, type: "function", function: { name: turn.toolCall.name, arguments: "" } },
          ],
        },
        null,
      );
      yield chunk(req.model, { tool_calls: [{ index: 0, function: { arguments: serialized } }] }, null);
      yield chunk(req.model, {}, "tool_calls");
    } else {
      yield chunk(req.model, {}, "stop");
    }
    yield JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1758153600,
      model: req.model,
      choices: [],
      usage: {
        prompt_tokens: turn.usage.input,
        completion_tokens: turn.usage.output,
        total_tokens: turn.usage.input + turn.usage.output,
      },
    });
    yield "[DONE]";
  };
}

/** 请求里出现过工具结果，说明这是工具调用之后的那一轮。 */
export const isFollowUpTurn = (req: ChatCompletionRequest): boolean => req.messages.some((m) => m.role === "tool");
