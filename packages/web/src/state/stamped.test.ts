import { describe, expect, it } from "vitest";
import { createClock, loadTable, removeFromTable, writeTable } from "./stamped.js";

describe("号的边界", () => {
  it("号只增不减，每次取的号都比上一次大", () => {
    const next = createClock();
    const taken = [next(), next(), next()];
    expect(taken).toEqual([1, 2, 3]);
  });

  it("号和条目上记的号相同，说明是同一次写入，不能再盖一遍", () => {
    const next = createClock();
    const seq = next();
    const empty: Record<string, { id: string; text: string }> = {};
    const once = writeTable(empty, {}, seq, [{ id: "draft_1", text: "第一次" }]);
    const again = writeTable(once.rows, once.stamps, seq, [{ id: "draft_1", text: "同号的第二份" }]);
    expect(again.rows["draft_1"]?.text).toBe("第一次");
  });
});

describe("按 id 存的表删除和快照", () => {
  type Row = { id: string; text: string };
  const empty: Record<string, Row> = {};

  it("删除留下墓碑，号更旧的写入不再把它写回来", () => {
    const next = createClock();
    const stale = next();
    const loaded = writeTable(empty, {}, next(), [{ id: "acc_1", text: "在" }]);
    const removed = removeFromTable<string, Row>(loaded.rows, loaded.stamps, next(), "acc_1");
    expect(removed.rows["acc_1"]).toBeUndefined();
    const late = writeTable(removed.rows, removed.stamps, stale, [{ id: "acc_1", text: "旧的回包" }]);
    expect(late.rows["acc_1"]).toBeUndefined();
  });

  it("号更旧的删除碰不到后写下的条目", () => {
    const next = createClock();
    const stale = next();
    const written = writeTable(empty, {}, next(), [{ id: "acc_1", text: "新写的" }]);
    expect(removeFromTable<string, Row>(written.rows, written.stamps, stale, "acc_1").rows["acc_1"]?.text).toBe(
      "新写的",
    );
  });

  it("快照盖掉号比它旧的，号比它新的留本地那份，快照里没有的旧条目算删了", () => {
    const next = createClock();
    const old = writeTable(empty, {}, next(), [
      { id: "acc_gone", text: "服务端已删" },
      { id: "acc_1", text: "旧" },
    ]);
    const snapshot = next();
    const fresh = writeTable(old.rows, old.stamps, next(), [{ id: "acc_2", text: "推来的新号" }]);
    const loaded = loadTable(fresh.rows, fresh.stamps, snapshot, [{ id: "acc_1", text: "快照里的" }]);
    expect(loaded.rows).toEqual({
      acc_1: { id: "acc_1", text: "快照里的" },
      acc_2: { id: "acc_2", text: "推来的新号" },
    });
  });
});
