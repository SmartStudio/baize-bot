import type {
  BotId,
  ControlToAgent,
  GroupId,
  HandoffId,
  Message,
  MessageId,
  RunId,
  ServerPush,
  UserId,
} from "@baize/shared";
import type { Db } from "../db/client.js";
import { appendMessage } from "../repo/messages.js";
import type { PushHub } from "../ws/hub.js";
import { parseMentions, type RoutingMember } from "./routing.js";

export const BOT_MESSAGE_LIMIT = 10;
export const MENTION_LOOP_NOTICE = "Bot 之间 @ 太多次，停下等你";
export const HANDOFF_LIMIT_NOTICE = `这一轮 Bot 已经说满 ${BOT_MESSAGE_LIMIT} 句，这份交接没有交出去`;

export type Speaker = {
  readonly botId: BotId;
  readonly trigger: Message;
  readonly reason: Extract<ControlToAgent, { type: "prompt" }>["reason"];
  readonly handoff?: { readonly id: HandoffId; readonly text: string; readonly fromBotId: BotId };
};

type TurnCost = {
  messageId: MessageId;
  runId: RunId;
  botId: BotId;
  steps: number;
  amount: number;
};

type PassCredit = { steps: number; amount: number };

type HeldPass = PassCredit & { readonly runId: RunId; readonly botId: BotId };

type Turn = {
  readonly groupId: GroupId;
  readonly ownerId: UserId;
  readonly epoch: number;
  readonly members: readonly RoutingMember[];
  readonly send: (speaker: Speaker, includeRecent: boolean) => Promise<RunId | null>;
  readonly seen: Set<string>;
  readonly handoffs: Speaker[];
  readonly mentions: Speaker[];
  speakers: Speaker[];
  round: number;
  current: { readonly speaker: Speaker; readonly runId: RunId } | null;
  botMessages: number;
  dispatched: number;
  summary: TurnCost | null;
  heldPass: HeldPass | null;
};

const EMPTY_PASS: PassCredit = { steps: 0, amount: 0 };

export type PassAbsorption =
  { readonly kind: "merged"; readonly cost: TurnCost } | { readonly kind: "held" } | { readonly kind: "miss" };

