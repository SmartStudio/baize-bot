import { describe, expect, it } from "vitest";
import { nextStep, BOT_TURN_TIMEOUT_MS, MAX_REJECTED_ACTIONS, type PlanHand } from "../src/poker/converge-plan.js";
import { apply, newHand, type HandState, type SeatId } from "../src/poker/engine.js";

const blinds = { small: 5, big: 10 };
const engineSeats = ["1", "2", "3", "4"].map((id) => ({ id, stack: 200 }));
const table = {
  seats: [
    { seat: 1, kind: "bot" },
    { seat: 2, kind: "bot" },
    { seat: 3, kind: "bot" },
    { seat: 4, kind: "user" },
  ],
} as const;
const t0 = new Date("2026-10-10T20:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

// 按钮在 1 号：2 号小盲、3 号大盲，翻前第一个说话的是 4 号（你）
const userFirst = () => newHand("编排", engineSeats, "1", blinds);
// 按钮在 4 号：1 号小盲、2 号大盲，翻前第一个说话的是 3 号（牌友）
const botFirst = () => newHand("编排", engineSeats, "4", blinds);

const playing = (state: HandState, turn: PlanHand["turn"] = null): PlanHand => ({ status: "playing", state, turn });
const turnOf = (seat: 1 | 2 | 3 | 4, deadline: Date, attempts = 0) => ({ seat, runId: "run-1", attempts, deadline });

function toEnd(state: HandState): HandState {
  while (state.phase.kind === "betting") {
    const seat = state.phase.pending[0] as SeatId;
    const me = state.seats.find((candidate) => candidate.id === seat);
    const owes = me !== undefined && state.phase.currentBet > me.committed;
    state = apply(state, seat, owes ? { kind: "call" } : { kind: "check" });
  }
  return state;
}

describe("nextStep", () => {
  it("轮到用户时 await_user，没有定时，过期的旧定时也不会替用户出牌", () => {
    const step = nextStep(playing(userFirst()), table, t0);
    expect(step).toEqual({ kind: "await_user" });
    const stale = nextStep(playing(userFirst(), turnOf(4, at(-3_600_000))), table, at(3_600_000));
    expect(stale, "D23 你不限时").toEqual({ kind: "await_user" });
  });

  it("轮到牌友还没派活时 dispatch_bot，seq 是下一个要写的事件序号", () => {
    const state = botFirst();
    const step = nextStep(playing(state), table, t0);
    expect(step).toEqual({ kind: "dispatch_bot", seat: 3, seq: state.events.length });
    const after = apply(state, "3", { kind: "call" });
    const next = nextStep(playing(after), table, t0);
    expect(next).toEqual({ kind: "await_user" });
    const raised = apply(state, "3", { kind: "raise", amount: 30 });
    expect(nextStep(playing(raised), table, t0), "seq 随事件增长，同一个决策点的重复派活能靠它认出来").toEqual({
      kind: "await_user",
    });
  });

  it("上一位的派活记录不算这一位的：换了座位就重新派活", () => {
    const state = apply(botFirst(), "3", { kind: "call" });
    const afterUser = apply(state, "4", { kind: "call" });
    const step = nextStep(playing(afterUser, turnOf(3, at(60_000))), table, t0);
    expect(step).toEqual({ kind: "dispatch_bot", seat: 1, seq: afterUser.events.length });
  });

  it("已派活未超时时 wait_bot", () => {
    const step = nextStep(playing(botFirst(), turnOf(3, at(BOT_TURN_TIMEOUT_MS))), table, at(BOT_TURN_TIMEOUT_MS - 1));
    expect(step).toEqual({ kind: "wait_bot" });
  });

  it("轮到牌友且已超时时 timeout_action，能过牌过牌，否则弃牌", () => {
    const facing = nextStep(playing(botFirst(), turnOf(3, at(BOT_TURN_TIMEOUT_MS))), table, at(BOT_TURN_TIMEOUT_MS));
    expect(facing, "到点那一刻就算超时").toEqual({ kind: "timeout_action", seat: 3, action: { kind: "fold" } });

    let state = botFirst();
    state = apply(state, "3", { kind: "call" });
    state = apply(state, "4", { kind: "call" });
    state = apply(state, "1", { kind: "call" });
    const free = nextStep(playing(state, turnOf(2, at(0))), table, at(1));
    expect(free).toEqual({ kind: "timeout_action", seat: 2, action: { kind: "check" } });
  });

  it("牌友连着出了 MAX_REJECTED_ACTIONS 次非法动作，不等超时直接兜底", () => {
    const turn = turnOf(3, at(BOT_TURN_TIMEOUT_MS), MAX_REJECTED_ACTIONS);
    expect(nextStep(playing(botFirst(), turn), table, t0)).toEqual({
      kind: "timeout_action",
      seat: 3,
      action: { kind: "fold" },
    });
    const almost = turnOf(3, at(BOT_TURN_TIMEOUT_MS), MAX_REJECTED_ACTIONS - 1);
    expect(nextStep(playing(botFirst(), almost), table, t0)).toEqual({ kind: "wait_bot" });
  });

  it("引擎走到 complete 但手牌行还是 playing 时 settle，手牌行已 complete 时 hand_over", () => {
    const done = toEnd(botFirst());
    expect(done.phase.kind).toBe("complete");
    expect(nextStep(playing(done), table, t0)).toEqual({ kind: "settle" });
    expect(nextStep({ status: "complete", state: done, turn: null }, table, t0)).toEqual({ kind: "hand_over" });
  });

  it("不读时钟：同样的输入同样的答案", () => {
    const input = playing(botFirst(), turnOf(3, at(10)));
    expect(nextStep(input, table, at(5))).toEqual(nextStep(input, table, at(5)));
    expect(nextStep(input, table, at(5))).not.toEqual(nextStep(input, table, at(11)));
  });
});
