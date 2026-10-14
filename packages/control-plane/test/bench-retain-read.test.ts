import { writeFileSync } from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  CreateBotResponse,
  CreateGroupResponse,
  EMPTY_WORK_HEAD,
  GroupId,
  HubLaneSnapshot,
  RecallResponse,
  UplinkAck,
  advanceWorkHead,
  type BotId,
  type ControlToAgent,
  type UserId,
  type WorkAppend,
} from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { databaseUrl } from "../src/env.js";
import { readWorkLane, recallWorkRecords } from "../src/repo/work-records.js";
import { startServer, type RunningServer } from "../src/server.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { ApiClient, TEST_CREDENTIALS_KEY } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser } from "./helpers/fixtures.js";

// BENCH_RETAIN_READ=1 pnpm --filter @baize/control-plane exec vitest run test/bench-retain-read.test.ts
// 可选：BENCH_RETAIN_READ_REPORT=<json 路径>、BENCH_RETAIN_READ_RUNS=<次数，默认 7>、BENCH_RETAIN_READ_ENTRIES=<条数，默认 10000>
const enabled = process.env["BENCH_RETAIN_READ"] !== undefined;
const RUNS = Number(process.env["BENCH_RETAIN_READ_RUNS"] ?? 7);
const ENTRIES = Number(process.env["BENCH_RETAIN_READ_ENTRIES"] ?? 10_000);
const PAGE = 200;
const FRAME_LINES = 64;
const COMMON = "预算";
const MEDIUM = "供应商";
const RARE = "罕见词条甲";

type Prompt = Extract<ControlToAgent, { type: "prompt" }>;

const vocabulary = [
  "项目",
  "进度",
  "客户",
  "评审",
  "排期",
  "风险",
  "合同",
  "报价",
  "发布",
  "复盘",
  "采购",
  "库存",
  "上线",
];

function text(index: number): string {
  let seed = index * 2654435761;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const words: string[] = [`第${index}条`];
  if (index % 5 !== 0) words.push(COMMON);
  if (index % 50 === 0) words.push(MEDIUM);
  if (index % 1000 === 7) words.push(RARE);
  while (words.join("").length < 340) words.push(vocabulary[next() % vocabulary.length]!);
  return words.join("");
}

function line(index: number): string {
  return JSON.stringify({
    type: "message",
    id: `m${index}`,
    parentId: index === 0 ? null : `m${index - 1}`,
    timestamp: new Date(Date.UTC(2026, 9, 1) + Math.floor(index / 3) * 60_000).toISOString(),
    message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: text(index) }] },
  });
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const summary = (values: number[]) => ({
  runs: values.length,
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
});

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await run();
  return { ms: performance.now() - start, value };
}

