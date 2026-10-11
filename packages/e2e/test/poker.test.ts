import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ControlToAgent,
  MessageListResponse,
  POKER_PERSONAS,
  PokerTableResponse,
  type PokerAction,
  type PokerCard,
  type PokerPersona,
  type PokerTableView,
} from "@baize/shared";
import { configurePoker } from "../../control-plane/src/poker/converge.js";
import { newHand } from "../../control-plane/src/poker/engine.js";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream, type ChatRequest, type FakeUpstream, type ScriptedTurn } from "../src/upstream.js";

const CASES = [
  "牌友的请求体里找不到用户和别的牌友的底牌与种子。",
  "问老白的请求里有用户底牌、没有牌友底牌。",
  "牌友在没人下注时跟注被引擎拒绝，重试一次后成功。",
  "上游挂住时牌友超时被兜底，手能打完。",
  "一整手打完筹码守恒。",
  "散场后复盘有三手。",
  "换人后下一手的上游请求里是新人设。",
  "~/.pi 没有新文件。",
] as const;
const poll = { timeout: 15_000, interval: 25 };
const textTurn: ScriptedTurn = { textChunks: ["行动完成。"], usage: { input: 20, output: 5 } };
const PRIVATE_HINT = "私密建议探针：先跟注观察。";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : JSON.stringify(part),
    )
    .join("");
}

function requestTurn(request: ChatRequest) {
  const index = request.messages.findLastIndex((message) => message.role === "user");
  if (index < 0) throw new Error("牌桌请求没有 user 消息");
  const prompt = contentText(request.messages[index]?.content);
  const system = request.messages.filter((message) => message.role === "system").map((m) => contentText(m.content));
  const persona = (Object.keys(POKER_PERSONAS) as PokerPersona[]).find((key) =>
    system.some((part) => part.includes(`你是${POKER_PERSONAS[key].name}，`)),
  );
  if (persona === undefined) throw new Error("系统提示里没有预置牌友人设");
  // 会话跨决策点和手牌续用，只看最新 user 之后的工具结果，不能把上一手的工具结果当成本轮收尾。
  const tools = request.messages.slice(index + 1).filter((message) => message.role === "tool");
  return { prompt, persona, tools };
}

type Decision = { persona: PokerPersona; handId: string; seq: number; seat: string };
type ScriptAction = Decision & { action: string; callId: string };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function pokerScript(options: { rejectOnce?: boolean; hold?: ReturnType<typeof gate> } = {}) {
  const actions: ScriptAction[] = [];
  let rejected: Decision | undefined;
  let held: Decision | undefined;
  const script = (request: ChatRequest): ScriptedTurn => {
    const { prompt, persona, tools } = requestTurn(request);
    if (persona === "laobai") {
      if (!prompt.startsWith("散场复盘：")) return { ...textTurn, textChunks: [PRIVATE_HINT] };
      if (tools.length > 0) return textTurn;
      const numbers = [...prompt.matchAll(/第 (\d+) 手：/g)].map((match) => Number(match[1]));
      return {
        ...textTurn,
        textChunks: [],
        toolCall: {
          id: "review",
          name: "poker_review",
          args: {
            hands: numbers.map((number) => ({
              number,
              title: `第 ${number} 手复盘`,
              text: "按位置和合法动作控制投入。",
            })),
          },
        },
      };
    }
    const result = tools.at(-1);
    if (result !== undefined && contentText(result.content).includes("出牌已确认。")) return textTurn;
    const hand = /本手：([^；]+)；决策点：(\d+)/.exec(prompt);
    const seat = /你的位置：(\d)，/.exec(prompt)?.[1];
    const legal = /^合法动作：(.*)$/m.exec(prompt)?.[1];
    if (hand?.[1] === undefined || seat === undefined || legal === undefined) throw new Error("牌友请求缺少决策点");
    const decision: Decision = { persona, handId: hand[1], seq: Number(hand[2]), seat };
    if (options.hold !== undefined && held === undefined) {
      held = decision;
      return { ...textTurn, textChunks: [() => options.hold!.promise, "迟到的回答。"] };
    }
    let action = legal.includes("；过牌") ? "check" : "call";
    if (options.rejectOnce && rejected === undefined && legal.startsWith("待跟注 0；")) {
      rejected = decision;
      action = "call";
    }
    const callId = `act-${actions.length + 1}`;
    actions.push({ ...decision, action, callId });
    return {
      ...textTurn,
      textChunks: [],
      toolCall: {
        id: callId,
        name: "poker_act",
        args: { action, say: `${POKER_PERSONAS[persona].name}在${seat}号位出牌。` },
      },
    };
  };
  return { script, actions, rejected: () => rejected, held: () => held };
}

