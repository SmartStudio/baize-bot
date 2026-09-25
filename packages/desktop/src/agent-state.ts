import type { ChildProcess } from "node:child_process";

export type AgentState =
  | { readonly status: "none" }
  | { readonly status: "starting"; readonly child: ChildProcess }
  | { readonly status: "online"; readonly child: ChildProcess }
  | { readonly status: "stopping"; readonly child: ChildProcess };

export function currentAgentChild(state: AgentState): ChildProcess | null {
  return state.status === "none" ? null : state.child;
}

export function isCurrentAgent(state: AgentState, child: ChildProcess): boolean {
  return state.status !== "none" && state.child === child;
}

export function shouldReportStartFailure(state: AgentState, child: ChildProcess): boolean {
  return state.status === "starting" && state.child === child;
}

export function shouldRetryPush<T>(quitting: boolean, current: T | null, socket: T): boolean {
  return !quitting && current === socket;
}
