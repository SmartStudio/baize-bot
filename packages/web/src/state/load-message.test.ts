import { Message, MessageId } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { RequestFailed, type Api } from "../api/client.js";
import { createLoadBucket, loadMessageGap, type Scope } from "./app.js";
import { createClock } from "./stamped.js";
import type { Action, SessionId } from "./types.js";

const MESSAGE_ID = MessageId.parse("msg_terminal");

// 单拉接口由测试一趟一趟放行：每次调用排一个待定的回包，测试决定它成功还是带什么状态码失败。
const harness = () => {
  const calls: { resolve: (message: Message) => void; reject: (cause: unknown) => void }[] = [];
  const api = {
    message: () =>
      new Promise<Message>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  } as unknown as Api;
  const actions: Action[] = [];
  const scope: Scope = {
    api,
    put: (action) => actions.push(action),
    session: { id: 1 as SessionId, api, signal: new AbortController().signal, flights: new Map() },
  };
  const nextSeq = createClock();
  const loadBucket = createLoadBucket(nextSeq);
  const load = () => loadMessageGap(loadBucket, scope, MESSAGE_ID, nextSeq(), 0);
  return { calls, actions, scope, load };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("单拉漏档的 404 终态", () => {
  it("在途时又来了一次补拉需求，第一趟回 404：排着的那一趟作废，报 message_gone，不再发请求", async () => {
    const { calls, actions, scope, load } = harness();
    const first = load();
    await settled();
    expect(calls, "第一趟已发出").toHaveLength(1);
    const queued = load();
    await queued;
    expect(calls, "在途时的新需求只记一笔待补，不另发").toHaveLength(1);

    calls[0]?.reject(new RequestFailed(404, "没有这条消息"));
    await settled();
    // 若还是发了第二趟，让它 503，看终态会不会被改写成失败计数。
    calls[1]?.reject(new RequestFailed(503, "单拉消息暂时失败"));
    await first;
    expect(calls, "404 之后待补的那一趟不再发").toHaveLength(1);
    const gapActions = actions.filter(
      (action) => action.type === "message_gone" || action.type === "message_gap_failed",
    );
    expect(gapActions, "只报终态，不报失败").toEqual([{ type: "message_gone", messageId: MESSAGE_ID }]);
    expect(scope.session.flights.size, "桶已收尾").toBe(0);
  });

  it("在途时又来了一次补拉需求，第一趟成功：照旧补拉一次", async () => {
    const { calls, actions, load } = harness();
    const first = load();
    await settled();
    await load();
    const message = Message.parse({
      id: MESSAGE_ID,
      groupId: "grp_service",
      body: { kind: "bot", botId: "bot_service", text: "完整", streaming: false },
      createdAt: "2026-10-09T00:00:00.000Z",
      revision: 3,
      visibleTo: null,
    });
    calls[0]?.resolve(message);
    await settled();
    expect(calls, "成功之后待补的那一趟照发").toHaveLength(2);
    calls[1]?.resolve({ ...message, revision: 4, visibleTo: null });
    await first;
    expect(actions.filter((action) => action.type === "message_upserted")).toHaveLength(2);
  });
});