async function withTable(
  run: (
    stack: Stack,
    table: PokerTableView,
    upstream: FakeUpstream,
    script: ReturnType<typeof pokerScript>,
  ) => Promise<void>,
  options: Parameters<typeof pokerScript>[0] = {},
) {
  const script = pokerScript(options);
  const upstream = await startUpstream(script.script);
  let stack: Stack | undefined;
  try {
    stack = await startStack({ upstreamBaseUrl: upstream.baseUrl, priceInputPerM: 3, priceOutputPerM: 15 });
    const before = stack.configsApplied();
    const { table } = PokerTableResponse.parse(await stack.post("/api/poker/tables", { requestId: "p3-e2e" }));
    await expect.poll(() => stack!.configsApplied(), poll).toBeGreaterThan(before);
    await run(stack, table, upstream, script);
  } finally {
    options.hold?.release();
    try {
      await stack?.close();
    } finally {
      await upstream.close();
    }
  }
}

async function openHand(stack: Stack, table: PokerTableView) {
  return PokerTableResponse.parse(await stack.post(`/api/poker/tables/${table.groupId}/hands`, {})).table;
}

async function waitTable(stack: Stack, table: PokerTableView, ready: (view: PokerTableView) => boolean) {
  let current = table;
  while (!ready(current)) {
    const push = await stack.nextPush();
    if (
      push.type === "poker_table_updated" &&
      push.table.groupId === table.groupId &&
      push.table.version > current.version
    )
      current = push.table;
  }
  return current;
}

function passiveAction(table: PokerTableView): PokerAction {
  const legal = table.hand?.view.legal;
  if (legal?.kind !== "your_turn") throw new Error("还没轮到用户出牌");
  return legal.options.some((option) => option.kind === "check") ? { kind: "check" } : { kind: "call" };
}

async function act(stack: Stack, table: PokerTableView, action: PokerAction) {
  if (table.hand === null) throw new Error("没有正在打的手牌");
  return PokerTableResponse.parse(
    await stack.post(`/api/poker/hands/${table.hand.id}/act`, { seq: table.hand.view.events.length, action }),
  ).table;
}

async function playHand(stack: Stack, table: PokerTableView, snapshots: PokerTableView[] = []) {
  let current = table;
  let userActions = 0;
  snapshots.push(current);
  while (current.status === "in_hand") {
    current = await waitTable(stack, current, (view) => view.status === "idle" || view.hand?.toAct === 4);
    snapshots.push(current);
    if (current.status === "idle") break;
    if (++userActions > 20) throw new Error("一手牌超过预期的用户行动次数");
    current = await act(stack, current, passiveAction(current));
    snapshots.push(current);
  }
  await settle(stack, table.groupId);
  return current;
}

