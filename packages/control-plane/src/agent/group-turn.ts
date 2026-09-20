import type { BotId, ControlToAgent, GroupId, HandoffId, Message, RunId, ServerPush, UserId } from "@baize/shared";
import type { Db } from "../db/client.js";
import { appendMessage } from "../repo/messages.js";
import type { PushHub } from "../ws/hub.js";
import { parseMentions, type RoutingMember } from "./routing.js";

export const BOT_MESSAGE_LIMIT = 10;
export const MENTION_LOOP_NOTICE = "Bot 之间 @ 太多次，停下等你";

export type Speaker = {
  readonly botId: BotId;
  readonly trigger: Message;
  readonly reason: Extract<ControlToAgent, { type: "prompt" }>["reason"];
  readonly handoff?: { readonly id: HandoffId; readonly text: string; readonly fromBotId: BotId };
};

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
};

export class GroupTurns {
  readonly #turns = new Map<string, Turn>();
  readonly #blockedRuns = new Set<RunId>();

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
    const turn: Turn = {
      ...input,
      speakers: [...input.speakers],
      seen: new Set(),
      handoffs: [],
      mentions: [],
      round: 0,
      current: null,
      botMessages: 0,
      dispatched: 0,
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

  queueHandoff(groupId: GroupId, runId: RunId, speaker: Speaker): void {
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId !== runId || turn.botMessages >= BOT_MESSAGE_LIMIT) return;
    turn.handoffs.push(speaker);
    this.#publish(turn);
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
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId !== runId) return;
    turn.current = null;
    await this.#advance(turn);
  }

  abandon(groupId: string, runId: RunId): void {
    this.#blockedRuns.delete(runId);
    const turn = this.#turns.get(groupId);
    if (turn?.current?.runId === runId) this.#close(turn);
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

  #close(turn: Turn): void {
    if (this.#turns.get(turn.groupId) !== turn) return;
    this.#turns.delete(turn.groupId);
    turn.current = null;
    turn.handoffs.length = 0;
    turn.speakers = [];
    this.#publish(turn);
  }
}
