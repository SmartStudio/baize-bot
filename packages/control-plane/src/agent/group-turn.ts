import type {
  BotId,
  ControlToAgent,
  GroupId,
  HandoffId,
  Message,
  MessageId,
  ModelPurpose,
  RoutineBoundary,
  RoutineId,
  RunId,
  ServerPush,
  UserId,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { saveTurnBotMessages } from "../repo/groups.js";
import { dropQueuedHandoffs, listQueuedHandoffs } from "../repo/handoffs.js";
import { appendMessage } from "../repo/messages.js";
import type { PushHub } from "../ws/hub.js";
import { renderHandoffReport } from "./handoff.js";
import { parseMentions, type RoutingMember } from "./routing.js";

export const BOT_MESSAGE_LIMIT = 10;
export const MENTION_LOOP_NOTICE = "Bot 之间 @ 太多次，停下等你";
export const HANDOFF_LIMIT_NOTICE = `这一轮 Bot 已经说满 ${BOT_MESSAGE_LIMIT} 句，这份交接没有交出去`;

export const limitReached = (botMessages: number): boolean => botMessages >= BOT_MESSAGE_LIMIT;

export type Speaker = {
  readonly botId: BotId;
  readonly trigger: Message;
  readonly reason: Extract<ControlToAgent, { type: "prompt" }>["reason"];
  readonly handoff?: { readonly id: HandoffId; readonly text: string; readonly fromBotId: BotId };
  /**
   * 换电脑后接着做的那一位：text 就是整段提示，fromRunId 是它接的那一轮，同一轮只排一次。
   * routine 取自它自己的父链：排进别的回合时也不能沿用那个回合的用途和边界。
   */
  readonly continuation?: {
    readonly fromRunId: RunId;
    readonly text: string;
    readonly routine: ContinuationRoutine | null;
  };
};

export type ContinuationRoutine = {
  readonly routineId: RoutineId;
  readonly boundary: RoutineBoundary;
  readonly purpose: ModelPurpose;
};

export type ContinuationSpeaker = Speaker & { readonly continuation: NonNullable<Speaker["continuation"]> };

/**
 * 派一位的结果。skipped：它在派活途中被删了，只跳过它，同一回合排在后面的照常派。
 * stopped：电脑选不到或发不出去，后面的人同样派不出去，群里已经留了一句，关轮。
 * gone：群本身没了（单聊随 Bot 级联删掉），往里写什么都撞外键，关轮，调用方也不要再留话。
 */
export type SendOutcome =
  | { readonly kind: "sent"; readonly runId: RunId }
  | { readonly kind: "skipped" }
  | { readonly kind: "stopped" }
  | { readonly kind: "gone" };

/**
 * 开一轮的结果。dispatched：有人跑起来了。nobody：排着的人一个都没派出去（都在派活途中被删），
 * 回合已收，群里没留话，调用方可以换一批目标再开。stopped：回合因别的原因收了，群里已经留了一句，
 * 或者被更新的一轮顶掉了，调用方不要再开。failed：给头一位派活抛了错，回合已收，群里留了一句，
 * 调用方按没派出去收尾，不当成有人在跑。gone：群已经不在了，什么都别再往里写。
 */
export type StartOutcome = "dispatched" | "nobody" | "stopped" | "failed" | "gone";

export const dispatchFailedNotice = (name: string): string => `派给${name}的活没发出去，@ 它再试一次`;

/**
 * 回合里「这一位」处在哪一步。sending 是 shift 出队列、派活报文还没回来的那段，
 * 这段里删 Bot 只能打标记，等派活回来再按跳过处理；running 才有 runId，带 runId 的上行报文都对它核。
 */
type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly speaker: Speaker; readonly deleted: boolean }
  | { readonly kind: "running"; readonly speaker: Speaker; readonly runId: RunId };

type AdvanceOutcome = "dispatched" | "exhausted" | "closed" | "failed" | "gone";

type TurnCost = {
  messageId: MessageId;
  runId: RunId;
  botId: BotId;
  steps: number;
  amount: number;
};

type PassCredit = { steps: number; amount: number };

type Turn = {
  readonly groupId: GroupId;
  readonly ownerId: UserId;
  readonly epoch: number;
  readonly members: readonly RoutingMember[];
  readonly send: (speaker: Speaker, includeRecent: boolean) => Promise<SendOutcome>;
  readonly seen: Set<string>;
  /** 说过正文的 run。运行器每个文字块一条消息，一个 run 的正文只算一句，不然一段带工具的长回复就撞上限。 */
  readonly talked: Set<RunId>;
  readonly handoffs: Speaker[];
  readonly mentions: Speaker[];
  speakers: Speaker[];
  round: number;
  stage: Stage;
  botMessages: number;
  dispatched: number;
  summary: TurnCost | null;
};

