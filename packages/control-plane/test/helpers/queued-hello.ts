import type { ComputerId, RunId } from "@baize/shared";
import { vi } from "vitest";
import * as computersRepo from "../../src/repo/computers.js";
import { openAgent, sendHello, type AgentClient } from "./agent.js";

/**
 * 同一台电脑的旧连接有任务停住时，新连接的 hello 认完身份就排进这台电脑的链，轮不到它，welcome 要等前面的任务做完才来。
 * 这里只把它排上去：等认身份返回，再让微任务跑空。认身份返回到排进链之间只有微任务，一个宏任务之后它一定已经在链上排着。
 */
export async function queueHello(
  port: number,
  computerId: ComputerId,
  token: string,
  activeRuns: readonly RunId[] = [],
): Promise<AgentClient> {
  const original = computersRepo.authenticateComputer;
  let authenticated!: () => void;
  const done = new Promise<void>((resolve) => (authenticated = resolve));
  const spy = vi.spyOn(computersRepo, "authenticateComputer").mockImplementation(async (...args) => {
    try {
      return await original(...args);
    } finally {
      authenticated();
    }
  });
  try {
    const agent = await openAgent(port);
    sendHello(agent, computerId, token, activeRuns);
    await done;
    await new Promise((resolve) => setImmediate(resolve));
    return agent;
  } finally {
    spy.mockRestore();
  }
}
