// 推送、快照、操作回包谁先谁后，这里只按客户端这一侧收到的先后排：请求在发出时取号，推送在到达时取号，号只增不减。
// 每个条目记最后一次写它的号，号更小的写入碰不到它；删除也记号，留下的号就是墓碑。
// 已知缺口一：客户端的号只表达本地的先后，不代表服务端状态的新旧。先发出的请求可能被服务端后处理、读到更新的状态，
// 它的回包仍会被后发出的请求挡掉。首次加载的缓冲（Shelf 的 early）让这个缺口从「已加载的桶」扩大到「还没加载的桶」：
// 列表到之前先到的推送不再丢，而是带着更大的号等着，服务端其实更新的那份列表里的同一条会被它挡掉。
// 已知缺口二：重连后补拉的群历史还在途时，先到的流式 delta 取的号比它大，会挡住历史里那条消息的完整正文。
// 这两个都要等服务端给实体和消息带单调 revision，届时只换号的来源，调用方不动。
export type Seq = number & { readonly __seq: unique symbol };
export type Stamps = Readonly<Record<string, Seq>>;

export const createClock = (): (() => Seq) => {
  let last = 0;
  return () => ++last as Seq;
};

const newer = (stamps: Stamps, id: string, seq: Seq): boolean => seq > (stamps[id] ?? 0);

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
  seq: Seq,
  snapshot: readonly T[],
  absent: "deleted" | "kept",
): Stamped<T[]> => {
  const local = new Map((list ?? []).map((item) => [item.id, item]));
  const nextStamps: Record<string, Seq> = { ...stamps };
  const rows: T[] = [];
  for (const row of snapshot) {
    if (newer(stamps, row.id, seq)) {
      rows.push(row);
      nextStamps[row.id] = seq;
    } else {
      const kept = local.get(row.id);
      if (kept !== undefined) rows.push(kept);
    }
    local.delete(row.id);
  }
  for (const item of local.values()) {
    if (absent === "kept" || !newer(stamps, item.id, seq)) rows.push(item);
    else nextStamps[item.id] = seq;
  }
  return { rows, stamps: nextStamps };
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
  seq: Seq,
  snapshot: readonly T[],
  absent: "deleted" | "kept",
): Shelf<K, T> => {
  const next = loadList(shelf.rows[key] ?? shelf.early[key], shelf.stamps, seq, snapshot, absent);
  const early = { ...shelf.early };
  delete early[key];
  return { rows: { ...shelf.rows, [key]: next.rows }, early, stamps: next.stamps };
};

export const shelfRow = <K extends string, T extends Row>(shelf: Shelf<K, T>, key: K, id: string): T | undefined =>
  (shelf.rows[key] ?? shelf.early[key])?.find((row) => row.id === id);
