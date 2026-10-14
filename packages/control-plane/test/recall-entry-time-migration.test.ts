import {
  CreateBotResponse,
  CreateGroupResponse,
  EMPTY_WORK_HEAD,
  RecallResponse,
  advanceWorkHead,
  type ControlToAgent,
  type WorkStream,
} from "@baize/shared";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";

const PREVIOUS_MIGRATION = "0036_p3_recall_entry_time.sql";
const MIGRATION = "0037_p3_recall_node_entry_time.sql";
const RUN_AT = "2025-01-01T00:00:00.000Z";
const GROUP_AT = "2024-01-01T00:00:00.000Z";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

type Boundary = {
  id: string;
  timestamp?: unknown;
  extra?: Record<string, unknown>;
  duplicateTimestamp?: string;
  backfillNull?: boolean;
  stream?: WorkStream;
  type?: string;
};
const cases: Boundary[] = [
  { id: "nano-round", timestamp: "2026-10-01T00:00:00.1239999Z" },
  { id: "nano-carry", timestamp: "2026-10-01T00:00:00.9999999Z" },
  { id: "milli", timestamp: "2026-10-01T00:00:00.123Z" },
  { id: "one-digit", timestamp: "2026-10-01T00:00:00.1Z" },
  { id: "offset", timestamp: "2026-10-01T08:00:00.999999999+08:00" },
  {
    id: "nul-key",
    timestamp: "2026-10-01T00:00:00.000Z",
    extra: { "\u0000timestamp": "2030-01-01T00:00:00.000Z" },
    backfillNull: true,
  },
  {
    id: "nul-value",
    timestamp: "2026-10-02T00:00:00.000Z",
    extra: { opaque: "a\u0000b" },
    backfillNull: true,
  },
  { id: "nul-time", timestamp: "2026-10-03T00:00:00.000Z\u0000", backfillNull: true },
  { id: "escaped-nul", timestamp: "2026-10-04T00:00:00.000Z", extra: { opaque: "\\u0000" } },
  {
    id: "three-slashes",
    timestamp: "2026-10-05T00:00:00.000Z",
    extra: { opaque: "\\\u0000" },
    backfillNull: true,
  },
  { id: "four-slashes", timestamp: "2026-10-06T00:00:00.000Z", extra: { opaque: "\\\\u0000" } },
  {
    id: "duplicate-key",
    timestamp: "2030-01-01T00:00:00.000Z",
    duplicateTimestamp: "2026-10-07T00:00:00.000Z",
  },
  { id: "out-of-range", timestamp: "-271821-04-20T00:00:00.000Z" },
  { id: "year-zero", timestamp: "0000-01-01T00:00:00Z" },
  { id: "offset-before-year-one", timestamp: "0001-01-01T00:00:00+08:00" },
  { id: "offset-after-year-9999", timestamp: "9999-12-31T23:59:59-08:00" },
  { id: "non-iso", timestamp: "2026/10/01 00:00:00" },
  { id: "keyword", timestamp: "now" },
  { id: "number", timestamp: 1789000000000 },
  { id: "missing" },
  { id: "calendar-rollover", timestamp: "2026-02-30T00:00:00Z", backfillNull: true },
  { id: "leap-second", timestamp: "2026-10-01T23:59:60Z" },
  { id: "midnight-nano", timestamp: "2026-10-01T24:00:00.000000001Z" },
  { id: "large-offset", timestamp: "2026-10-01T20:00:00+16:00", backfillNull: true },
  { id: "compaction", timestamp: "2026-10-01T00:00:00Z", type: "compaction" },
  { id: "table", timestamp: "2026-10-01T00:00:00Z", stream: "table" },
];
const labels = [..."甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥乾坤震巽"];
const textOf = (index: number) => `边界预算：${labels[index]!}${labels[index]!}`;
const lineOf = (entry: Boundary, index: number) => {
  const line = JSON.stringify({
    type: entry.type ?? "message",
    id: entry.id,
    parentId: null,
    ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
    ...entry.extra,
    message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: textOf(index) }] },
  });
  return entry.duplicateTimestamp === undefined
    ? line
    : `${line.slice(0, -1)},"timestamp":${JSON.stringify(entry.duplicateTimestamp)}}`;
};
const nodeTime = (entry: Boundary, index: number): string | null => {
  if ((entry.stream ?? "chat") !== "chat" || (entry.type ?? "message") !== "message") return null;
  const value = JSON.parse(lineOf(entry, index)) as { timestamp?: unknown };
  if (typeof value.timestamp !== "string" || !ISO_TIME.test(value.timestamp)) return null;
  const milliseconds = Date.parse(value.timestamp);
  if (!Number.isFinite(milliseconds)) return null;
  const at = new Date(milliseconds);
  return at.getUTCFullYear() >= 1 && at.getUTCFullYear() <= 9999 ? at.toISOString() : null;
};
type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