/** 这一轮正在跑的是这个 run 时才认，派活途中和空档里的 run 号都对不上。 */
function isRunning(turn: Turn | undefined, runId: RunId): turn is Turn {
  return turn?.stage.kind === "running" && turn.stage.runId === runId;
}

/** 这位是不是已删 Bot 的事：它自己被删，或者它带的交接是被删 Bot 交出来的（卡已随 Bot 级联删掉）。 */
function belongsTo(speaker: Speaker, botId: BotId): boolean {
  return speaker.botId === botId || speaker.handoff?.fromBotId === botId;
}

function purge(queue: Speaker[], botId: BotId): boolean {
  const kept = queue.filter((speaker) => !belongsTo(speaker, botId));
  if (kept.length === queue.length) return false;
  queue.splice(0, queue.length, ...kept);
  return true;
}

export type PassAbsorption =
  { readonly kind: "merged"; readonly cost: TurnCost } | { readonly kind: "held" } | { readonly kind: "miss" };

export class GroupTurns {
  readonly #turns = new Map<string, Turn>();
  readonly #blockedRuns = new Set<RunId>();
  readonly #handoffLimitNoted = new Set<RunId>();
  readonly #saveChains = new Map<string, Promise<void>>();

  constructor(
    readonly db: Db,
    readonly push: PushHub,
  ) {}

  async start(input: {
    readonly groupId: GroupId;
    readonly ownerId: UserId;
    readonly epoch: number;
    readonly members: readonly RoutingMember[];
    readonly speakers: readonly Speaker[];
    readonly botMessages: number;
    readonly send: Turn["send"];
  }): Promise<StartOutcome> {
    const turn: Turn = {
      ...input,
      speakers: [...input.speakers],
      seen: new Set(),
      talked: new Set(),
      handoffs: [],
      mentions: [],
      round: 0,
      stage: { kind: "idle" },
      dispatched: 0,
      summary: null,
    };
    this.#turns.set(input.groupId, turn);
    try {
      await this.#appendQueuedHandoffs(turn);
    } catch (error) {
      this.#close(turn);
      throw error;
    }
    await this.#save(turn);
    const outcome = await this.#advance(turn);
    if (outcome === "dispatched" || outcome === "failed" || outcome === "gone") return outcome;
    return outcome === "exhausted" && turn.dispatched === 0 ? "nobody" : "stopped";
  }

  /** 用户插话。排着的接续随之作废：他已经在群里说了新的，那段活不再自动接着做，标记由调用方同时清掉。 */
  cancel(groupId: GroupId): void {
    const turn = this.#turns.get(groupId);
    if (turn === undefined) return;
    this.#close(turn);
  }

