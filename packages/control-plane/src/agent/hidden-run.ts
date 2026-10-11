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
import { finishRun, ownerOfGroup, startTableRun } from "../repo/runs.js";
import type { AgentHub } from "./hub.js";
import type { SelectionFailure } from "./computer-selection.js";
import { computerFor } from "./dispatch.js";

export type HiddenRunDeps = {
  readonly db: Db;
  readonly agents: Pick<AgentHub, "isOnline" | "configRejected" | "send">;
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
 * 选不到电脑就什么都不建；run 建好后发不出去（电脑刚好掉线）把 run 收掉，不占着座位的唯一索引。
 */
export async function sendHiddenRun(deps: HiddenRunDeps, input: HiddenRunInput): Promise<HiddenRunOutcome> {
  const ownerId = await ownerOfGroup(deps.db, input.groupId);
  if (ownerId === null) return { kind: "skipped" };
  const selected = await computerFor(deps.db, deps.agents, ownerId);
  if (selected.kind === "failed") return { kind: "unplaced", reason: selected.reason };

  const started = await startTableRun(deps.db, {
    ownerId,
    computerId: selected.computer.id,
    botId: input.botId,
    groupId: input.groupId,
    role: input.role,
    visibleTo: input.visibleTo,
  });
  if (started.kind === "busy") return { kind: "busy" };
  if (started.kind === "not_member") return { kind: "skipped" };

  const sent = deps.agents.send(selected.computer.id, {
    type: "prompt",
    runId: started.runId,
    botId: input.botId,
    groupId: input.groupId,
    messageId: started.messageId,
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
  });
  if (!sent) {
    await finishRun(
      deps.db,
      started.runId,
      input.groupId,
      { steps: 0, inputTokens: 0, outputTokens: 0, amount: 0 },
      "abandoned",
    );
    return { kind: "unplaced", reason: "no_computer_online" };
  }
  return { kind: "sent", runId: started.runId, messageId: started.messageId };
}
