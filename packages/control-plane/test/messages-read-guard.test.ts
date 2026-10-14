import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanMessagesTable, scanWorkEntriesTable, type MessagesSite } from "./helpers/messages-reads.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const HOME = new Set(["db/schema.ts"]);

type Exception = {
  readonly file: string;
  readonly fn: string;
  /** 这个函数里允许有几处，多一处少一处都红：新增的读要重新过一遍理由，删掉的读要把条目一起删。 */
  readonly sites: number;
  readonly reason: string;
};

/**
 * 不在查询里拼 `messageVisibleTo(viewer)` 又不走 repo/messages.ts 的读，只能在这里登记并写明为什么不会漏。
 * 能带 viewer 的读已经带了，这里剩下的是读控制面自己写下的隐藏行，或者按 id 探一下存在。
 */
const EXCEPTIONS: readonly Exception[] = [
  {
    file: "repo/work-records.ts",
    fn: "recheckCommitted",
    sites: 1,
    reason: "归属人排它锁下的名单修改或已授权追加事务内部重放，旧行只供留存复查和截断，不向调用方返回正文",
  },
  {
    file: "repo/work-records.ts",
    fn: "readWorkLane",
    sites: 1,
    reason: "持有者拉快照，HTTP同快照租约授权，重建需原样条目",
  },
  {
    file: "poker/hint.ts",
    fn: "refreshHintForRun",
    sites: 1,
    reason: "按 id 取问老白的回答，随后在函数里手写校验 visibleTo 恰好只有用户，比 viewer 过滤更严",
  },
  {
    file: "repo/preferences.ts",
    fn: "addPreference",
    sites: 1,
    reason: "只探来源消息在不在这个群里并取回 id，正文不出这个函数，来源 id 来自电脑上报",
  },
  {
    file: "repo/project-page.ts",
    fn: "readProject",
    sites: 1,
    reason: "子查询只取外层已按 viewer 读到的那条用户发言的游标，外层查询带着 messageVisibleTo",
  },
  {
    file: "repo/team-offers.ts",
    fn: "currentOffer",
    sites: 1,
    reason: "确认或先放着没抢到之后回读同一张卡，这张卡刚由带 viewer 的 findOwnedTeamOffer 放行过",
  },
];

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts") && !HOME.has(file))
    .toSorted();
}

const label = (file: string, site: MessagesSite) => `src/${file}:${site.line} ${site.fn} (${site.kind})`;
const allowsException = (file: string, fn: string, table: "messages" | "workEntries") =>
  (table === "messages" || file === "repo/work-records.ts") &&
  EXCEPTIONS.some((entry) => entry.file === file && entry.fn === fn);
const scanWorkReadsProbe = (body: string, header = `import { workEntries } from "../db/schema.js";\n`) =>
  scanWorkEntriesTable("repo/probe.ts", header + body).filter((site) => !site.ok);
const scanWorkRecordReads = (body: string) =>
  scanWorkEntriesTable("repo/work-records.ts", `import { workEntries } from "../db/schema.js";\n${body}`).filter(
    (site) => !site.ok,
  );

describe("消息与工作记录的读取出口", () => {
  it("messages 必须带 viewer 或登记理由，work_entries 只走带 viewer 的仓库读或登记的授权快照和留存复查", () => {
    const unexplained: string[] = [];
    const seen = new Map<string, number>();
    for (const file of sourceFiles()) {
      const source = readFileSync(SRC + file, "utf8");
      const tables: readonly ["messages" | "workEntries", MessagesSite[]][] = [
        ["messages", file === "repo/messages.ts" ? [] : scanMessagesTable(file, source)],
        ["workEntries", scanWorkEntriesTable(file, source)],
      ];
      for (const [table, sites] of tables)
        for (const site of sites) {
          if (site.ok) continue;
          const key = `${file}#${site.fn}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          if (!allowsException(file, site.fn, table)) unexplained.push(label(file, site));
        }
    }
    expect(
      unexplained,
      "这些地方绕过读取出口：messages 要带 viewer 或登记理由，work_entries 只能由 repo/work-records.ts 中带 viewer 的读或登记的授权读取函数读",
    ).toEqual([]);

    const counts = EXCEPTIONS.map((entry) => ({
      key: `${entry.file}#${entry.fn}`,
      sites: seen.get(`${entry.file}#${entry.fn}`) ?? 0,
    }));
    expect(counts, "白名单条目和源码对不上：读被删了就删条目，函数里多了一处读就按新的读重写理由并改 sites").toEqual(
      EXCEPTIONS.map((entry) => ({ key: `${entry.file}#${entry.fn}`, sites: entry.sites })),
    );
  });

  it("每条白名单都写了理由", () => {
    expect(EXCEPTIONS.filter((entry) => entry.reason.trim() === "")).toEqual([]);
  });
});