it.each([
  { path: "Node 写入", cause: "turn_end" },
  { path: "Node 写入", cause: "import" },
  { path: "0037 回填", cause: "turn_end" },
  { path: "0037 回填", cause: "import" },
] as const)("$path / $cause：边界条目时间和 HTTP recall 前8条符合 Node 语义或约定回退", async ({ path, cause }) => {
  const backfill = path === "0037 回填";
  const database = await createTestDb(backfill ? { through: PREVIOUS_MIGRATION } : {});
  const { sql } = database;
  let server: RunningServer | undefined;
  let agent: AgentClient | undefined;
  try {
    server = await startServer({
      db: database.db,
      port: 0,
      credentialsKey: TEST_CREDENTIALS_KEY,
      toolSecretKey: "a".repeat(64),
      disconnectGraceMs: 60_000,
      silenceTimeoutMs: 60_000,
      leaseRenewalIntervalMs: 60_000,
      scheduler: { intervalMs: 86_400_000 },
      publisher: { intervalMs: 86_400_000 },
      poker: { intervalMs: 86_400_000 },
    });
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = new ApiClient(server.port);
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const own = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小忆" })).json());
    const peer = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "同事" })).json());
    const current = CreateGroupResponse.parse(
      await (await client.post("/api/groups", { title: "召回入口", botIds: [own.bot.id, peer.bot.id] })).json(),
    );
    const hello = await helloAgent(server.port, computer.computerId, computer.token);
    agent = hello.agent;
    await sql`UPDATE groups SET created_at = ${GROUP_AT} WHERE id = ${own.group.id}`;
    expect((await client.post(`/api/groups/${own.group.id}/messages`, { text: "记下条目" })).status).toBe(201);
    const source: Prompt = await agent.expect("prompt");
    await sql`UPDATE runs SET started_at = ${RUN_AT} WHERE id = ${source.runId}`;

    for (const stream of ["chat", "table"] as const) {
      const batch = cases
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => (entry.stream ?? "chat") === stream);
      if (backfill) {
        for (const [seq, { entry, index }] of batch.entries())
          await sql`
            INSERT INTO work_entries (bot_id, group_id, stream, seq, epoch, owner_id, run_id, entry_id, pi_type, retention, line, search_text)
            VALUES (${own.bot.id}, ${own.group.id}, ${stream}, ${seq}, ${source.lane.epoch}, ${user.id},
              ${cause === "import" ? null : source.runId}, ${entry.id}, ${entry.type ?? "message"}, 'verbatim', ${lineOf(entry, index)}, ${textOf(index)})`;
      } else {
        const lines = batch.map(({ entry, index }) => lineOf(entry, index));
        agent.send({
          type: "work_append",
          lane: { botId: own.bot.id, groupId: own.group.id, stream, epoch: source.lane.epoch },
          runId: cause === "import" ? null : source.runId,
          fromSeq: 0,
          lines,
          head: await advanceWorkHead(EMPTY_WORK_HEAD, lines),
          cause,
        });
      }
    }
    agent.send({
      type: "run_done",
      runId: source.runId,
      botId: own.bot.id,
      groupId: own.group.id,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    await agent.ack(source.runId);
    expect(agent.uplinkAcks().flatMap((ack) => ack.rejected)).toEqual([]);
    if (backfill) {
      const [old] = await sql<{ at: string }[]>`
        SELECT to_char(entry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
        FROM work_entries WHERE entry_id = 'nano-carry'`;
      expect(old?.at, "0036 的秒进位问题已在旧库复现").toBe("2026-10-01T00:00:01.000Z");
      expect(await runMigrations(sql)).toEqual([MIGRATION]);
      expect(await runMigrations(sql)).toEqual([]);
    }
    const rows = await sql<{ entry_id: string; at: string | null }[]>`
      SELECT entry_id, to_char(entry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
      FROM work_entries WHERE bot_id = ${own.bot.id}`;
    expect(rows).toHaveLength(cases.length);
    const byId = new Map(rows.map((row) => [row.entry_id, row.at]));
    const expectedTime = (entry: Boundary, index: number) =>
      backfill && entry.backfillNull ? null : nodeTime(entry, index);
    for (const [index, entry] of cases.entries()) expect(byId.get(entry.id), entry.id).toBe(expectedTime(entry, index));
    expect(byId.get("nano-round")).toBe("2026-10-01T00:00:00.123Z");
    expect(byId.get("nano-carry")).toBe("2026-10-01T00:00:00.999Z");
    expect(byId.get("nul-key")).toBe(backfill ? null : "2026-10-01T00:00:00.000Z");
    expect(await sql`SELECT tgname FROM pg_trigger WHERE tgname = 'work_entries_entry_at'`).toEqual([]);
    expect(
      await sql`SELECT proname FROM pg_proc WHERE proname IN ('work_entry_timestamp', 'work_entries_set_entry_at')`,
    ).toEqual([]);

    expect(
      (await client.post(`/api/groups/${current.group.id}/messages`, { text: "@小忆 召回以前的记录" })).status,
    ).toBe(201);
    const reader: Prompt = await agent.expect("prompt");
    const recall = async (query: string) => {
      const response = await fetch(`${client.origin}/hub/v1/recall`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${hello.config.modelGateway.apiKey}`,
          "x-baize-lane": `${own.bot.id}/${current.group.id}/${reader.lane.epoch}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query }),
      });
      expect(response.status).toBe(200);
      return RecallResponse.parse(await response.json());
    };
    const fallback = cause === "import" ? GROUP_AT : RUN_AT;
    const expected = cases.flatMap((entry, index) =>
      (entry.stream ?? "chat") === "chat" && (entry.type ?? "message") === "message"
        ? [
            {
              index,
              at: expectedTime(entry, index) ?? fallback,
              kind: index % 2 === 0 ? "user" : "assistant",
              excerpt: textOf(index),
            },
          ]
        : [],
    );
    for (const { index, at, kind, excerpt } of expected)
      expect(await recall(`${labels[index]!}${labels[index]!}`), cases[index]!.id).toEqual([
        { groupId: own.group.id, groupTitle: own.bot.name, at, kind, excerpt },
      ]);
    const scores = await sql<{ low: number; high: number }[]>`
      SELECT min(similarity(search_text, '边界预算')) AS low, max(similarity(search_text, '边界预算')) AS high
      FROM work_entries WHERE bot_id = ${own.bot.id}`;
    expect(scores[0]?.low, "同分夹具只按条目时间与 seq 分出先后").toBe(scores[0]?.high);
    expect(await recall("边界预算")).toEqual(
      expected
        .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.index - a.index)
        .slice(0, 8)
        .map(({ at, kind, excerpt }) => ({ groupId: own.group.id, groupTitle: own.bot.name, at, kind, excerpt })),
    );
  } finally {
    agent?.close();
    if (agent !== undefined) await agent.closed();
    await server?.close();
    await database.close();
  }
});
