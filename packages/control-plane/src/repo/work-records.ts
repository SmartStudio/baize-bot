import {
  EMPTY_WORK_HEAD,
  GroupId,
  PiWorkEntry,
  RECALL_EXCERPT_LENGTH,
  RECALL_LIMIT,
  advanceWorkHead,
  extractWorkSearchText,
  type BotId,
  type HubLaneSnapshot,
  type RecallEntry,
  type UserId,
  type Viewer,
  type WorkAppend,
  type WorkAppendResult,
  type WorkStream,
} from "@baize/shared";
import {
  RetainSnapshot,
  checkFrame,
  createRetainer,
  emptySnapshot,
  type RetainContext,
} from "@baize/shared/work-record";
import { and, asc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import type { AgentConnection } from "../agent/hub.js";
import {
  bots,
  groupMembers,
  groups,
  laneLeases,
  pokerTables,
  runs,
  tasks,
  toolConnections,
  workEntries,
  workStreams,
} from "../db/schema.js";
import type { Tx } from "./messages.js";

async function currentRetainContext(tx: Tx, ownerId: string): Promise<RetainContext> {
  const localTools = await tx
    .select({ operations: toolConnections.operations })
    .from(toolConnections)
    .where(and(eq(toolConnections.ownerId, ownerId), eq(toolConnections.localOnly, true)));
  return { localOnlyToolNames: new Set(localTools.flatMap((tool) => tool.operations.map((op) => op.name))) };
}

/** 调用方已持有归属人排它锁；名单变更和历史撤回必须一起提交。 */
export async function recheckOwnerWorkRecords(tx: Tx, ownerId: UserId): Promise<void> {
  const ctx = await currentRetainContext(tx, ownerId);
  const streams = await tx
    .select({ metadata: workStreams })
    .from(workStreams)
    .innerJoin(bots, eq(bots.id, workStreams.botId))
    .where(eq(bots.ownerId, ownerId))
    .orderBy(asc(workStreams.botId), asc(workStreams.groupId), asc(workStreams.stream))
    .for("update", { of: workStreams });
  for (const { metadata } of streams) await recheckCommitted(tx, metadata, ctx);
}

export async function appendWorkRecords(
  tx: Tx,
  conn: Pick<AgentConnection, "computerId" | "ownerId" | "installId" | "piSessionVersion">,
  frame: WorkAppend,
): Promise<WorkAppendResult> {
  const { botId, groupId, stream, epoch } = frame.lane;
  const [owned] = await tx
    .select({ botId: bots.id })
    .from(bots)
    .innerJoin(groupMembers, and(eq(groupMembers.botId, bots.id), eq(groupMembers.groupId, groupId)))
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(bots.id, botId), eq(bots.ownerId, conn.ownerId), eq(groups.ownerId, conn.ownerId)));
  if (owned === undefined) return { kind: "not_holder" };

  const [lease] = await tx
    .select()
    .from(laneLeases)
    .where(and(eq(laneLeases.botId, botId), eq(laneLeases.groupId, groupId)))
    .for("update");
  const sameHolder = lease?.holderComputerId === conn.computerId && lease.holderInstallId === conn.installId;
  const firstImport = frame.cause === "import" && frame.fromSeq === 0 && frame.lines.length > 0;
  if (lease !== undefined) {
    if (lease.epoch !== epoch) return { kind: "stale_epoch" };
    if (!sameHolder) return { kind: "not_holder" };
  } else if (!firstImport && !sameHolder) {
    return { kind: "not_holder" };
  }
  if (frame.lines.length === 0) return { kind: "ok" };

  let visibleTo: Viewer[] | null;
  if (frame.cause === "import") {
    if (frame.runId !== null || (firstImport && lease === undefined && epoch !== 1)) return { kind: "invalid" };
    const [table] = await tx
      .select({ groupId: pokerTables.groupId })
      .from(pokerTables)
      .where(eq(pokerTables.groupId, groupId));
    visibleTo = table === undefined ? null : [{ kind: "bot", botId }];
  } else {
    if (frame.runId === null) return { kind: "invalid" };
    const [run] = await tx
      .select({ visibleTo: runs.visibleTo })
      .from(runs)
      .where(
        and(
          eq(runs.id, frame.runId),
          eq(runs.computerId, conn.computerId),
          eq(runs.ownerId, conn.ownerId),
          eq(runs.botId, botId),
          eq(runs.groupId, groupId),
        ),
      );
    if (run === undefined) return { kind: "invalid" };
    visibleTo = run.visibleTo;
  }

  const [metadata] = await tx
    .select()
    .from(workStreams)
    .where(and(eq(workStreams.botId, botId), eq(workStreams.groupId, groupId), eq(workStreams.stream, stream)))
    .for("update");
  const ctx = await currentRetainContext(tx, conn.ownerId);
  let committed =
    metadata === undefined || metadata.retainSnapshot === null
      ? emptySnapshot(ctx)
      : RetainSnapshot.parse(metadata.retainSnapshot);
  if (metadata !== undefined && (metadata.retainSnapshot === null || !checkFrame(ctx, committed, []).ok)) {
    const replay = await recheckCommitted(tx, metadata, ctx);
    if (replay.kind === "invalid") return replay;
    committed = replay.snapshot;
  }
  const nextSeq = metadata?.nextSeq ?? 0;
  if (firstImport && nextSeq > 0) return { kind: "invalid" };
  if (frame.fromSeq !== nextSeq) return { kind: "seq_mismatch", nextSeq };

  const entries: { line: string; entry: PiWorkEntry }[] = [];
  for (const line of frame.lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return { kind: "invalid" };
    }
    const parsed = PiWorkEntry.safeParse(value);
    if (!parsed.success) return { kind: "invalid" };
    entries.push({ line, entry: parsed.data });
  }
  const checked = checkFrame(ctx, committed, frame.lines);
  if (!checked.ok) {
    return checked.reason === "tool_list_changed"
      ? { kind: "invalid", reason: checked.reason }
      : { kind: "invalid", reason: checked.reason, lineIndex: checked.lineIndex };
  }
  const head = await advanceWorkHead(metadata?.head ?? EMPTY_WORK_HEAD, frame.lines);
  if (head !== frame.head) return { kind: "head_mismatch" };

  if (firstImport && lease === undefined) {
    const [claimed] = await tx
      .insert(laneLeases)
      .values({ botId, groupId, holderComputerId: conn.computerId, holderInstallId: conn.installId, epoch: 1 })
      .onConflictDoNothing()
      .returning({ epoch: laneLeases.epoch });
    if (claimed === undefined) return { kind: "not_holder" };
  }

  await tx
    .insert(workStreams)
    .values({ botId, groupId, stream, piSessionVersion: conn.piSessionVersion })
    .onConflictDoNothing();
  const [updated] = await tx
    .update(workStreams)
    .set({
      nextSeq: frame.fromSeq + entries.length,
      head,
      tailEntryId: entries.at(-1)!.entry.id,
      retainSnapshot: checked.snapshot,
      piSessionVersion: conn.piSessionVersion,
    })
    .where(
      and(
        eq(workStreams.botId, botId),
        eq(workStreams.groupId, groupId),
        eq(workStreams.stream, stream),
        eq(workStreams.nextSeq, frame.fromSeq),
        sql`EXISTS (SELECT 1 FROM ${laneLeases} WHERE ${laneLeases.botId} = ${botId}
          AND ${laneLeases.groupId} = ${groupId} AND ${laneLeases.holderComputerId} = ${conn.computerId}
          AND ${laneLeases.holderInstallId} = ${conn.installId} AND ${laneLeases.epoch} = ${epoch})`,
      ),
    )
    .returning({ nextSeq: workStreams.nextSeq });
  if (updated === undefined) return { kind: "seq_mismatch", nextSeq };
  await tx.insert(workEntries).values(
    entries.map(({ line, entry }, index) => ({
      botId,
      groupId,
      stream,
      seq: frame.fromSeq + index,
      epoch,
      ownerId: conn.ownerId,
      runId: frame.runId,
      entryId: entry.id,
      parentId: entry.parentId,
      piType: entry.type,
      retention: "verbatim" as const,
      line,
      searchText: extractWorkSearchText(entry),
      visibleTo,
    })),
  );
  return { kind: "ok" };
}