describe.skipIf(!enabled)("bench：Hub 翻完整条流和 recall 的读放大", () => {
  let database: TestDb;
  let server: RunningServer;
  let agent: AgentClient;
  let counted: ReturnType<typeof postgres>;
  let received = 0;

  beforeAll(async () => {
    database = await createTestDb();
    server = await startServer({
      db: database.db,
      port: 0,
      credentialsKey: TEST_CREDENTIALS_KEY,
      toolSecretKey: "a".repeat(64),
      disconnectGraceMs: 60_000,
      silenceTimeoutMs: 600_000,
      leaseRenewalIntervalMs: 60_000,
      scheduler: { intervalMs: 86_400_000 },
      publisher: { intervalMs: 86_400_000 },
      poker: { intervalMs: 86_400_000 },
    });
    const url = new URL(databaseUrl());
    // postgres.js 运行时支持 socket 选项，类型里没声明；先放进变量绕开字面量的多余属性检查。
    const options = {
      host: url.hostname,
      port: Number(url.port),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: database.databaseName,
      max: 1,
      socket: async () => {
        const socket = net.connect(Number(url.port), url.hostname);
        await once(socket, "connect");
        socket.on("data", (chunk: Buffer) => {
          received += chunk.length;
        });
        return socket;
      },
    };
    counted = postgres(options);
  }, 120_000);

  afterAll(async () => {
    agent?.close();
    await counted?.end();
    await server?.close();
    await database?.close();
  });

  it("量改动前后的读耗时和库到进程的字节数", async () => {
    const user = await makeUser(database.db);
    const computer = await makeComputer(database.db, user.id);
    const client = new ApiClient(server.port);
    expect((await client.login(user.email, PASSWORD)).status).toBe(200);
    const created = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "小录" })).json());
    const botId: BotId = created.bot.id;
    const groupId = created.group.id;
    const ownerId: UserId = user.id;
    const hello = await helloAgent(server.port, computer.computerId, computer.token, [], { piSessionVersion: 3 });
    agent = hello.agent;
    expect((await client.post(`/api/groups/${groupId}/messages`, { text: "记录这次活" })).status).toBe(201);
    const prompt: Prompt = await agent.expect("prompt");

    let head = EMPTY_WORK_HEAD;
    for (let from = 0; from < ENTRIES; from += FRAME_LINES) {
      const lines = Array.from({ length: Math.min(FRAME_LINES, ENTRIES - from) }, (_, offset) => line(from + offset));
      head = await advanceWorkHead(head, lines);
      const body: WorkAppend = {
        type: "work_append",
        lane: { botId, groupId, stream: "chat", epoch: prompt.lane.epoch },
        runId: prompt.runId,
        fromSeq: from,
        lines,
        head,
        cause: "turn_end",
      };
      const seq = agent.sendMalformedReliable(body);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等上行 ${seq} 确认超时`)), 30_000);
        const check = (ack: UplinkAck) => {
          if (ack.upTo < seq) return false;
          clearTimeout(timer);
          const rejected = ack.rejected.find((entry) => entry.seq === seq);
          if (rejected === undefined) resolve();
          else reject(new Error(`上行被拒收：${JSON.stringify(rejected)}`));
          return true;
        };
        if (agent.uplinkAcks().some(check)) return;
        const onMessage = (raw: import("ws").RawData) => {
          const value: unknown = JSON.parse(raw.toString());
          if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "uplink_ack") return;
          if (check(UplinkAck.parse(value))) agent.socket.off("message", onMessage);
        };
        agent.socket.on("message", onMessage);
      });
    }
    const [stored] = await database.sql<{ next_seq: number; bytes: string }[]>`
        SELECT s.next_seq, (SELECT sum(octet_length(line)) FROM work_entries WHERE bot_id = ${botId} AND group_id = ${groupId}) AS bytes
        FROM work_streams s WHERE s.bot_id = ${botId} AND s.group_id = ${groupId} AND s.stream = 'chat'`;
    expect(stored?.next_seq).toBe(ENTRIES);

    const peer = CreateBotResponse.parse(await (await client.post("/api/bots", { name: "同事" })).json());
    await agent.expect("config");
    const entry = CreateGroupResponse.parse(
      await (await client.post("/api/groups", { title: "召回入口", botIds: [botId, peer.bot.id] })).json(),
    );
    expect((await client.post(`/api/groups/${entry.group.id}/messages`, { text: "@小录 查以前的记录" })).status).toBe(
      201,
    );
    const reader: Prompt = await agent.expect("prompt");
    await database.sql`ANALYZE work_entries`;
    await database.sql`SELECT gin_clean_pending_list('work_entries_chat_search_idx'::regclass)`;

    const headers = (epoch: number, lane: string) => ({
      authorization: `Bearer ${hello.config.modelGateway.apiKey}`,
      "x-baize-lane": `${botId}/${lane}/${epoch}`,
    });
    const walkHttp = async () => {
      let after = -1;
      let pages = 0;
      let total = 0;
      for (;;) {
        const response = await fetch(
          `${client.origin}/hub/v1/lanes/${botId}/${groupId}/chat?after=${after}&limit=${PAGE}`,
          {
            headers: headers(prompt.lane.epoch, groupId),
          },
        );
        expect(response.status).toBe(200);
        const page = HubLaneSnapshot.parse(await response.json());
        pages += 1;
        total += page.entries.length;
        if (page.entries.length < PAGE) return { pages, total, nextSeq: page.nextSeq };
        after = page.entries.at(-1)!.seq;
      }
    };
    const recallHttp = async (query: string) => {
      const response = await fetch(`${client.origin}/hub/v1/recall`, {
        method: "POST",
        headers: { ...headers(reader.lane.epoch, reader.groupId), "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      expect(response.status).toBe(200);
      return RecallResponse.parse(await response.json());
    };
    const countedDb = drizzle(counted, { schema });
    const options = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
    const walkBytes = async () => {
      received = 0;
      let after = -1;
      let total = 0;
      for (;;) {
        const page = await countedDb.transaction(
          (tx) => readWorkLane(tx, { botId, groupId: GroupId.parse(groupId) }, "chat", after, PAGE),
          options,
        );
        total += page.entries.length;
        if (page.entries.length < PAGE) return { bytes: received, total };
        after = page.entries.at(-1)!.seq;
      }
    };
    const recallBytes = async (query: string) => {
      received = 0;
      const entries = await countedDb.transaction(
        (tx) => recallWorkRecords(tx, ownerId, { kind: "bot", botId }, GroupId.parse(reader.groupId), query),
        options,
      );
      return { bytes: received, entries };
    };

    const hits = async (query: string) =>
      Number(
        (
          await database.sql<{ n: string }[]>`
              SELECT count(*) AS n FROM work_entries WHERE bot_id = ${botId} AND group_id = ${groupId}
                AND search_text ILIKE ${`%${query}%`}`
        )[0]!.n,
      );
    const result: Record<string, unknown> = {
      entries: ENTRIES,
      pageSize: PAGE,
      lineBytes: Number(stored?.bytes),
      hits: { [COMMON]: await hits(COMMON), [MEDIUM]: await hits(MEDIUM), [RARE]: await hits(RARE) },
    };

    await walkHttp();
    for (const query of [COMMON, MEDIUM, RARE]) await recallHttp(query);

    const walkMs: number[] = [];
    const recallMs: Record<string, number[]> = { [COMMON]: [], [MEDIUM]: [], [RARE]: [] };
    for (let run = 0; run < RUNS; run += 1) {
      const walked = await timed(walkHttp);
      expect(walked.value.total, "Hub 翻完应读到全部条目").toBe(ENTRIES);
      expect(walked.value.nextSeq).toBe(ENTRIES);
      walkMs.push(walked.ms);
      for (const query of [COMMON, MEDIUM, RARE]) {
        const recalled = await timed(() => recallHttp(query));
        expect(recalled.value.length, `recall ${query} 应有结果`).toBeGreaterThan(0);
        recallMs[query]!.push(recalled.ms);
      }
    }
    result["hubWalkMs"] = summary(walkMs);
    result["hubPages"] = (await walkHttp()).pages;
    result["recallMs"] = Object.fromEntries(Object.entries(recallMs).map(([query, ms]) => [query, summary(ms)]));

    // 只读行不复查：区分旧做法的耗时里，库到进程的传输占多少，复查和 JSON 解析占多少。
    const prefixStart = performance.now();
    for (let upTo = PAGE; upTo < ENTRIES + PAGE; upTo += PAGE) {
      await counted`SELECT seq, line FROM work_entries WHERE bot_id = ${botId} AND group_id = ${groupId}
        AND stream = 'chat' AND seq < ${Math.min(upTo, ENTRIES)} ORDER BY seq`;
    }
    result["prefixReadOnlyMs"] = performance.now() - prefixStart;

    const walkedBytes = await walkBytes();
    expect(walkedBytes.total).toBe(ENTRIES);
    result["hubWalkBytes"] = walkedBytes.bytes;
    const recallBytesByQuery: Record<string, number> = {};
    for (const query of [COMMON, MEDIUM, RARE]) {
      const recalled = await recallBytes(query);
      expect(recalled.entries.length).toBeGreaterThan(0);
      recallBytesByQuery[query] = recalled.bytes;
    }
    result["recallBytes"] = recallBytesByQuery;
    result["recallTop"] = (await recallBytes(COMMON)).entries.map((item) => `${item.at} ${item.excerpt.slice(0, 12)}`);

    console.log(`BENCH_RETAIN_READ ${JSON.stringify(result, null, 2)}`);
    const report = process.env["BENCH_RETAIN_READ_REPORT"];
    if (report !== undefined) writeFileSync(report, JSON.stringify(result, null, 2));
  }, 900_000);
});