  snapshots(ownerId: UserId): Extract<ServerPush, { type: "group_turn" }>[] {
    return [...this.#turns.values()].filter((turn) => turn.ownerId === ownerId).map((turn) => this.#snapshot(turn));
  }

  isBlocked(runId: RunId): boolean {
    return this.#blockedRuns.has(runId);
  }

  /** 同一轮只说明一次，再来的交接静默丢掉。 */
  claimHandoffLimitNotice(runId: RunId): boolean {
    if (this.#handoffLimitNoted.has(runId)) return false;
    this.#handoffLimitNoted.add(runId);
    return true;
  }

  /** 信封事务回滚时撤销本次占用，重试仍能写出提示。 */
  releaseHandoffLimitNotice(runId: RunId): void {
    this.#handoffLimitNoted.delete(runId);
  }

  /**
   * 换电脑后的接续插到最前面：它接的是刚结束的那一轮，回合里排着的交接和 @ 都该等它。
   * 不计入 BOT_MESSAGE_LIMIT，回合已经说满、这个 run 被挡下也照排。没有回合时回 idle，由调用方开一轮。
   * 同一轮的接续只排一次：结账和 hello 补扫可能先后都来。
   */
  queueContinuation(groupId: GroupId, runId: RunId, speaker: ContinuationSpeaker): "queued" | "idle" {
    const { fromRunId } = speaker.continuation;
    const turn = this.#turns.get(groupId);
    if (turn === undefined) return "idle";
    const stage = turn.stage;
    const current = stage.kind === "idle" ? null : stage.speaker;
    if (
      current?.continuation?.fromRunId === fromRunId ||
      [...turn.handoffs, ...turn.speakers].some((queued) => queued.continuation?.fromRunId === fromRunId)
    )
      return "queued";
    if (stage.kind === "running" && stage.runId === runId) turn.handoffs.unshift(speaker);
    else turn.speakers.unshift(speaker);
    this.#publish(turn);
    return "queued";
  }

  queueHandoff(groupId: GroupId, runId: RunId, speaker: Speaker): void {
    const turn = this.#turns.get(groupId);
    if (isRunning(turn, runId) && !limitReached(turn.botMessages) && !this.#blockedRuns.has(runId)) {
      turn.handoffs.push(speaker);
      this.#publish(turn);
      return;
    }
    if (turn === undefined) return;
    turn.speakers.push(speaker);
    this.#publish(turn);
  }

  has(groupId: GroupId): boolean {
    return this.#turns.has(groupId);
  }

  /**
   * `(pass)` 不单落花费。这一轮已经有汇总行就并进去，还没有就先记着，等下一次真回话的花费一起写。
   * 对不上当前回合时返回 miss，调用方照旧单落一条。
   */
  absorbPassCost(groupId: GroupId, runId: RunId, extra: PassCredit & { readonly botId: BotId }): PassAbsorption {
    const turn = this.#turns.get(groupId);
    if (!isRunning(turn, runId)) return { kind: "miss" };
    if (turn.summary === null) {
      return { kind: "held" };
    }
    return {
      kind: "merged",
      cost: {
        ...turn.summary,
        steps: turn.summary.steps + extra.steps,
        amount: turn.summary.amount + extra.amount,
      },
    };
  }

  rememberCost(groupId: GroupId, runId: RunId, cost: TurnCost): void {
    const turn = this.#turns.get(groupId);
    if (!isRunning(turn, runId)) return;
    turn.summary = cost;
  }

  /** 正文块同一个 run 只计一次；`mention` 工具每 @ 一次计一次，回路守卫靠它。 */
  async recordBotMessage(groupId: GroupId, runId: RunId, message: Message, via: "text" | "mention"): Promise<void> {
    const turn = this.#turns.get(groupId);
    if (!isRunning(turn, runId) || message.body.kind !== "bot" || turn.seen.has(message.id)) return;
    turn.seen.add(message.id);
    const mentions = message.body.mentions ?? parseMentions(message.body.text, turn.members);
    for (const botId of mentions) {
      if (turn.mentions.some((speaker) => speaker.botId === botId)) continue;
      turn.mentions.push({ botId, trigger: message, reason: "mentioned" });
    }
    if (via === "text" && turn.talked.has(runId)) return;
    if (via === "text") turn.talked.add(runId);
    await this.#count(turn, runId);
  }

  async recordHandoff(groupId: GroupId, runId: RunId): Promise<void> {
    const turn = this.#turns.get(groupId);
    if (!isRunning(turn, runId)) return;
    await this.#count(turn, runId);
  }

  async runDone(groupId: GroupId, runId: RunId): Promise<void> {
    this.#blockedRuns.delete(runId);
    this.#handoffLimitNoted.delete(runId);
    const turn = this.#turns.get(groupId);
    if (!isRunning(turn, runId)) return;
    turn.stage = { kind: "idle" };
    await this.#advance(turn);
  }

  /**
   * Bot 删掉之后它的 run_done 过不了 resolveRun，正轮到它说的回合不能等它，当它说完了，轮下一位，没人了就收轮。
   * 还在派活途中的只打标记，派活回来按跳过处理，不把已删的它设成这一位。
   * 排在后面的从队列里清掉，连同它交出去的交接：卡已随它级联删掉，派出去接手方也接不了。
   */
  async botDeleted(ownerId: UserId, botId: BotId): Promise<void> {
    const finishing: Promise<void>[] = [];
    for (const turn of this.#turns.values()) {
      if (turn.ownerId !== ownerId) continue;
      const purged = [turn.handoffs, turn.speakers, turn.mentions].map((queue) => purge(queue, botId));
      if (purged.includes(true)) this.#publish(turn);
      const stage = turn.stage;
      if (stage.kind === "running" && belongsTo(stage.speaker, botId)) {
        finishing.push(this.runDone(turn.groupId, stage.runId));
      } else if (stage.kind === "sending" && belongsTo(stage.speaker, botId)) {
        turn.stage = { ...stage, deleted: true };
      }
    }
    await Promise.all(finishing);
  }

  async abandon(groupId: GroupId, runId: RunId): Promise<void> {
    this.#blockedRuns.delete(runId);
    this.#handoffLimitNoted.delete(runId);
    const turn = this.#turns.get(groupId);
    if (turn !== undefined && !isRunning(turn, runId)) return;
    if (turn !== undefined) this.#close(turn);
    await dropQueuedHandoffs(this.db, groupId);
  }

  async #appendQueuedHandoffs(turn: Turn): Promise<void> {
    for (const { handoff, fromName, message } of await listQueuedHandoffs(this.db, turn.groupId)) {
      if (turn.speakers.some((speaker) => speaker.handoff?.id === handoff.id)) continue;
      turn.speakers.push({
        botId: handoff.toBotId,
        trigger: message,
        reason: "handoff",
        handoff: { id: handoff.id, fromBotId: handoff.fromBotId, text: renderHandoffReport({ fromName, ...handoff }) },
      });
    }
  }

  #save(turn: Turn): Promise<void> {
    const { groupId, botMessages } = turn;
    const saved = (this.#saveChains.get(groupId) ?? Promise.resolve())
      .then(() => saveTurnBotMessages(this.db, groupId, botMessages))
      .catch((error: unknown) => console.error(`群 ${groupId} 回合计数没写进库`, error));
    this.#saveChains.set(groupId, saved);
    return saved;
  }

  async #count(turn: Turn, runId: RunId): Promise<void> {
    turn.botMessages += 1;
    await this.#save(turn);
    if (!limitReached(turn.botMessages)) return;
    this.#blockedRuns.add(runId);
    const notice = await appendMessage(this.db, turn.groupId, {
      kind: "system",
      tone: "error",
      text: MENTION_LOOP_NOTICE,
    });
    this.push.push(turn.ownerId, { type: "message", message: notice });
    this.#close(turn);
  }