// 旧名单放行的内容必须撤回；只拒收新帧会让旧原文继续留在服务器。
async function recheckCommitted(
  tx: Tx,
  metadata: typeof workStreams.$inferSelect,
  ctx: RetainContext,
): Promise<{ kind: "ok"; snapshot: RetainSnapshot } | Extract<WorkAppendResult, { kind: "invalid" }>> {
  const scope = and(
    eq(workStreams.botId, metadata.botId),
    eq(workStreams.groupId, metadata.groupId),
    eq(workStreams.stream, metadata.stream),
  );
  const stored = await tx
    .select({ seq: workEntries.seq, entryId: workEntries.entryId, line: workEntries.line })
    .from(workEntries)
    .where(
      and(
        eq(workEntries.botId, metadata.botId),
        eq(workEntries.groupId, metadata.groupId),
        eq(workEntries.stream, metadata.stream),
        lt(workEntries.seq, metadata.nextSeq),
      ),
    )
    .orderBy(asc(workEntries.seq));
  const lines = stored.map((row) => row.line);
  const replayed = checkFrame(ctx, emptySnapshot(ctx), lines);
  const prefix = replayed.ok ? stored : stored.slice(0, "lineIndex" in replayed ? replayed.lineIndex : 0);
  const accepted = replayed.ok
    ? replayed
    : checkFrame(
        ctx,
        emptySnapshot(ctx),
        prefix.map((row) => row.line),
      );
  if (!accepted.ok) throw new Error("留存重放前缀复查失败");
  const nextSeq = prefix.length;
  const head = await advanceWorkHead(
    EMPTY_WORK_HEAD,
    prefix.map((row) => row.line),
  );
  const [updated] = await tx
    .update(workStreams)
    .set({ nextSeq, head, tailEntryId: prefix.at(-1)?.entryId ?? null, retainSnapshot: accepted.snapshot })
    .where(
      and(
        scope,
        eq(workStreams.nextSeq, metadata.nextSeq),
        eq(workStreams.head, metadata.head),
        metadata.retainSnapshot === null
          ? sql`${workStreams.retainSnapshot} IS NULL`
          : sql`${workStreams.retainSnapshot} = ${JSON.stringify(metadata.retainSnapshot)}::jsonb`,
      ),
    )
    .returning();
  if (updated === undefined) {
    const [latest] = await tx.select().from(workStreams).where(scope);
    return {
      kind: "invalid",
      reason: "tool_list_changed",
      nextSeq: latest?.nextSeq ?? 0,
      head: latest?.head ?? EMPTY_WORK_HEAD,
    };
  }
  if (!replayed.ok) {
    await tx
      .delete(workEntries)
      .where(
        and(
          eq(workEntries.botId, metadata.botId),
          eq(workEntries.groupId, metadata.groupId),
          eq(workEntries.stream, metadata.stream),
          gte(workEntries.seq, nextSeq),
        ),
      );
  }
  if (metadata.retainSnapshot !== null || !replayed.ok) {
    return {
      kind: "invalid",
      reason: "tool_list_changed",
      nextSeq,
      head,
      ...(!replayed.ok && "lineIndex" in replayed
        ? { replayReason: replayed.reason, lineIndex: replayed.lineIndex }
        : {}),
    };
  }
  return { kind: "ok", snapshot: accepted.snapshot };
}

