import { ComputerKind, SwitchComputerResponse, type ComputerView, type RunId } from "@baize/shared";
import { Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";

const NAME: Readonly<Record<ComputerKind, string>> = { local: "主人的电脑", remote: "云电脑" };

export const SWITCH_COMPUTER_TOOL = "switch_computer";

/** 换电脑的调用和别的工具挤在同一批里时挡下它：别的工具可能正在改东西，换过去那边看不到。 */
export const SWITCH_BATCH_REASON = "换电脑要单独调用，等这一批工具做完再换";

/** 已经请求换电脑之后这一轮再调任何工具都挡下，模型该停下让这一轮结束。 */
export function switchedReason(kind: ComputerKind): string {
  return `已经请求换到${NAME[kind]}，这一轮到此为止，换好后自动接着做。`;
}

export interface SwitchComputerRun {
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly gateway: { readonly baseUrl: string; readonly apiKey: string };
  readonly headers: Readonly<Record<string, string>>;
  readonly markSwitching: (kind: ComputerKind) => void;
}

/**
 * Bot 自己把这个群换到另一台电脑。控制面回 switching 就立起这一轮的换机标记并让模型停下；
 * refused 的文案原样抛成工具错误。每台电脑都注册，Mac 单机用户调了会得到「没有云电脑」。
 */
export function switchComputerTool(options: { readonly live: () => SwitchComputerRun | null }): RunnerTool {
  return {
    name: SWITCH_COMPUTER_TOOL,
    label: "换电脑",
    description:
      "把这个群换到另一台电脑上接着做：kind 填 remote 是云电脑，local 是主人的电脑。换成功后这一轮到此结束，换好后会在那台上自动接着做。要单独调用，不和别的工具放在同一批。",
    parameters: Type.Object(
      { kind: Type.Union([Type.Literal("local"), Type.Literal("remote")]) },
      { additionalProperties: false },
    ),
    execute: async (_callId, raw, signal) => {
      const kind = ComputerKind.safeParse((raw as { kind?: unknown }).kind);
      if (!kind.success) throw new Error("kind 只能是 remote 或 local。");
      const run = options.live();
      if (run === null) throw new Error("这次调用不属于任何一次运行，换不了电脑。");
      const abort = AbortSignal.any([
        run.signal,
        AbortSignal.timeout(60_000),
        ...(signal === undefined ? [] : [signal]),
      ]);
      abort.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(new URL("/hub/v1/lane/computer", run.gateway.baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${run.gateway.apiKey}`,
            "content-type": "application/json",
            ...run.headers,
          },
          body: JSON.stringify({ runId: run.runId, kind: kind.data }),
          signal: abort,
          redirect: "error",
        });
      } catch (error) {
        if (abort.aborted) throw error;
        throw new Error("连不上白泽中枢，这次没换成电脑。", { cause: error });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`白泽中枢拒绝了这次换电脑（${response.status}），这一轮继续在当前这台上做。`);
      }
      const parsed = SwitchComputerResponse.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new Error("白泽中枢的回应格式不对，这次没换成电脑。");
      if (parsed.data.result === "refused") throw new Error(parsed.data.text);
      run.markSwitching(kind.data);
      return {
        content: [
          {
            type: "text",
            text: `已换到${NAME[kind.data]}，这一轮到此结束，换好后会在${NAME[kind.data]}上接着做，不用再说什么。`,
          },
        ],
        details: {},
        terminate: true,
      };
    },
  };
}

const SELF: Readonly<Record<ComputerKind, string>> = {
  local: "这一轮你在主人的电脑上。",
  remote:
    "这一轮你在云电脑上：一台 Linux 服务器，不是主人的电脑。主人电脑上的文件、登录过的网站这里都没有，浏览器要在这里单独登录。在这里工作区里的普通读写和只读命令不用问主人，联网、删除、移动、读写工作区外的东西照旧要问。",
};

/** 每次模型请求现拼，不进会话 JSONL，所以换机后不会留下过时的「我在 Mac 上」。 */
export function renderComputerSection(self: ComputerKind, view: ComputerView | null): string | null {
  if (self === "local" && view === null) return null;
  const lines = ["## 电脑", SELF[self]];
  const other = view?.other ?? null;
  if (other !== null) {
    lines.push(
      other.dispatchable
        ? `另一台是${NAME[other.kind]}，在线。需要换过去就调用 switch_computer（kind 填 ${other.kind}），这一轮会在那边接着做，不用让主人自己去点。`
        : `另一台是${NAME[other.kind]}，现在不在线，换不过去。`,
    );
    if (other.kind === view?.choice) {
      lines.push(
        `这个群里你选定的是${NAME[other.kind]}，这一轮在${NAME[self]}上跑完，下一条起会在${NAME[other.kind]}上。`,
      );
    }
  }
  return lines.join("\n");
}
