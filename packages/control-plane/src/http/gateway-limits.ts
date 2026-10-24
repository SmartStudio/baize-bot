import type { ComputerId } from "@baize/shared";

export type GatewayLimits = {
  readonly firstByteTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly requestsPerMinute: number;
  readonly burst: number;
};

// 首字节 120 秒：比 Pi 自己的 300 秒 headersTimeout 短，挂住的上游先由网关回 504，Pi 才能拿到状态码去重试和报错。
// 总时长 600 秒：运行器一次最多要 8192 个输出 token，慢上游每秒十几个 token 也够说完。
// 每台电脑每分钟 600 次、突发 120：一台电脑最多十来个 Bot 并发，每次模型请求通常要好几秒，正常用够不着，只挡失控的循环。
export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  firstByteTimeoutMs: 120_000,
  totalTimeoutMs: 600_000,
  requestsPerMinute: 600,
  burst: 120,
};

export const GATEWAY_TIMEOUT_MARK = "网关等不及先断开了";

type Bucket = { tokens: number; refilledAt: number };

export class RequestBuckets {
  readonly #buckets = new Map<ComputerId, Bucket>();
  readonly #perMs: number;

  constructor(
    private readonly limits: Pick<GatewayLimits, "requestsPerMinute" | "burst">,
    private readonly now: () => number = Date.now,
  ) {
    this.#perMs = limits.requestsPerMinute / 60_000;
  }

  take(computerId: ComputerId): number | null {
    const now = this.now();
    const bucket = this.#buckets.get(computerId) ?? { tokens: this.limits.burst, refilledAt: now };
    bucket.tokens = Math.min(this.limits.burst, bucket.tokens + (now - bucket.refilledAt) * this.#perMs);
    bucket.refilledAt = now;
    this.#buckets.set(computerId, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    return (1 - bucket.tokens) / this.#perMs;
  }
}