describe("工作记录守卫自己能分辨的写法", () => {
  it("workEntries不能借messages白名单，repo/messages.ts也照常扫描工作记录", () => {
    expect(allowsException("poker/hint.ts", "refreshHintForRun", "messages")).toBe(true);
    expect(allowsException("poker/hint.ts", "refreshHintForRun", "workEntries")).toBe(false);
    expect(allowsException("repo/work-records.ts", "readWorkLane", "workEntries")).toBe(true);
    expect(allowsException("repo/work-records.ts", "recheckCommitted", "workEntries")).toBe(true);
    expect(HOME.has("repo/messages.ts")).toBe(false);
  });
  it("读 workEntries 即使带 viewer 也不能绕过唯一出口", () => {
    expect(
      scanWorkReadsProbe(
        `export const f = (db: Db, v: Viewer) => db.select().from(workEntries).where(messageVisibleTo(v));`,
      ),
    ).toHaveLength(1);
    expect(
      scanWorkReadsProbe(
        `export const f = (db: Db, v: Viewer) => db.select().from(workEntries).where(workEntryVisibleTo(v));`,
      ),
    ).toHaveLength(1);
    expect(
      scanWorkReadsProbe(
        `export const f = (db: Db) => db.select().from(runs).leftJoin(workEntries, eq(workEntries.runId, runs.id));`,
      ),
    ).toHaveLength(1);
  });

  it("work-records 内每条查询必须在同链调用 workEntryVisibleTo，消息谓词不能替代", () => {
    expect(
      scanWorkRecordReads(
        `export const f = (db: Db, v: Viewer) => db.select().from(workEntries).where(workEntryVisibleTo(v));`,
      ),
    ).toEqual([]);
    expect(
      scanWorkRecordReads(
        `export const f = (db: Db, v: Viewer) => db.select().from(workEntries).where(messageVisibleTo(v));`,
      ),
    ).toHaveLength(1);
    expect(scanWorkRecordReads(`export const f = (db: Db) => db.select().from(workEntries);`)).toHaveLength(1);
    expect(
      scanWorkRecordReads(`export function f(db: Db, v: Viewer) {
        const allowed = db.select().from(workEntries).where(workEntryVisibleTo(v));
        const denied = db.select().from(workEntries);
        return [allowed, denied];
      }`),
    ).toHaveLength(1);
    expect(
      scanWorkRecordReads(`export const f = (db: Db, v: Viewer) => db.select().from(runs)
        .where(and(workEntryVisibleTo(v), exists(db.select().from(workEntries))));`),
    ).toHaveLength(1);
  });

  it("改名、命名空间和 query API 都拦下", () => {
    expect(
      scanWorkReadsProbe(
        `export const f = (db: Db) => db.select().from(stored);`,
        `import { workEntries as stored } from "../db/schema.js";\n`,
      ),
    ).toHaveLength(1);
    expect(
      scanWorkReadsProbe(
        `export const f = (db: Db) => db.select().from(schema.workEntries);`,
        `import * as schema from "../db/schema.js";\n`,
      ),
    ).toHaveLength(1);
    expect(
      scanWorkReadsProbe(`export const f = (db: Db) => db.query.workEntries.findMany();`).map((site) => site.kind),
    ).toEqual(["query_api"]);
  });

  it("原始SQL与未知表转交都拦下", () => {
    expect(
      scanWorkReadsProbe("export const f = (db: Db) => db.execute(sql`select line from work_entries`);").map(
        (site) => site.kind,
      ),
    ).toEqual(["raw_sql"]);
    expect(
      scanWorkReadsProbe(`export const f = () => sql.raw('select line from public."work_entries"');`).map(
        (site) => site.kind,
      ),
    ).toEqual(["raw_sql"]);
    expect(
      scanWorkReadsProbe(`const alias = workEntries; export const f = (db: Db) => db.select().from(alias);`).map(
        (site) => site.kind,
      ),
    ).toEqual(["unclassified"]);
    expect(scanWorkReadsProbe(`export const f = () => helper(workEntries);`).map((site) => site.kind)).toEqual([
      "unclassified",
    ]);
  });

  it("写入、列和类型引用不算读", () => {
    expect(scanWorkReadsProbe(`export const f = (db: Db) => db.insert(workEntries).values({ seq: 0 });`)).toEqual([]);
    expect(scanWorkReadsProbe(`export const f = (db: Db) => db.update(workEntries).set({ line: 'x' });`)).toEqual([]);
    expect(
      scanWorkReadsProbe(`export const f = (db: Db) => db.delete(workEntries).where(eq(workEntries.seq, 0));`),
    ).toEqual([]);
    expect(scanWorkReadsProbe(`export type Row = typeof workEntries.$inferSelect;`)).toEqual([]);
  });
});