export class GroupTurns {
  readonly #turns = new Map<string, Turn>();
  readonly #blockedRuns = new Set<RunId>();
  readonly #handoffLimitNoted = new Set<RunId>();
  // 卡已经建了、但当时的回合收不了的交接。下一个 start 把它们接到用户新消息的目标后面。
  readonly #deferred = new Map<string, Speaker[]>();

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
    readonly send: Turn["send"];
  }): Promise<void> {
    const carried = this.#deferred.get(input.groupId) ?? [];
    this.#deferred.delete(input.groupId);
    const turn: Turn = {
      ...input,
      speakers: [...input.speakers, ...carried],
      seen: new Set(),
      handoffs: [],
      mentions: [],
      round: 0,
      current: null,
      botMessages: 0,
      dispatched: 0,
      summary: null,
      heldPass: null,
    };
    this.#turns.set(input.groupId, turn);
    await this.#advance(turn);
  }

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

  queueHandoff(groupId: GroupId, runId: RunId, speaker: Speaker): void {
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId === runId && turn.botMessages < BOT_MESSAGE_LIMIT && !this.#blockedRuns.has(runId)) {
      turn.handoffs.push(speaker);
      this.#publish(turn);
      return;
    }
    // 卡已经建了，目标不能丢。这个回合收不了就排到用户新消息的目标后面。
    this.#enqueueAfterSpeakers(groupId, speaker);
  }

  /**
   * `(pass)` 不单落花费。这一轮已经有汇总行就并进去，还没有就先记着，等下一次真回话的花费一起写。
   * 对不上当前回合时返回 miss，调用方照旧单落一条。
   */
  absorbPassCost(groupId: GroupId, runId: RunId, extra: PassCredit & { readonly botId: BotId }): PassAbsorption {
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId !== runId) return { kind: "miss" };
    if (turn.summary === null) {
      turn.heldPass = {
        steps: (turn.heldPass?.steps ?? 0) + extra.steps,
        amount: (turn.heldPass?.amount ?? 0) + extra.amount,
        runId,
        botId: extra.botId,
      };
      return { kind: "held" };
    }
    turn.summary = {
      ...turn.summary,
      steps: turn.summary.steps + extra.steps,
      amount: turn.summary.amount + extra.amount,
    };
    return { kind: "merged", cost: turn.summary };
  }

  takeHeldPass(groupId: GroupId, runId: RunId): PassCredit {
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId !== runId || turn.heldPass === null) return { ...EMPTY_PASS };
    const held = turn.heldPass;
    turn.heldPass = null;
    return held;
  }

  rememberCost(groupId: GroupId, runId: RunId, cost: TurnCost): void {
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId !== runId) return;
    turn.summary = cost;
  }

  async recordBotMessage(groupId: GroupId, runId: RunId, message: Message): Promise<void> {
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId !== runId || message.body.kind !== "bot" || turn.seen.has(message.id)) return;
    turn.seen.add(message.id);
    const mentions = message.body.mentions ?? parseMentions(message.body.text, turn.members);
    for (const botId of mentions) {
      if (turn.mentions.some((speaker) => speaker.botId === botId)) continue;
      turn.mentions.push({ botId, trigger: message, reason: "mentioned" });
    }
    await this.#count(turn, runId);
  }

  async recordHandoff(groupId: GroupId, runId: RunId): Promise<void> {
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId !== runId) return;
    await this.#count(turn, runId);
  }

  async runDone(groupId: GroupId, runId: RunId): Promise<void> {
    this.#blockedRuns.delete(runId);
    this.#handoffLimitNoted.delete(runId);
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId !== runId) return;
    turn.current = null;
    await this.#advance(turn);
  }

  abandon(groupId: GroupId, runId: RunId): void {
    this.#blockedRuns.delete(runId);
    this.#handoffLimitNoted.delete(runId);
    this.#deferred.delete(groupId);
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId === runId) this.#close(turn, false);
  }

  async #count(turn: Turn, runId: RunId): Promise<void> {
    turn.botMessages += 1;
    if (turn.botMessages < BOT_MESSAGE_LIMIT) return;
    this.#blockedRuns.add(runId);
    const notice = await appendMessage(this.db, turn.groupId, {
      kind: "system",
      tone: "error",
      text: MENTION_LOOP_NOTICE,
    });
    this.push.push(turn.ownerId, { type: "message", message: notice });
    this.#close(turn);
  }

  async #advance(turn: Turn): Promise<void> {
    if (this.#turns.get(turn.groupId) !== turn) return;
    let speaker = turn.handoffs.shift() ?? turn.speakers.shift();
    if (speaker === undefined && turn.mentions.length > 0) {
      turn.round += 1;
      turn.speakers = turn.mentions.splice(0);
      speaker = turn.speakers.shift();
    }
    if (speaker === undefined) {
      this.#close(turn);
      return;
    }
    const runId = await turn.send(speaker, turn.dispatched > 0);
    if (this.#turns.get(turn.groupId) !== turn) return;
    if (runId === null) {
      this.#close(turn);
      return;
    }
    turn.current = { speaker, runId };
    turn.dispatched += 1;
    this.#publish(turn);
  }

  #snapshot(turn: Turn) {
    return {
      type: "group_turn" as const,
      groupId: turn.groupId,
      epoch: turn.epoch,
      current: turn.current?.speaker.botId ?? null,
      next: [...turn.handoffs, ...turn.speakers].map((speaker) => speaker.botId),
    };
  }

  #publish(turn: Turn): void {
    this.push.push(turn.ownerId, this.#snapshot(turn));
  }

  #enqueueAfterSpeakers(groupId: GroupId, speaker: Speaker): void {
    const turn = this.#turns.get(groupId);
    if (turn !== undefined) {
      turn.speakers.push(speaker);
      this.#publish(turn);
      return;
    }
    const queued = this.#deferred.get(groupId) ?? [];
    queued.push(speaker);
    this.#deferred.set(groupId, queued);
  }

  #close(turn: Turn, carryHandoffs = true): void {
    if (this.#turns.get(turn.groupId) !== turn) return;
    // 用户插话时，没派出的交接目标不管排在 handoffs 还是 speakers 里都带到下一回合，卡已经建了。
    const pending = carryHandoffs
      ? [...turn.handoffs, ...turn.speakers.filter((speaker) => speaker.handoff !== undefined)]
      : [];
    this.#turns.delete(turn.groupId);
    turn.current = null;
    turn.handoffs.length = 0;
    turn.speakers = [];
    this.#publish(turn);
    if (pending.length > 0) this.#deferred.set(turn.groupId, [...(this.#deferred.get(turn.groupId) ?? []), ...pending]);
    turn.heldPass = null;
  }
}
