import { DOWNLINK_DELIVERY, type AgentToControl } from "@baize/shared";
import type { Db } from "../db/client.js";
import type { Tx } from "../repo/messages.js";
import type { AgentConnection } from "./hub.js";
import { eventMemoryRollback, handleAgentEvent, type AgentEventDeps } from "./events.js";
import { enqueueDownlink } from "./envelope.js";

/** 数据库写留在信封事务里，网络和会派下一轮活的内存调度等提交后再做。 */
export async function handleEnvelopedEvent(
  deps: AgentEventDeps,
  conn: AgentConnection,
  body: AgentToControl,
  receivedAt: Date,
  tx: Tx,
  afterCommit: (() => Promise<void> | void)[],
  afterRollback: (() => void)[],
): Promise<void> {
  const pending: (() => Promise<unknown>)[] = [];
  const deferred = <T extends object>(target: T, names?: ReadonlySet<PropertyKey>): T =>
    new Proxy(target, {
      get(object, property) {
        const method: unknown = Reflect.get(object, property);
        if (typeof method !== "function") return method;
        if (target === deps.groupTurns && property === "claimHandoffLimitNotice")
          return (runId: Parameters<typeof deps.groupTurns.claimHandoffLimitNotice>[0]) => {
            const claimed = deps.groupTurns.claimHandoffLimitNotice(runId);
            if (claimed) afterRollback.push(() => deps.groupTurns.releaseHandoffLimitNotice(runId));
            return claimed;
          };
        if (names !== undefined && !names.has(property)) return method.bind(object);
        return (...args: unknown[]) => {
          afterCommit.push(() => Reflect.apply(method, object, args) as Promise<void> | void);
          return Promise.resolve();
        };
      },
    });
  const agents = new Proxy(deps.agents, {
    get(object, property) {
      if (property === "send")
        return (computerId: AgentConnection["computerId"], message: Parameters<typeof object.send>[1]) => {
          if (DOWNLINK_DELIVERY[message.type] === "reliable") {
            pending.push(() =>
              enqueueDownlink(tx, computerId, message, "runId" in message ? message.runId : undefined),
            );
            afterCommit.push(() => object.flushOutbox(computerId));
          } else
            afterCommit.push(() => {
              object.send(computerId, message);
            });
          return true;
        };
      if (property === "sendConfig")
        return (ownerId: AgentConnection["ownerId"]) => {
          afterCommit.push(() => object.sendConfig(ownerId));
          return Promise.resolve();
        };
      const value: unknown = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const toolCalls = new Map(conn.toolCallMessages);
  const restoreMemory = eventMemoryRollback(body);
  const restore = () => {
    restoreMemory();
    conn.toolCallMessages.clear();
    for (const [key, value] of toolCalls) conn.toolCallMessages.set(key, value);
  };
  afterRollback.push(restore);
  try {
    await handleAgentEvent(
      {
        ...deps,
        db: tx as unknown as Db,
        afterCommit: (effect) => {
          afterCommit.push(() => effect(deps));
        },
        push: deferred(deps.push, new Set(["push"])),
        notifications: deferred(deps.notifications),
        agents,
        groupTurns: deferred(
          deps.groupTurns,
          new Set(["queueHandoff", "recordHandoff", "recordBotMessage", "rememberCost", "runDone", "abandon"]),
        ),
      },
      conn,
      body,
      receivedAt,
    );
    for (const write of pending) await write();
  } catch (error) {
    restore();
    throw error;
  }
}