export async function readWorkLane(
  db: Tx,
  lane: { botId: BotId; groupId: GroupId },
  stream: WorkStream,
  after: number,
  limit: number,
): Promise<HubLaneSnapshot> {
  const [owner] = await db.select({ id: bots.ownerId }).from(bots).where(eq(bots.id, lane.botId));
  if (owner === undefined) return { entries: [], nextSeq: 0, head: EMPTY_WORK_HEAD, piSessionVersion: null };
  const ctx = await currentRetainContext(db, owner.id);
  const [metadata] = await db
    .select()
    .from(workStreams)
    .where(
      and(eq(workStreams.botId, lane.botId), eq(workStreams.groupId, lane.groupId), eq(workStreams.stream, stream)),
    );
  if (metadata === undefined) return { entries: [], nextSeq: 0, head: EMPTY_WORK_HEAD, piSessionVersion: null };
  const entries = await db
    .select({ seq: workEntries.seq, line: workEntries.line })
    .from(workEntries)
    .where(
      and(
        eq(workEntries.botId, lane.botId),
        eq(workEntries.groupId, lane.groupId),
        eq(workEntries.stream, stream),
        lt(workEntries.seq, metadata.nextSeq),
      ),
    )
    .orderBy(asc(workEntries.seq));
  // 从头复查才能识别指向本机结果的 context_edit；返回合规前缀，链头仍与原样行一致。
  const checked = checkFrame(
    ctx,
    emptySnapshot(ctx),
    entries.map((entry) => entry.line),
  );
  const prefix = checked.ok ? entries : entries.slice(0, "lineIndex" in checked ? checked.lineIndex : 0);
  const nextSeq = checked.ok ? metadata.nextSeq : prefix.length;
  const head = checked.ok
    ? metadata.head
    : await advanceWorkHead(
        EMPTY_WORK_HEAD,
        prefix.map((entry) => entry.line),
      );
  return {
    entries: prefix.filter((entry) => entry.seq > after).slice(0, limit),
    nextSeq,
    head,
    piSessionVersion: nextSeq === 0 ? null : metadata.piSessionVersion,
  };
}

