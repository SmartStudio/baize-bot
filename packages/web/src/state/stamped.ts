// 推送、快照、操作回包谁先谁后，这里只按客户端这一侧收到的先后排：请求在发出时取号，推送在到达时取号，号只增不减。
// 每个条目记最后一次写它的号，号更小的写入碰不到它；删除也记号，留下的号就是墓碑。
// 已知缺口一：客户端的号只表达本地的先后，不代表服务端状态的新旧。先发出的请求可能被服务端后处理、读到更新的状态，
// 它的回包仍会被后发出的请求挡掉。群名单在这里有兜底：被挡下的群写入换一次 /api/groups 补拉（groups.ts），补拉同样在发出时取号。首次加载的缓冲（Shelf 的 early）让这个缺口从「已加载的桶」扩大到「还没加载的桶」：
// 列表到之前先到的推送不再丢，而是带着更大的号等着，服务端其实更新的那份列表里的同一条会被它挡掉。
// 群消息已经换了号的来源：服务端给每条消息带 revision，消息那一架按条取号（见 groups.ts 的 messageStamp），
// 推送和历史谁先到都不要紧，只认 revision 大的。别的实体还没有 revision，仍是缺口一。
export type Seq = number & { readonly __seq: unique symbol };
export type Stamps = Readonly<Record<string, Seq>>;
// 一份快照里每条的号：整份同一个号，或按条从行上取。按条取号只配 absent 为 kept，删除没有行可取号。
export type Stamp<T> = Seq | ((row: T) => Seq);

export const createClock = (): (() => Seq) => {
  let last = 0;
  return () => ++last as Seq;
};

export const newer = (stamps: Stamps, id: string, seq: Seq): boolean => seq > (stamps[id] ?? 0);

type Row = { readonly id: string };

export type Stamped<T> = { rows: T; stamps: Stamps };

// 按 id 存的表：每条各自比号，比不过的原样留着。
export const writeTable = <K extends string, T extends { readonly id: K }>(
  table: Readonly<Record<K, T>>,
  stamps: Stamps,
  seq: Seq,
  rows: readonly T[],
): Stamped<Record<K, T>> => {
  const next: Record<K, T> = { ...table };
  const nextStamps: Record<string, Seq> = { ...stamps };
  for (const row of rows) {
    if (!newer(nextStamps, row.id, seq)) continue;
    next[row.id] = row;
    nextStamps[row.id] = seq;
  }
  return { rows: next, stamps: nextStamps };
};

export const removeFromTable = <K extends string, T extends { readonly id: K }>(
  table: Readonly<Record<K, T>>,
  stamps: Stamps,
  seq: Seq,
  id: K,
): Stamped<Record<K, T>> => {
  if (!newer(stamps, id, seq)) return { rows: { ...table }, stamps };
  const next: Record<K, T> = { ...table };
  delete next[id];
  return { rows: next, stamps: { ...stamps, [id]: seq } };
};

// 整张表的快照，规则同 loadList 的 absent = deleted；表没有「还没加载」一说，先到的推送直接写进表里等着。
export const loadTable = <K extends string, T extends { readonly id: K }>(
  table: Readonly<Record<K, T>>,
  stamps: Stamps,
  seq: Seq,
  snapshot: readonly T[],
): Stamped<Record<K, T>> => {
  const loaded = loadList(Object.values<T>(table), stamps, seq, snapshot, "deleted");
  const rows = {} as Record<K, T>;
  for (const row of loaded.rows) rows[row.id] = row;
  return { rows, stamps: loaded.stamps };
};

// 有顺序的列表：已有的就地替换，没有的接在后面，列表不会在你看着的时候跳。
export const writeList = <T extends Row>(
  list: readonly T[],
  stamps: Stamps,
  seq: Seq,
  rows: readonly T[],
): Stamped<T[]> => {
  let next = [...list];
  const nextStamps: Record<string, Seq> = { ...stamps };
  for (const row of rows) {
    if (!newer(nextStamps, row.id, seq)) continue;
    next = next.some((item) => item.id === row.id)
      ? next.map((item) => (item.id === row.id ? row : item))
      : [...next, row];
    nextStamps[row.id] = seq;
  }
  return { rows: next, stamps: nextStamps };
};

export const removeFromList = <T extends Row>(
  list: readonly T[],
  stamps: Stamps,
  seq: Seq,
  id: string,
): Stamped<T[]> =>
  newer(stamps, id, seq)
    ? { rows: list.filter((item) => item.id !== id), stamps: { ...stamps, [id]: seq } }
    : { rows: [...list], stamps };