  async #advance(turn: Turn): Promise<AdvanceOutcome> {
    if (this.#turns.get(turn.groupId) !== turn) return "closed";
    let speaker = turn.handoffs.shift() ?? turn.speakers.shift();
    if (speaker === undefined && turn.mentions.length > 0) {
      turn.round += 1;
      turn.speakers = turn.mentions.splice(0);
      speaker = turn.speakers.shift();
    }
    if (speaker === undefined) {
      this.#close(turn);
      return "exhausted";
    }
    turn.stage = { kind: "sending", speaker, deleted: false };
    let outcome: SendOutcome;
    try {
      outcome = await turn.send(speaker, turn.dispatched > 0);
    } catch (error) {
      if (this.#turns.get(turn.groupId) !== turn) return "closed";
      await this.#failDispatch(turn, speaker, error);
      return "failed";
    }
    if (this.#turns.get(turn.groupId) !== turn) return "closed";
    if (outcome.kind === "gone") {
      this.#close(turn);
      return "gone";
    }
    const deleted = turn.stage.kind === "sending" && turn.stage.deleted;
    if (outcome.kind === "skipped" || deleted) {
      turn.stage = { kind: "idle" };
      return this.#advance(turn);
    }
    if (outcome.kind === "stopped") {
      this.#close(turn);
      return "closed";
    }
    turn.stage = { kind: "running", speaker, runId: outcome.runId };
    turn.dispatched += 1;
    this.#publish(turn);
    return "dispatched";
  }

  /**
   * 派活抛了错，这一位没跑起来，也不知道有没有建出 run。回合收掉，群里留一句，让用户 @ 它再来。
   * 不等代理补发 run_done 来重推：回合已经收掉，补发结账后的推进不会重建它。
   * 先收轮再写提示，提示写不进去时回合状态也已经干净。
   */
  async #failDispatch(turn: Turn, speaker: Speaker, error: unknown): Promise<void> {
    console.error(`群 ${turn.groupId} 派活给 ${speaker.botId} 失败`, error);
    this.#close(turn);
    const name = turn.members.find((member) => member.id === speaker.botId)?.name ?? "它";
    const notice = await appendMessage(this.db, turn.groupId, {
      kind: "system",
      tone: "error",
      text: dispatchFailedNotice(name),
    });
    this.push.push(turn.ownerId, { type: "message", message: notice });
  }

  #snapshot(turn: Turn) {
    return {
      type: "group_turn" as const,
      groupId: turn.groupId,
      epoch: turn.epoch,
      current: turn.stage.kind === "running" ? turn.stage.speaker.botId : null,
      next: [...turn.handoffs, ...turn.speakers].map((speaker) => speaker.botId),
    };
  }

  #publish(turn: Turn): void {
    this.push.push(turn.ownerId, this.#snapshot(turn));
  }

  #close(turn: Turn): void {
    if (this.#turns.get(turn.groupId) !== turn) return;
    this.#turns.delete(turn.groupId);
    turn.stage = { kind: "idle" };
    turn.handoffs.length = 0;
    turn.speakers = [];
    this.#publish(turn);
  }
}
