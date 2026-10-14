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
import { RetainSnapshot, checkFrame, emptySnapshot, type RetainContext } from "@baize/shared/work-record";
import { and, asc, desc, eq, gte, gt, isNull, lt, ne, sql } from "drizzle-orm";
import type { AgentConnection } from "../agent/hub.js";
import type { Db } from "../db/client.js";
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
  if (!firstImport || !sameHolder) {
    if (lease !== undefined && lease.epoch !== epoch) return { kind: "stale_epoch" };
    if (!sameHolder && !(firstImport && lease === undefined)) return { kind: "not_holder" };
  }
  if (frame.lines.length === 0) return { kind: "ok" };

  let visibleTo: Viewer[] | null;
  if (frame.cause === "import") {
    if (frame.runId !== null || (firstImport && epoch !== 1)) return { kind: "invalid" };
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
  const localTools = await tx
    .select({ operations: toolConnections.operations })
    .from(toolConnections)
    .where(and(eq(toolConnections.ownerId, conn.ownerId), eq(toolConnections.localOnly, true)));
  const ctx: RetainContext = {
    localOnlyToolNames: new Set(localTools.flatMap((tool) => tool.operations.map((op) => op.name))),
  };
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

  if (firstImport) {
    const [claimed] = await tx
      .insert(laneLeases)
      .values({ botId, groupId, holderComputerId: conn.computerId, holderInstallId: conn.installId, epoch: 1 })
      .onConflictDoUpdate({
        target: [laneLeases.botId, laneLeases.groupId],
        set: { updatedAt: sql`clock_timestamp()` },
        setWhere: and(
          eq(laneLeases.holderComputerId, conn.computerId),
          eq(laneLeases.holderInstallId, conn.installId),
          sql`NOT EXISTS (SELECT 1 FROM ${workStreams} WHERE ${workStreams.botId} = ${botId}
            AND ${workStreams.groupId} = ${groupId} AND ${workStreams.stream} = ${stream} AND ${workStreams.nextSeq} > 0)`,
        )!,
      })
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
  db: Db | Tx,
  lane: { botId: BotId; groupId: GroupId },
  stream: WorkStream,
  after: number,
  limit: number,
): Promise<HubLaneSnapshot> {
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
        gt(workEntries.seq, after),
        lt(workEntries.seq, metadata.nextSeq),
      ),
    )
    .orderBy(asc(workEntries.seq))
    .limit(limit);
  return { entries, nextSeq: metadata.nextSeq, head: metadata.head, piSessionVersion: metadata.piSessionVersion };
}

export function workEntryVisibleTo(viewer: Viewer) {
  return sql`(${workEntries.visibleTo} is null or ${workEntries.visibleTo} @> ${JSON.stringify([viewer])}::jsonb)`;
}

export async function recallWorkRecords(
  db: Db | Tx,
  ownerId: UserId,
  viewer: Extract<Viewer, { kind: "bot" }>,
  excludeGroupId: GroupId,
  query: string,
): Promise<RecallEntry[]> {
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const kind = sql<RecallEntry["kind"]>`${workEntries.line}::jsonb->'message'->>'role'`;
  const at = sql`coalesce(
    CASE WHEN pg_input_is_valid(${workEntries.line}::jsonb->>'timestamp', 'timestamp with time zone')
      THEN (${workEntries.line}::jsonb->>'timestamp')::timestamptz END,
    ${runs.startedAt}, ${groups.createdAt}
  )`;
  const rows = await db
    .select({
      groupId: workEntries.groupId,
      groupTitle: tasks.title,
      at: at.mapWith(groups.createdAt),
      kind,
      text: workEntries.searchText,
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
        sql`${kind} IN ('user', 'assistant', 'toolResult')`,
        sql`${workEntries.searchText} ILIKE ${pattern}`,
      ),
    )
    .orderBy(
      desc(sql`similarity(${workEntries.searchText}, ${query})`),
      desc(at),
      asc(workEntries.groupId),
      desc(workEntries.seq),
    )
    .limit(RECALL_LIMIT);
  return rows.map((row) => ({
    groupId: GroupId.parse(row.groupId),
    groupTitle: row.groupTitle,
    at: row.at.toISOString(),
    kind: row.kind,
    excerpt: recallExcerpt(row.text, query),
  }));
}

function recallExcerpt(text: string, query: string): string {
  const match = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const before = Math.floor((RECALL_EXCERPT_LENGTH - query.length) / 2);
  const start = Math.max(0, Math.min(match - before, text.length - RECALL_EXCERPT_LENGTH));
  return text.slice(start, start + RECALL_EXCERPT_LENGTH);
}
