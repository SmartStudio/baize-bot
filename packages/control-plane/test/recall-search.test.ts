import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db.js";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/recall-corpus.json", import.meta.url), "utf8")) as {
  source: string;
  derived?: boolean;
  text: string;
}[];
const queries = ["白泽", "飞书", "底牌", "小红书", "标题", "周报", "草稿", "推广", "封面", "品牌手册"];
let database: TestDb;

beforeAll(async () => {
  database = await createTestDb();
  await database.sql`INSERT INTO users (id, name, email, password_hash) VALUES ('recall-bench-owner', '实测', 'recall-bench@baize.dev', 'fixture')`;
  await database.sql`INSERT INTO bots (id, owner_id, name, hue) VALUES ('recall-bench-bot', 'recall-bench-owner', '实测', 'sky')`;
  await database.sql`INSERT INTO groups (id, owner_id) VALUES ('recall-bench-group', 'recall-bench-owner')`;
  await database.sql`INSERT INTO work_entries ${database.sql(
    corpus.map(({ text }, seq) => ({
      bot_id: "recall-bench-bot",
      group_id: "recall-bench-group",
      stream: "chat",
      seq,
      epoch: 1,
      owner_id: "recall-bench-owner",
      run_id: null,
      entry_id: `bench-${seq}`,
      parent_id: null,
      pi_type: "message",
      retention: "verbatim",
      line: JSON.stringify({
        type: "message",
        id: `bench-${seq}`,
        parentId: null,
        timestamp: "2026-10-14T00:00:00.000Z",
        message: { role: "user", content: text },
      }),
      search_text: text,
      visible_to: null,
    })),
  )}`;
});

afterAll(async () => {
  await database?.close();
});

describe("中文短词的 trigram 实测", () => {
  it("比较子串召回、similarity阈值、排序，并证明两种运算使用部分GIN索引", async () => {
    expect(corpus.length).toBeGreaterThanOrEqual(50);
    const measurements = [];
    for (const query of queries) {
      const expected = corpus.filter(({ text }) => text.includes(query)).length;
      const substring = await database.sql<{ seq: number; score: number; search_text: string }[]>`
        SELECT seq, similarity(search_text, ${query}) AS score, search_text FROM work_entries
        WHERE stream = 'chat' AND visible_to IS NULL AND search_text ILIKE ${`%${query}%`}
        ORDER BY score DESC, seq DESC`;
      const similar = await database.sql<{ seq: number; score: number; search_text: string }[]>`
        SELECT seq, similarity(search_text, ${query}) AS score, search_text FROM work_entries
        WHERE stream = 'chat' AND visible_to IS NULL AND search_text % ${query}
        ORDER BY score DESC, seq DESC`;
      const relevant = similar.filter(({ search_text }) => search_text.includes(query)).length;
      expect(substring).toHaveLength(expected);
      measurements.push({
        query,
        expected,
        substringHits: substring.length,
        similarityHits: similar.length,
        similarityRelevant: relevant,
        substringTop: substring.slice(0, 3),
        similarityTop: similar.slice(0, 3),
      });
    }
    const indexes = await database.sql<
      { indexdef: string }[]
    >`SELECT indexdef FROM pg_indexes WHERE tablename = 'work_entries' AND indexname = 'work_entries_chat_search_idx'`;
    expect(indexes[0]?.indexdef).toContain("USING gin (search_text gin_trgm_ops)");
    expect(indexes[0]?.indexdef).toContain("visible_to IS NULL");
    await database.sql`
      INSERT INTO work_entries (bot_id, group_id, stream, seq, epoch, owner_id, entry_id, pi_type, retention, line, search_text)
      SELECT 'recall-bench-bot', 'recall-bench-group', 'chat', n + ${corpus.length}, 1,
        'recall-bench-owner', 'noise-' || n, 'message', 'verbatim', '{}',
        '办公室日常会议讨论设备清单及库存盘点编号' || n
      FROM generate_series(0, 4999) AS n`;
    await database.sql`ANALYZE work_entries`;
    const beforeMaintenance =
      await database.sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT seq FROM work_entries WHERE stream = 'chat' AND visible_to IS NULL AND search_text ILIKE '%小红书%'`;
    const maintenance =
      await database.sql`SELECT gin_clean_pending_list('work_entries_chat_search_idx'::regclass) AS pages`;
    const naturalPlan =
      await database.sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT seq FROM work_entries WHERE stream = 'chat' AND visible_to IS NULL AND search_text ILIKE '%小红书%'`;
    expect(JSON.stringify(naturalPlan)).toContain("work_entries_chat_search_idx");
    const plans = await database.sql.begin(async (tx) => {
      // 默认计划可能选择顺序扫描；关闭顺序和普通索引扫描，只验证 GIN 的运算符支持，不据此推断更快。
      await tx`SET LOCAL enable_seqscan = off`;
      await tx`SET LOCAL enable_indexscan = off`;
      return {
        substring:
          await tx`EXPLAIN (ANALYZE, FORMAT JSON) SELECT seq FROM work_entries WHERE stream = 'chat' AND visible_to IS NULL AND search_text ILIKE '%小红书%'`,
        similarity:
          await tx`EXPLAIN (ANALYZE, FORMAT JSON) SELECT seq FROM work_entries WHERE stream = 'chat' AND visible_to IS NULL AND search_text % '小红书'`,
        twoCharacters:
          await tx`EXPLAIN (ANALYZE, FORMAT JSON) SELECT seq FROM work_entries WHERE stream = 'chat' AND visible_to IS NULL AND search_text ILIKE '%标题%'`,
      };
    });
    for (const plan of [plans.substring, plans.similarity])
      expect(JSON.stringify(plan)).toContain("work_entries_chat_search_idx");
    expect(measurements.reduce((total, row) => total + row.similarityRelevant, 0)).toBeLessThan(
      measurements.reduce((total, row) => total + row.substringHits, 0),
    );
    const evidence = {
      corpusSize: corpus.length,
      exact: corpus.filter((row) => !row.derived).length,
      derived: corpus.filter((row) => row.derived).length,
      similarityThreshold: 0.3,
      measurements,
      noiseRows: 5000,
      beforeMaintenance,
      maintenance,
      naturalPlan,
      plans,
    };
    if (process.env["RECALL_BENCH_REPORT"] !== undefined)
      writeFileSync(process.env["RECALL_BENCH_REPORT"], JSON.stringify(evidence, null, 2));
  });
});