async function settle(stack: Stack, groupId: string) {
  await expect
    .poll(async () => {
      const [row] = await stack.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM runs WHERE group_id = ${groupId} AND ended_at IS NULL
      `;
      return row?.count;
    }, poll)
    .toBe(0);
}

async function askHint(stack: Stack, table: PokerTableView) {
  const hand = table.hand;
  if (hand?.toAct !== 4) throw new Error("问牌前应轮到用户");
  const waiting = PokerTableResponse.parse(
    await stack.post(`/api/poker/hands/${hand.id}/hint`, { seq: hand.view.events.length }),
  ).table;
  const answered = await waitTable(stack, waiting, (view) => view.hint?.status === "done");
  await settle(stack, table.groupId);
  return answered;
}

async function secretsOf(stack: Stack, table: PokerTableView) {
  const [row] = await stack.sql<
    {
      seed: string;
      seats_start: { seat: number; stack: number }[];
      button_seat: number;
      blinds: { small: number; big: number };
    }[]
  >`SELECT seed, seats_start, button_seat, blinds FROM poker_hands WHERE id = ${table.hand?.id ?? ""}`;
  if (row === undefined) throw new Error("库里没有这手牌");
  const state = newHand(
    row.seed,
    row.seats_start.map((seat) => ({ id: String(seat.seat), stack: seat.stack })),
    String(row.button_seat),
    row.blinds,
  );
  return { seed: row.seed, seats: state.seats };
}

function cardsIn(request: ChatRequest): Set<string> {
  const raw = JSON.stringify(request);
  const suits: Record<string, string> = { "♠": "s", "♥": "h", "♦": "d", "♣": "c" };
  return new Set([
    ...(raw.match(/\b[2-9TJQKA][shdc]\b/g) ?? []),
    ...[...raw.matchAll(/(10|[2-9TJQKA])([♠♥♦♣])/g)].map(
      (match) => `${match[1] === "10" ? "T" : match[1]}${suits[match[2]!]}`,
    ),
  ]);
}

function assertHidden(request: ChatRequest, forbidden: readonly PokerCard[], seed: string, message: string) {
  for (const card of forbidden) expect(cardsIn(request).has(card), message).toBe(false);
  expect(JSON.stringify(request), message).not.toContain(seed);
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .toSorted();
}

describe("端到端：U15 牌局", () => {
  let piBefore: Set<string>;
  beforeAll(() => {
    piBefore = new Set(filesUnder(join(homedir(), ".pi")));
  });

  it(CASES[0], async () => {
    await withTable(async (stack, table, upstream) => {
      const opened = await openHand(stack, table);
      const secrets = await secretsOf(stack, opened);
      const advised = await askHint(stack, opened);
      await playHand(stack, advised);
      const requests = upstream.requests().filter((request) => requestTurn(request).persona !== "laobai");
      expect(requests.length, CASES[0]).toBeGreaterThan(0);
      expect(new Set(requests.map((request) => requestTurn(request).persona)), CASES[0]).toEqual(
        new Set(["leopard", "old_k", "jasmine"]),
      );
      for (const request of requests) {
        const seat = /你的位置：(\d)，/.exec(requestTurn(request).prompt)?.[1];
        const mine = secrets.seats.find((candidate) => candidate.id === seat);
        expect(mine, CASES[0]).toBeDefined();
        for (const card of mine!.hole) expect(cardsIn(request).has(card), CASES[0]).toBe(true);
        assertHidden(
          request,
          secrets.seats.filter((candidate) => candidate.id !== seat).flatMap((s) => s.hole),
          secrets.seed,
          CASES[0],
        );
        expect(JSON.stringify(request), CASES[0]).not.toContain(PRIVATE_HINT);
      }
    });
  });

  it(CASES[1], async () => {
    await withTable(async (stack, table, upstream) => {
      const opened = await openHand(stack, table);
      const secrets = await secretsOf(stack, opened);
      const answered = await askHint(stack, opened);
      const requests = upstream.requests().filter((request) => requestTurn(request).persona === "laobai");
      expect(requests, CASES[1]).toHaveLength(1);
      for (const request of requests) {
        for (const card of opened.hand!.view.hole) expect(cardsIn(request).has(card), CASES[1]).toBe(true);
        assertHidden(
          request,
          secrets.seats.filter((seat) => seat.id !== "4").flatMap((s) => s.hole),
          secrets.seed,
          CASES[1],
        );
      }
      const messages = MessageListResponse.parse(await stack.get(`/api/groups/${table.groupId}/messages`)).messages;
      expect(messages.find((message) => message.id === answered.hint?.messageId)?.body, CASES[1]).toMatchObject({
        kind: "bot",
        text: PRIVATE_HINT,
        streaming: false,
      });
      await playHand(stack, answered);
    });
  });

  it(CASES[2], async () => {
    await withTable(
      async (stack, table, upstream, script) => {
        const completed = await playHand(stack, await openHand(stack, table));
        const rejected = script.rejected();
        expect(rejected, CASES[2]).toBeDefined();
        const actions = script.actions.filter(
          (action) => action.handId === rejected?.handId && action.seq === rejected.seq,
        );
        expect(
          actions.map((action) => action.action),
          CASES[2],
        ).toEqual(["call", "check"]);
        const rows = await stack.sql<{ body: { text: string } }[]>`
        SELECT body FROM messages WHERE group_id = ${table.groupId} AND id LIKE 'poker-result:%'
      `;
        const receipts = rows
          .map((row) => ControlToAgent.parse(JSON.parse(row.body.text)))
          .flatMap((message) =>
            message.type === "poker_result" && actions.some((action) => action.callId === message.callId)
              ? [message]
              : [],
          );
        expect(receipts.find((receipt) => receipt.callId === actions[0]?.callId)?.result, CASES[2]).toEqual({
          ok: false,
          error: "没人下注，不能跟注，可以过牌",
        });
        expect(receipts.find((receipt) => receipt.callId === actions[1]?.callId)?.result, CASES[2]).toEqual({
          ok: true,
        });
        expect(new Set(receipts.map((receipt) => receipt.runId)).size, CASES[2]).toBe(1);
        expect(
          upstream
            .requests()
            .some((request) =>
              requestTurn(request).tools.some((tool) =>
                contentText(tool.content).includes("没人下注，不能跟注，可以过牌"),
              ),
            ),
          CASES[2],
        ).toBe(true);
        expect(
          completed.hand?.view.events.filter(
            (event) =>
              event.kind === "action" &&
              event.seatId === rejected?.seat &&
              event.action.kind === "call" &&
              event.put === 0,
          ),
          CASES[2],
        ).toEqual([]);
      },
      { rejectOnce: true },
    );
  });

  it(CASES[3], async () => {
    const hold = gate();
    await withTable(
      async (stack, table, upstream, script) => {
        let clockOffset = 0;
        configurePoker(stack.db, { now: () => new Date(Date.now() + clockOffset) });
        const opened = await openHand(stack, table);
        const waiting = await act(stack, opened, passiveAction(opened));
        await expect.poll(() => script.held(), poll).toBeDefined();
        expect(script.held()?.seat, CASES[3]).toBe("1");
        expect(upstream.requests(), CASES[3]).toHaveLength(1);
        // 等真请求已挂住再推进现有控制面时钟；生产 sweeper 负责实际超时、弃牌和后续派活。
        clockOffset = 60_001;
        const completed = await playHand(stack, waiting);
        expect(completed.status, CASES[3]).toBe("idle");
        expect(completed.hand?.view.events, CASES[3]).toContainEqual({
          kind: "action",
          seatId: "1",
          action: { kind: "fold" },
          put: 0,
        });
        const messages = MessageListResponse.parse(await stack.get(`/api/groups/${table.groupId}/messages`)).messages;
        expect(
          messages.some(
            (message) => message.body.kind === "bot" && message.body.text === "阿豹没有及时出牌，按兜底处理",
          ),
          CASES[3],
        ).toBe(true);
        expect(
          script.actions.some((action) => action.persona === "leopard"),
          CASES[3],
        ).toBe(false);
      },
      { hold },
    );
  });

  it(CASES[4], async () => {
    await withTable(async (stack, table) => {
      const total = table.seats.reduce((sum, seat) => sum + seat.stack, 0);
      const opened = await openHand(stack, table);
      const legal = opened.hand?.view.legal;
      const raise = legal?.kind === "your_turn" ? legal.options.find((option) => option.kind === "raise") : undefined;
      if (raise?.kind !== "raise") throw new Error("首个用户决策点应能加注");
      const snapshots = [opened];
      const completed = await playHand(
        stack,
        await act(stack, opened, { kind: "raise", amount: raise.min }),
        snapshots,
      );
      for (const view of snapshots) {
        const stacks = view.seats.reduce((sum, seat) => sum + seat.stack, 0);
        const pot = view.hand?.view.street === "complete" ? 0 : (view.hand?.view.pot ?? 0);
        expect(stacks + pot, CASES[4]).toBe(total);
      }
      expect(
        completed.seats.reduce((sum, seat) => sum + seat.stack, 0),
        CASES[4],
      ).toBe(total);
      expect(
        completed.hand?.view.events.filter((event) => event.kind === "showdown"),
        CASES[4],
      ).toHaveLength(4);
      const awards = completed.hand?.view.awards ?? [];
      expect(
        awards.reduce((sum, award) => sum + award.amount, 0),
        CASES[4],
      ).toBe(raise.min * 4);
      const stored = PokerTableResponse.parse(await stack.get(`/api/poker/tables/${table.groupId}`)).table;
      expect(
        stored.seats.map((seat) => ({ seat: seat.seat, stack: seat.stack })),
        CASES[4],
      ).toEqual(completed.seats.map((seat) => ({ seat: seat.seat, stack: seat.stack })));
    });
  });

  it(CASES[5], async () => {
    await withTable(async (stack, table, upstream) => {
      for (let hand = 0; hand < 3; hand++) await playHand(stack, await openHand(stack, table));
      const leaving = PokerTableResponse.parse(await stack.post(`/api/poker/tables/${table.groupId}/leave`, {})).table;
      const reviewed = await waitTable(stack, leaving, (view) => view.lastReview !== null);
      await settle(stack, table.groupId);
      expect(reviewed.session, CASES[5]).toBeNull();
      expect(reviewed.lastReview?.hands, CASES[5]).toEqual(
        [1, 2, 3].map((number) => ({
          number,
          title: `第 ${number} 手复盘`,
          text: "按位置和合法动作控制投入。",
        })),
      );
      const reviewRequest = upstream.requests().find((request) => requestTurn(request).prompt.startsWith("散场复盘："));
      expect(reviewRequest, CASES[5]).toBeDefined();
      expect(requestTurn(reviewRequest!).persona, CASES[5]).toBe("laobai");
      expect(
        [...requestTurn(reviewRequest!).prompt.matchAll(/第 (\d+) 手：/g)].map((match) => Number(match[1])),
        CASES[5],
      ).toEqual([1, 2, 3]);
      const stored = PokerTableResponse.parse(await stack.get(`/api/poker/tables/${table.groupId}`)).table;
      expect(stored.lastReview, CASES[5]).toEqual(reviewed.lastReview);
    });
  });

  it(CASES[6], async () => {
    await withTable(async (stack, table, upstream) => {
      const first = await playHand(stack, await openHand(stack, table));
      expect(
        upstream.requests().some((request) => requestTurn(request).persona === "jasmine"),
        CASES[6],
      ).toBe(true);
      const beforeSwap = PokerTableResponse.parse(await stack.get(`/api/poker/tables/${table.groupId}`)).table;
      const swapped = PokerTableResponse.parse(
        await stack.post(`/api/poker/tables/${table.groupId}/seats/3`, { persona: "dalu" }),
      ).table;
      expect(
        swapped.seats.filter((seat) => seat.seat !== 3),
        CASES[6],
      ).toEqual(beforeSwap.seats.filter((seat) => seat.seat !== 3));
      expect(
        swapped.seats.find((seat) => seat.seat === 3),
        CASES[6],
      ).toMatchObject({
        name: "大刘",
        persona: "dalu",
        stack: first.seats.find((seat) => seat.seat === 3)?.stack,
      });
      const before = upstream.requests().length;
      await playHand(stack, await openHand(stack, swapped));
      const requests = upstream.requests().slice(before);
      const thirdSeat = requests.filter((request) => /你的位置：3，/.test(requestTurn(request).prompt));
      expect(thirdSeat.length, CASES[6]).toBeGreaterThan(0);
      expect(new Set(thirdSeat.map((request) => requestTurn(request).persona)), CASES[6]).toEqual(new Set(["dalu"]));
      expect(
        requests.some((request) => requestTurn(request).persona === "jasmine"),
        CASES[6],
      ).toBe(false);
      const messages = MessageListResponse.parse(await stack.get(`/api/groups/${table.groupId}/messages`)).messages;
      expect(
        messages.some((message) => message.body.kind === "bot" && message.body.text === "大刘在3号位出牌。"),
        CASES[6],
      ).toBe(true);
    });
  });

  it(CASES[7], async () => {
    await withTable(async (stack, table) => {
      await playHand(stack, await askHint(stack, await openHand(stack, table)));
      const leaving = PokerTableResponse.parse(await stack.post(`/api/poker/tables/${table.groupId}/leave`, {})).table;
      await waitTable(stack, leaving, (view) => view.lastReview !== null);
      await settle(stack, table.groupId);
      const files = filesUnder(stack.dataDir);
      expect(
        files.some((path) => path.endsWith("auth.json")),
        CASES[7],
      ).toBe(true);
      expect(
        files.some((path) => path.endsWith(".jsonl")),
        CASES[7],
      ).toBe(true);
      expect(
        filesUnder(join(homedir(), ".pi")).filter((path) => !piBefore.has(path)),
        CASES[7],
      ).toEqual([]);
    });
    expect(
      filesUnder(join(homedir(), ".pi")).filter((path) => !piBefore.has(path)),
      CASES[7],
    ).toEqual([]);
  });
});
