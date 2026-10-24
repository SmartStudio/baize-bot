import type { UplinkAck, UplinkRejection, WorkAppend, WorkAppendResult } from "@baize/shared";
import { OversizedUplink } from "./frame-limit.js";

type Result = WorkAppendResult | { readonly kind: "disconnected" };
type Stored = { readonly seq: number; readonly body: WorkAppend };

interface Waiting {
  readonly resolve: (result: Result) => void;
  seq: number | null;
}

const resultOf = (rejection: UplinkRejection | undefined): WorkAppendResult => {
  if (rejection === undefined) return { kind: "ok" };
  switch (rejection.code) {
    case "stale_epoch":
    case "not_holder":
    case "head_mismatch":
    case "invalid":
      return rejection.code === "invalid"
        ? {
            kind: "invalid",
            ...(rejection.reason === undefined ? {} : { reason: rejection.reason }),
            ...(rejection.lineIndex === undefined ? {} : { lineIndex: rejection.lineIndex }),
            ...(rejection.replayReason === undefined ? {} : { replayReason: rejection.replayReason }),
            ...(rejection.nextSeq === undefined ? {} : { nextSeq: rejection.nextSeq }),
            ...(rejection.head === undefined ? {} : { head: rejection.head }),
          }
        : { kind: rejection.code };
    case "seq_mismatch":
      return rejection.nextSeq === undefined
        ? { kind: "invalid" }
        : { kind: "seq_mismatch", nextSeq: rejection.nextSeq };
    case "run_closed":
      return { kind: "invalid" };
  }
};

interface WorkAppendChannelOptions {
  readonly connected: () => boolean;
  readonly append: (frame: WorkAppend) => Promise<Stored>;
  readonly send: (stored: Stored) => void;
  readonly cancel: (lane: NonNullable<UplinkRejection["lane"]>, epoch: number) => void;
  readonly failed: (error: unknown) => void;
}

export class WorkAppendChannel {
  #waiting = new Set<Waiting>();
  #options: WorkAppendChannelOptions;

  constructor(options: WorkAppendChannelOptions) {
    this.#options = options;
  }

  append(frame: WorkAppend): Promise<Result> {
    if (!this.#options.connected()) return Promise.resolve({ kind: "disconnected" });
    return new Promise<Result>((resolve) => {
      const waiting: Waiting = { resolve, seq: null };
      this.#waiting.add(waiting);
      void this.#options
        .append(frame)
        .then((stored) => {
          if (!this.#waiting.has(waiting)) return;
          if (!this.#options.connected()) {
            this.#settle(waiting, { kind: "disconnected" });
            return;
          }
          // append 完成意味着已经 fsync。先登记序号再发送，快速 ACK 也能对应到等待者。
          waiting.seq = stored.seq;
          this.#options.send(stored);
        })
        .catch((error: unknown) => {
          // 运行器已按字节切批，到这里还超限就让镜像停流；回 disconnected 它会拿同一批反复重试。
          if (error instanceof OversizedUplink) {
            this.#settle(waiting, { kind: "invalid" });
            return;
          }
          this.#settle(waiting, { kind: "disconnected" });
          this.#options.failed(error);
        });
    });
  }

  acknowledge(ack: UplinkAck): void {
    const rejected = new Map(ack.rejected.map((entry) => [entry.seq, entry]));
    for (const waiting of this.#waiting) {
      if (waiting.seq !== null && waiting.seq <= ack.upTo) this.#settle(waiting, resultOf(rejected.get(waiting.seq)));
    }
    for (const entry of ack.rejected) {
      if ((entry.code === "stale_epoch" || entry.code === "not_holder") && entry.lane !== undefined)
        this.#options.cancel(entry.lane, entry.lane.epoch + 1);
    }
  }

  disconnect(): void {
    for (const waiting of this.#waiting) this.#settle(waiting, { kind: "disconnected" });
  }

  #settle(waiting: Waiting, result: Result): void {
    if (!this.#waiting.delete(waiting)) return;
    waiting.resolve(result);
  }
}
