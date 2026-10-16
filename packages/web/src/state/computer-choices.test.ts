import { describe, expect, it } from "vitest";
import { BotId, GroupId, type ComputerChoices } from "@baize/shared";
import { finishingElsewhere } from "./computer-choices.js";
import { reduce } from "./reducer.js";
import { createClock } from "./stamped.js";
import type { Action, AppState, ReadyState, SessionId } from "./types.js";

const SOLO = GroupId.parse("grp_service");
const TEAM = GroupId.parse("grp_order");
const SERVICE = BotId.parse("bot_service");
const SALES = BotId.parse("bot_sales");

const entered = (): AppState =>
  reduce({ status: "loading" }, {
    type: "ready",
    session: 1 as SessionId,
    user: { id: "usr_chen", email: "chen@baize.dev", name: "陈" },
    bots: [],
    groups: [],
    tools: [],
    settings: {},
    usage: {},
  } as unknown as Action);

const asReady = (state: AppState): ReadyState => {
  if (state.status !== "ready") throw new Error("应当已就绪");
  return state;
};

const run = (state: AppState, ...actions: Action[]): ReadyState => asReady(actions.reduce(reduce, state));

const rowsOf = (state: ReadyState, groupId: GroupId) =>
  state.computerChoices.rows[groupId]?.map(({ botId, kind, runningOn }) => ({ botId, kind, runningOn }));

describe("每个群里每个 Bot 选的电脑", () => {
  it("同一个 Bot 在单聊和项目群里各选各的，按群分开存", () => {
    const next = createClock();
    const solo: ComputerChoices = [{ botId: SERVICE, kind: "remote", runningOn: null }];
    const team: ComputerChoices = [
      { botId: SERVICE, kind: null, runningOn: null },
      { botId: SALES, kind: "local", runningOn: "local" },
    ];
    const state = run(
      entered(),
      { type: "computer_choices_loaded", groupId: SOLO, choices: solo, seq: next() },
      { type: "computer_choices_loaded", groupId: TEAM, choices: team, seq: next() },
    );
    expect(rowsOf(state, SOLO), "单聊里小服用云电脑").toEqual(solo);
    expect(rowsOf(state, TEAM), "项目群里小服没选过，按成员顺序").toEqual(team);
  });

  it("换了电脑只改 kind，runningOn 留着等重拉；比它早发出的那趟拉取回来不把它盖回去", () => {
    const next = createClock();
    const loaded = run(entered(), {
      type: "computer_choices_loaded",
      groupId: SOLO,
      choices: [{ botId: SERVICE, kind: null, runningOn: "local" }],
      seq: next(),
    });
    const stale = next();
    const chosen = run(loaded, {
      type: "computer_choice_set",
      groupId: SOLO,
      botId: SERVICE,
      kind: "remote",
      seq: next(),
    });
    expect(rowsOf(chosen, SOLO)).toEqual([{ botId: SERVICE, kind: "remote", runningOn: "local" }]);

    const late = run(chosen, {
      type: "computer_choices_loaded",
      groupId: SOLO,
      choices: [{ botId: SERVICE, kind: null, runningOn: "local" }],
      seq: stale,
    });
    expect(rowsOf(late, SOLO), "换之前就发出的拉取读到的是旧选择").toEqual([
      { botId: SERVICE, kind: "remote", runningOn: "local" },
    ]);
  });

  it("列表没拉回来之前先到的推送不算这个群拉过，拉回来时号更新的那条留着", () => {
    const next = createClock();
    const request = next();
    const pushed = run(entered(), {
      type: "computer_choice_set",
      groupId: SOLO,
      botId: SERVICE,
      kind: "remote",
      seq: next(),
    });
    expect(pushed.computerChoices.rows[SOLO], "只收到推送，选择器还不该画").toBeUndefined();
    const loaded = run(pushed, {
      type: "computer_choices_loaded",
      groupId: SOLO,
      choices: [{ botId: SERVICE, kind: null, runningOn: null }],
      seq: request,
    });
    expect(rowsOf(loaded, SOLO)).toEqual([{ botId: SERVICE, kind: "remote", runningOn: null }]);
  });
});

describe("这一轮还在原来那台上跑完的群要等跑完的推送来重拉", () => {
  const withRows = (choices: ComputerChoices) =>
    run(entered(), { type: "computer_choices_loaded", groupId: TEAM, choices, seq: createClock()() });

  it("有一个成员选的和正在跑的不是同一台就要等", () => {
    const state = withRows([
      { botId: SERVICE, kind: null, runningOn: null },
      { botId: SALES, kind: "remote", runningOn: "local" },
    ]);
    expect(finishingElsewhere(state, TEAM)).toBe(true);
  });

  it("跑在选的那台上、没在跑、没选过、没拉过的群都不用等", () => {
    expect(finishingElsewhere(withRows([{ botId: SALES, kind: "remote", runningOn: "remote" }]), TEAM)).toBe(false);
    expect(finishingElsewhere(withRows([{ botId: SALES, kind: "remote", runningOn: null }]), TEAM)).toBe(false);
    expect(finishingElsewhere(withRows([{ botId: SALES, kind: null, runningOn: "local" }]), TEAM)).toBe(false);
    expect(finishingElsewhere(asReady(entered()), TEAM)).toBe(false);
  });
});
