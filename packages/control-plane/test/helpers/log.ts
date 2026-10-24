import type { MockInstance } from "vitest";

export type LogLine = {
  readonly time: string;
  readonly level: string;
  readonly msg: string;
  readonly [field: string]: unknown;
};

export function logLine(raw: unknown): LogLine {
  return JSON.parse(String(raw)) as LogLine;
}

export function logLines(spy: MockInstance): LogLine[] {
  return spy.mock.calls.map((args) => logLine(args[0]));
}
