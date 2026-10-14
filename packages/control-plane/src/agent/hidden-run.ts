import type {
  BotId,
  GroupId,
  MessageId,
  ModelPurpose,
  PokerTableRole,
  RunId,
  TablePrompt,
  Viewer,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { ownerOfGroup, startTableRun } from "../repo/runs.js";
import { enqueueDownlink, lockEnvelopeComputer } from "./envelope.js";
import type { AgentHub } from "./hub.js";
import type { SelectionFailure } from "./computer-selection.js";
import { computerFor } from "./dispatch.js";

export type HiddenRunDeps = {
  readonly db: Db;
  readonly agents: Pick<AgentHub, "isOnline" | "configRejected"> & {
    readonly canDeliver?: (computerId: Parameters<AgentHub["isOnline"]>[0]) => boolean;
    readonly flushOutbox?: (computerId: Parameters<AgentHub["isOnline"]>[0]) => Promise<void>;
  };
};

export type HiddenRunInput = {
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly role: PokerTableRole;
  /** 触发消息的可见范围，也是这条 run 记下的可见范围。 */
  readonly visibleTo: readonly [Viewer, ...Viewer[]];
  readonly table: Omit<TablePrompt, "role">;
};

export type HiddenRunOutcome =
  | { readonly kind: "sent"; readonly runId: RunId; readonly messageId: MessageId }
  | { readonly kind: "busy" }
  | { readonly kind: "unplaced"; readonly reason: SelectionFailure }
  | { readonly kind: "skipped" };

/** 牌友要快，问牌和复盘要想：只有 player 走 fast。 */
const PURPOSE_OF_ROLE: Readonly<Record<PokerTableRole, ModelPurpose>> = {
  player: "fast",
  advisor: "plan",
  reviewer: "plan",
};

/**
 * 牌桌的隐藏派活：触发消息只写给 visibleTo，prompt 不带群历史和任务卡。
 * run 和 prompt 在同一事务落入数据库，事务外提交后再 flush，重连也能补发。
 */
export async function sendHiddenRun(deps: HiddenRunDeps, input: HiddenRunInput): Promise<HiddenRunOutcome> {
  const ownerId = await ownerOfGroup(deps.db, input.groupId);
  if (ownerId === null) return { kind: "skipped" };
  const selected = await computerFor(deps.db, deps.agents, ownerId);
  if (selected.kind === "failed") return { kind: "unplaced", reason: selected.reason };

  const started = await deps.db.transaction(async (tx) => {
    await lockEnvelopeComputer(tx, selected.computer.id, input.botId);
    const run = await startTableRun(tx as unknown as Db, {
      ownerId,
      computerId: selected.computer.id,
      botId: input.botId,
      groupId: input.groupId,
      role: input.role,
      visibleTo: input.visibleTo,
    });
    if (run.kind !== "started") return run;
    const queued = await enqueueDownlink(
      tx,
      selected.computer.id,
      {
        type: "prompt",
        runId: run.runId,
        botId: input.botId,
        groupId: input.groupId,
        messageId: run.messageId,
        text: "",
        origin: { kind: "table" },
        reason: "mentioned",
        group: { id: input.groupId, number: "", title: "", kind: "team" },
        context: [],
        purpose: PURPOSE_OF_ROLE[input.role],
        routine: null,
        table: { ...input.table, role: input.role },
        task: null,
        members: [],
      },
      run.runId,
    );
    return queued ? run : tx.rollback();
  });
  if (started.kind === "busy") return { kind: "busy" };
  if (started.kind === "not_member") return { kind: "skipped" };
  if (deps.agents.flushOutbox) await deps.agents.flushOutbox(selected.computer.id);
  return { kind: "sent", runId: started.runId, messageId: started.messageId };
}