const PROBE_IMPORTS = `import { messages } from "../db/schema.js";\nimport { messageVisibleTo } from "./messages.js";\n`;
const failing = (body: string, header = PROBE_IMPORTS) =>
  scanMessagesTable("repo/probe.ts", `${header}${body}`).filter((site) => !site.ok);

describe("守卫自己能分辨的写法", () => {
  it("列表读不带 viewer 被拦下", () => {
    const sites = failing(
      `export const list = (db: Db) => db.select().from(messages).where(eq(messages.groupId, "g"));`,
    );
    expect(sites.map((site) => [site.kind, site.fn])).toEqual([["read", "list"]]);
  });

  it("join 进来的 messages 同样要带 viewer", () => {
    expect(
      failing(`export const f = (db: Db) => db.select().from(runs).leftJoin(messages, eq(messages.id, runs.x));`),
    ).toHaveLength(1);
    expect(
      failing(`export const f = (db: Db) => db.select().from(runs).innerJoin(messages, eq(messages.id, runs.x));`),
    ).toHaveLength(1);
  });

  it("同一条查询链里调了 messageVisibleTo 就放行，查询写在 where 还是 join 的 on 里都行", () => {
    expect(
      failing(
        `export const f = (db: Db, v: Viewer) => db.select().from(messages).where(and(eq(messages.id, "m"), messageVisibleTo(v)));`,
      ),
    ).toEqual([]);
    expect(
      failing(
        `export const f = (db: Db, v: Viewer) => db.select().from(runs).leftJoin(messages, and(eq(messages.id, runs.x), messageVisibleTo(v)));`,
      ),
    ).toEqual([]);
  });

  it("别的查询链里的 messageVisibleTo 不替这条担保", () => {
    const sites = failing(
      `export async function f(db: Db, v: Viewer) {
         const ok = db.select().from(messages).where(messageVisibleTo(v));
         const bad = db.select().from(messages).where(eq(messages.id, "m"));
         return [ok, bad];
       }`,
    );
    expect(sites).toHaveLength(1);
  });

  it("嵌进外层查询的子查询要自己带 viewer", () => {
    const sites = failing(
      `export const f = (db: Db, v: Viewer) =>
         db.select().from(runs).where(and(messageVisibleTo(v), exists(db.select().from(messages))));`,
    );
    expect(sites.map((site) => site.kind)).toEqual(["read"]);
  });

  it("改名导入、命名空间导入都认得出来", () => {
    const renamed = `import { messages as stored } from "../db/schema.js";\n`;
    expect(failing(`export const f = (db: Db) => db.select().from(stored);`, renamed)).toHaveLength(1);
    const namespaced = `import * as schema from "../db/schema.js";\n`;
    expect(failing(`export const f = (db: Db) => db.select().from(schema.messages);`, namespaced)).toHaveLength(1);
    expect(
      failing(`export const f = (db: Db) => db.query.messages.findMany();`, namespaced).map((site) => site.kind),
    ).toEqual(["query_api"]);
  });

  it("把表赋给别的变量或传给别的函数，归为认不出来，不放行", () => {
    expect(
      failing(`const alias = messages;\nexport const f = (db: Db) => db.select().from(alias);`).map(
        (site) => site.kind,
      ),
    ).toEqual(["unclassified"]);
    expect(failing(`export const f = () => getTableColumns(messages);`).map((site) => site.kind)).toEqual([
      "unclassified",
    ]);
  });

  it("手写 SQL 里的 from messages 不放行", () => {
    expect(
      failing("export const f = (db: Db) => db.execute(sql`select body from messages where id = ${1}`);").map(
        (site) => site.kind,
      ),
    ).toEqual(["raw_sql"]);
    expect(
      failing(`export const f = () => sql.raw("select 1 from public.messages");`).map((site) => site.kind),
    ).toEqual(["raw_sql"]);
  });

  it("写入、列引用、类型引用、不是这张表的同名变量都不算读", () => {
    expect(failing(`export const f = (db: Db) => db.insert(messages).values({ id: "m" });`)).toEqual([]);
    expect(
      failing(`export const f = (db: Db) => db.update(messages).set({ revision: sql\`\${messages.revision} + 1\` });`),
    ).toEqual([]);
    expect(failing(`export const f = (db: Db) => db.delete(messages);`)).toEqual([]);
    expect(failing(`export type Row = typeof messages.$inferSelect;`)).toEqual([]);
    expect(
      failing(
        `export const f = (db: Db, v: Viewer) => db.select({ row: messages }).from(messages).where(messageVisibleTo(v));`,
      ),
    ).toEqual([]);
    expect(failing(`export const f = (page: { messages: string[] }) => page.messages.length;`)).toEqual([]);
    expect(
      failing(`export const f = (messages: string[]) => messages.length;`, `import { runs } from "../db/schema.js";\n`),
    ).toEqual([]);
  });
});
