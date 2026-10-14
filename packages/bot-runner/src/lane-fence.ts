import {
  EMPTY_WORK_HEAD,
  type BotId,
  type ControlToAgent,
  type GroupId,
  type RunId,
  type WorkAppend,
  type WorkAppendResult,
} from "@baize/shared";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GateDecision } from "./gate.js";

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

export type WorkAppendOutcome = WorkAppendResult | { readonly kind: "disconnected" };
export type WorkAppender = (frame: WorkAppend) => Promise<WorkAppendOutcome>;

export interface LaneSessionFence {
  headers(runId: RunId | undefined): Readonly<Record<string, string>>;
  beforeEffect(runId: RunId, callId: string, action: GateDecision["action"]): Promise<string | null>;
  toolSettled(runId: RunId, callId: string): void;
}

const DISCONNECTED_REASON = "和白泽断开了，这一步先不做";
const CHANGED_HOLDER_REASON = "这个群已经换到另一台电脑上了";
const UNCONFIRMED_REASON = "工作记录没有确认，这一步先不做";

export function installLaneHeaders(pi: ExtensionAPI, headers: () => Readonly<Record<string, string>>): void {
  pi.on("before_provider_headers", (event) => {
    Object.assign(event.headers, headers());
  });
}

export function installLaneToolSettled(
  pi: ExtensionAPI,
  activeRunId: () => RunId | undefined,
  fence: LaneSessionFence,
): void {
  pi.on("tool_execution_end", (event) => {
    const runId = activeRunId();
    if (runId !== undefined) fence.toolSettled(runId, event.toolCallId);
  });
}

export interface LaneCancel {
  readonly lane: { readonly botId: BotId; readonly groupId: GroupId };
  readonly epoch: number;
}

export interface RunLane {
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly epoch: number;
  readonly stream: "chat" | "table";
}

export class LaneFence implements LaneSessionFence {
  #runs = new Map<RunId, RunLane>();
  #effects = new Map<RunId, Map<string, (result?: WorkAppendOutcome) => void>>();
  #append: () => WorkAppender | undefined;
  #flush: ((runId: RunId) => Promise<WorkAppendOutcome>) | undefined;

  constructor(append: () => WorkAppender | undefined, flush?: (runId: RunId) => Promise<WorkAppendOutcome>) {
    this.#append = append;
    this.#flush = flush;
  }

  register(message: Prompt): void {
    this.#runs.set(message.runId, {
      botId: message.botId,
      groupId: message.groupId,
      epoch: message.lane.epoch,
      stream: message.table === null ? "chat" : "table",
    });
  }

  get(runId: RunId): RunLane | undefined {
    return this.#runs.get(runId);
  }

  remove(runId: RunId): void {
    this.#runs.delete(runId);
    for (const cancel of this.#effects.get(runId)?.values() ?? []) cancel();
  }

  interruptAll(): void {
    for (const effects of this.#effects.values()) for (const cancel of effects.values()) cancel();
  }

  supersede(runId: RunId): void {
    for (const cancel of this.#effects.get(runId)?.values() ?? []) cancel({ kind: "stale_epoch" });
  }

  headers(runId: RunId | undefined): Readonly<Record<string, string>> {
    const run = runId === undefined ? undefined : this.#runs.get(runId);
    return run === undefined ? {} : { "x-baize-lane": `${run.botId}/${run.groupId}/${run.epoch}` };
  }

  pendingCalls(runId: RunId): readonly string[] {
    return [...(this.#effects.get(runId)?.keys() ?? [])];
  }

  toolSettled(runId: RunId, callId: string): void {
    const effects = this.#effects.get(runId);
    effects?.delete(callId);
    if (effects?.size === 0) this.#effects.delete(runId);
  }

  async beforeEffect(runId: RunId, callId: string, action: GateDecision["action"]): Promise<string | null> {
    if (action === "read" || action === "write_workspace") return null;
    const lane = this.#runs.get(runId);
    const append = this.#append();
    if (lane === undefined || append === undefined) return DISCONNECTED_REASON;
    let cancel!: (result?: WorkAppendOutcome) => void;
    const cancelled = new Promise<WorkAppendOutcome>((resolve) => {
      cancel = (result) => resolve(result ?? { kind: "disconnected" });
    });
    const effects = this.#effects.get(runId) ?? new Map<string, (result?: WorkAppendOutcome) => void>();
    effects.set(callId, cancel);
    this.#effects.set(runId, effects);
    let result: WorkAppendOutcome;
    try {
      result = await Promise.race([
        this.#flush?.(runId) ??
          append({
            type: "work_append",
            lane,
            runId,
            fromSeq: 0,
            lines: [],
            head: EMPTY_WORK_HEAD,
            cause: "before_effect",
          }),
        cancelled,
      ]);
    } catch {
      result = { kind: "disconnected" };
    }
    if (result.kind === "ok" && this.#runs.has(runId)) {
      this.toolSettled(runId, callId);
      return null;
    }
    // 被拒的探针留到工具结果写入；道取消先等它，避免 abort 把中文原因盖成 Operation aborted。
    if (result.kind === "stale_epoch" || result.kind === "not_holder") return CHANGED_HOLDER_REASON;
    return result.kind === "disconnected" || result.kind === "ok" ? DISCONNECTED_REASON : UNCONFIRMED_REASON;
  }

  olderThan({ lane, epoch }: LaneCancel): readonly RunId[] {
    return [...this.#runs].flatMap(([runId, run]) =>
      run.botId === lane.botId && run.groupId === lane.groupId && run.epoch < epoch ? [runId] : [],
    );
  }
}