// 一份完整列表回来：顺序照它，号比它新的条目留本地那份（本地删了的就不出现）。
// 列表里没有的本地条目，absent 为 deleted 且号比它旧时算被删；号比它新的是请求发出之后才写下的，照留。
export const loadList = <T extends Row>(
  list: readonly T[] | undefined,
  stamps: Stamps,
  stamp: Stamp<T>,
  snapshot: readonly T[],
  absent: "deleted" | "kept",
): Stamped<T[]> => {
  const local = new Map((list ?? []).map((item) => [item.id, item]));
  const nextStamps: Record<string, Seq> = { ...stamps };
  const seqOf = (row: T): Seq => (typeof stamp === "function" ? stamp(row) : stamp);
  const rows: T[] = [];
  for (const row of snapshot) {
    const seq = seqOf(row);
    if (newer(stamps, row.id, seq)) {
      rows.push(row);
      nextStamps[row.id] = seq;
    } else {
      const kept = local.get(row.id);
      if (kept !== undefined) rows.push(kept);
    }
    local.delete(row.id);
  }
  // 本地独有的行保留它们在旧列表里的先后：排在第一条「快照也有的行」之前的，仍放在快照前面，其余接在后面。
  // 消息历史只回最近一窗，窗口外但本地还留着的行不能因为接到末尾，就和窗口内同毫秒的行换了位。
  // deleted 模式同样适用：号比快照新的本地独有行也按这条规则放，例行、skill、账号、电脑的展示次序因此可能和先前「快照后接本地」不同。
  const anchor = (list ?? []).findIndex((item) => !local.has(item.id));
  const leading: T[] = [];
  const trailing: T[] = [];
  for (const [at, item] of (list ?? []).entries()) {
    if (!local.has(item.id)) continue;
    if (absent === "deleted" && newer(stamps, item.id, seqOf(item))) {
      nextStamps[item.id] = seqOf(item);
      continue;
    }
    (anchor >= 0 && at < anchor ? leading : trailing).push(item);
  }
  return { rows: [...leading, ...rows, ...trailing], stamps: nextStamps };
};

// 按键分桶的列表，rows 里有这个键才算这一桶的完整列表拉回来过。列表还没到时先到的写入放在 early，号照记，
// 删除只留号当墓碑；完整列表到的那一刻，early 当作本地那份和快照一起走 loadList。
export type Shelf<K extends string, T extends Row> = {
  rows: Record<K, T[]>;
  early: Record<K, T[]>;
  stamps: Stamps;
};

export const emptyShelf = <K extends string, T extends Row>(): Shelf<K, T> => ({
  rows: {} as Record<K, T[]>,
  early: {} as Record<K, T[]>,
  stamps: {},
});

const settle = <K extends string, T extends Row>(shelf: Shelf<K, T>, key: K, next: Stamped<T[]>): Shelf<K, T> =>
  shelf.rows[key] === undefined
    ? { ...shelf, early: { ...shelf.early, [key]: next.rows }, stamps: next.stamps }
    : { ...shelf, rows: { ...shelf.rows, [key]: next.rows }, stamps: next.stamps };

export const shelfWrite = <K extends string, T extends Row>(
  shelf: Shelf<K, T>,
  key: K,
  seq: Seq,
  row: T,
): Shelf<K, T> => settle(shelf, key, writeList(shelf.rows[key] ?? shelf.early[key] ?? [], shelf.stamps, seq, [row]));

export const shelfRemove = <K extends string, T extends Row>(
  shelf: Shelf<K, T>,
  key: K,
  seq: Seq,
  id: string,
): Shelf<K, T> => settle(shelf, key, removeFromList(shelf.rows[key] ?? shelf.early[key] ?? [], shelf.stamps, seq, id));

export const shelfLoad = <K extends string, T extends Row>(
  shelf: Shelf<K, T>,
  key: K,
  stamp: Stamp<T>,
  snapshot: readonly T[],
  absent: "deleted" | "kept",
): Shelf<K, T> => {
  const next = loadList(shelf.rows[key] ?? shelf.early[key], shelf.stamps, stamp, snapshot, absent);
  const early = { ...shelf.early };
  delete early[key];
  return { rows: { ...shelf.rows, [key]: next.rows }, early, stamps: next.stamps };
};

export const shelfRow = <K extends string, T extends Row>(shelf: Shelf<K, T>, key: K, id: string): T | undefined =>
  (shelf.rows[key] ?? shelf.early[key])?.find((row) => row.id === id);
