import { describe, expect, it } from "vitest";
import { BotListResponse } from "@baize/shared";
import { startStack } from "../src/stack.js";
import { type ScriptedTurn, startUpstream } from "../src/upstream.js";

const TIMEOUT_TEXT = "模型上游太久没回话或者一次说得太久，网关先断开了，稍后再试。";

type RunRow = { readonly ended_at: Date | null };

async function timedOutTurn(
  script: () => Promise<ScriptedTurn>,
  gatewayTimeouts: { firstByteMs?: number; totalMs?: number },
): Promise<{ readonly system: string | null; readonly requests: number; readonly ended: boolean }> {
  const upstream = await startUpstream(script);
  const stack = await startStack({
    upstreamBaseUrl: upstream.baseUrl,
    priceInputPerM: 3,
    priceOutputPerM: 15,
    gatewayTimeouts,
  });
  try {
    const first = BotListResponse.parse(await stack.get("/api/bots")).items[0];
    if (first === undefined) throw new Error("seed 没建出 Bot");
    await stack.post(`/api/groups/${first.groupId}/messages`, { text: "写一份长报告" });

    let system: string | null = null;
    for (;;) {
      const push = await stack.nextPush(60_000);
      if (push.type !== "message") continue;
      if (push.message.body.kind === "system") system = push.message.body.text;
      if (push.message.body.kind === "cost") break;
    }
    const [run] = await stack.sql<RunRow[]>`SELECT ended_at FROM runs WHERE group_id = ${first.groupId}`;
    return { system, requests: upstream.requests().length, ended: run?.ended_at !== null };
  } finally {
    await stack.close();
    await upstream.close();
  }
}

describe("端到端：网关等不到上游，Pi 报错收尾而不是挂住", () => {
  it("上游一直不回首字节，网关回 504，群里说明超时，run 结束", async () => {
    const outcome = await timedOutTurn(() => new Promise<never>(() => undefined), { firstByteMs: 300 });

    expect(outcome.system).toBe(TIMEOUT_TEXT);
    expect(outcome.ended, "run 要收尾").toBe(true);
    expect(outcome.requests, "Pi 碰到 504 自己再试三次，之后报错收尾").toBe(4);
  });

  it("上游流到一半不动了，网关在流尾补 error 事件，群里说明超时，run 结束", async () => {
    const outcome = await timedOutTurn(
      async () => ({
        textChunks: ["报告开头", () => new Promise<never>(() => undefined)],
        usage: { input: 1, output: 1 },
      }),
      { totalMs: 1500 },
    );

    expect(outcome.system).toBe(TIMEOUT_TEXT);
    expect(outcome.ended, "run 要收尾").toBe(true);
    expect(outcome.requests, "流里的超时事件 Pi 不重试").toBe(1);
  });
});