export function workEntryVisibleTo(viewer: Viewer) {
  return sql`(${workEntries.visibleTo} is null or ${workEntries.visibleTo} @> ${JSON.stringify([viewer])}::jsonb)`;
}

export async function recallWorkRecords(
  db: Tx,
  ownerId: UserId,
  viewer: Extract<Viewer, { kind: "bot" }>,
  excludeGroupId: GroupId,
  query: string,
): Promise<RecallEntry[]> {
  const ctx = await currentRetainContext(db, ownerId);
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db
    .select({
      groupId: workEntries.groupId,
      groupTitle: tasks.title,
      runAt: runs.startedAt,
      groupAt: groups.createdAt,
      line: workEntries.line,
      seq: workEntries.seq,
      score: sql<number>`similarity(${workEntries.searchText}, ${query})`,
    })
    .from(workEntries)
    .innerJoin(groups, and(eq(groups.id, workEntries.groupId), eq(groups.ownerId, ownerId)))
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.botId, viewer.botId)))
    .innerJoin(tasks, eq(tasks.groupId, groups.id))
    .leftJoin(runs, eq(runs.id, workEntries.runId))
    .where(
      and(
        eq(workEntries.botId, viewer.botId),
        eq(workEntries.ownerId, ownerId),
        eq(workEntries.stream, "chat"),
        workEntryVisibleTo(viewer),
        isNull(workEntries.visibleTo),
        ne(workEntries.groupId, excludeGroupId),
        eq(workEntries.piType, "message"),
        sql`${workEntries.searchText} ILIKE ${pattern}`,
      ),
    );
  const safe: { entry: RecallEntry; score: number; seq: number }[] = [];
  for (const row of rows) {
    const retained = createRetainer(ctx).retain(row.line);
    if (retained.status !== "retained") continue;
    let value: unknown;
    try {
      value = JSON.parse(retained.line) as unknown;
    } catch {
      continue;
    }
    const parsed = PiWorkEntry.safeParse(value);
    if (!parsed.success) continue;
    const { message, timestamp } = parsed.data;
    if (typeof message !== "object" || message === null || !("role" in message)) continue;
    const kind = message.role;
    if (kind !== "user" && kind !== "assistant" && kind !== "toolResult") continue;
    const text = extractWorkSearchText(parsed.data);
    if (!text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
    // JSONL 的非检索字段允许转义 NUL，不能再整行转成 PostgreSQL jsonb。
    const timestampMs = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    const at = Number.isFinite(timestampMs) ? new Date(timestampMs) : (row.runAt ?? row.groupAt);
    safe.push({
      entry: {
        groupId: GroupId.parse(row.groupId),
        groupTitle: row.groupTitle,
        at: at.toISOString(),
        kind,
        excerpt: recallExcerpt(text, query),
      },
      score: row.score,
      seq: row.seq,
    });
  }
  return safe
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        right.entry.at.localeCompare(left.entry.at) ||
        left.entry.groupId.localeCompare(right.entry.groupId) ||
        right.seq - left.seq,
    )
    .slice(0, RECALL_LIMIT)
    .map(({ entry }) => entry);
}

function recallExcerpt(text: string, query: string): string {
  const match = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const before = Math.floor((RECALL_EXCERPT_LENGTH - query.length) / 2);
  const start = Math.max(0, Math.min(match - before, text.length - RECALL_EXCERPT_LENGTH));
  return text.slice(start, start + RECALL_EXCERPT_LENGTH);
}
