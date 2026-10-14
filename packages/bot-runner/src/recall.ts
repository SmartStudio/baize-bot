import {
  RecallRequest,
  RecallResponse,
  RECALL_QUERY_LENGTH,
  recallPlaceholder,
  type RecallEntry,
  type RunId,
} from "@baize/shared";
import { Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";

export const RECALL_TOOL = "recall_memory";
export type Recalls = Map<string, readonly RecallEntry[]>;

interface RecallRun {
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly gateway: { readonly baseUrl: string; readonly apiKey: string };
  readonly headers: Readonly<Record<string, string>>;
}

export function createRecallTool(options: {
  readonly recalls: Recalls;
  readonly live: () => RecallRun | null;
}): RunnerTool {
  return {
    name: RECALL_TOOL,
    label: "查以前的记录",
    description:
      "按关键词查你以前在其他群里说过、听过的公开聊天记录，返回带群名、时间和角色的摘录。内容只在当前这一轮可见。",
    parameters: Type.Object(
      { query: Type.String({ minLength: 1, maxLength: RECALL_QUERY_LENGTH }) },
      { additionalProperties: false },
    ),
    execute: async (callId, raw, signal) => {
      options.recalls.delete(callId);
      const params = RecallRequest.safeParse(raw);
      if (!params.success) throw new Error(`查询词不能为空，最多 ${RECALL_QUERY_LENGTH} 字，只传 query。`);
      const run = options.live();
      if (run === null) throw new Error("这次召回不属于任何一次运行，不能查以前的记录。");
      const abort = AbortSignal.any([
        run.signal,
        AbortSignal.timeout(60_000),
        ...(signal === undefined ? [] : [signal]),
      ]);
      abort.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(new URL("/hub/v1/recall", run.gateway.baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${run.gateway.apiKey}`,
            "content-type": "application/json",
            ...run.headers,
          },
          body: JSON.stringify(params.data),
          signal: abort,
          redirect: "error",
        });
      } catch (error) {
        if (abort.aborted) throw error;
        throw new Error("连不上白泽中枢，这次没查到以前的记录。", { cause: error });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`白泽中枢拒绝了这次召回（${response.status}），请稍后重试。`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("白泽中枢的召回结果格式不对，这次没查到以前的记录。");
      }
      const parsed = RecallResponse.safeParse(body);
      if (!parsed.success) throw new Error("白泽中枢的召回结果格式不对，这次没查到以前的记录。");
      abort.throwIfAborted();
      if (options.live()?.runId !== run.runId) throw new Error("这轮运行已经结束，召回结果已作废。");
      options.recalls.set(callId, parsed.data);
      return { content: [{ type: "text", text: recallPlaceholder(parsed.data.length) }], details: {} };
    },
  };
}

export function expandRecalls<
  M extends {
    readonly role: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly content?: unknown;
  },
>(messages: readonly M[], recalls: ReadonlyMap<string, readonly RecallEntry[]>): M[] {
  const expanded = [...messages];
  const seen = new Set<string>();
  for (let index = expanded.length - 1; index >= 0; index -= 1) {
    const message = expanded[index];
    if (message?.role !== "toolResult" || message.toolName !== RECALL_TOOL || message.toolCallId === undefined)
      continue;
    const entries = recalls.get(message.toolCallId);
    if (entries === undefined || seen.has(message.toolCallId)) continue;
    // 不同 run 的上游可能复用 callId；只展开最新那条，旧会话条目保持占位。
    seen.add(message.toolCallId);
    expanded[index] = {
      ...message,
      content: [
        {
          type: "text",
          text:
            entries.length === 0
              ? recallPlaceholder(0)
              : entries
                  .map(
                    (entry) =>
                      `群：${entry.groupTitle}（${entry.groupId}）\n时间：${entry.at}\n角色：${entry.kind}\n摘录：${entry.excerpt}`,
                  )
                  .join("\n\n"),
        },
      ],
    };
  }
  return expanded;
}
