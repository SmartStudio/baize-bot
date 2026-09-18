export interface BackoffOptions {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
}

export const defaultBackoff: BackoffOptions = { initialMs: 500, maxMs: 30_000, factor: 2 };

export function backoffDelay(attempt: number, options: BackoffOptions): number {
  return Math.min(options.maxMs, options.initialMs * options.factor ** attempt);
}
