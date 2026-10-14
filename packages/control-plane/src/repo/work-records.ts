import {
  EMPTY_WORK_HEAD,
  PiWorkEntry,
  advanceWorkHead,
  extractWorkSearchText,
  type BotId,
  type GroupId,
  type HubLaneSnapshot,
  type Viewer,
  type WorkAppend,
  type WorkAppendResult,
  type WorkStream,
} from "@baize/shared";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { AgentConnection } from "../agent/hub.js";
import type { Db } from "../db/client.js";
import { bots, groupMembers, groups, laneLeases, pokerTables, runs, workEntries, workStreams } from "../db/schema.js";
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
    .where(and(eq(workStreams.botId, botId), eq(workStreams.groupId, groupId), eq(workStreams.stream, stream)));
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
  const head = await advanceWorkHead(metadata?.head ?? EMPTY_WORK_HEAD, frame.lines);
  if (head !== frame.head) return { kind: "head_mismatch" };

  if (firstImport) {
    const [claimed] = await tx
      .insert(laneLeases)
      .values({ botId, groupId, holderComputerId: conn.computerId, holderInstallId: conn.installId, epoch: 1 })
      .onConflictDoUpdate({
        target: [laneLeases.botId, laneLeases.groupId],
        set: { epoch: 1, updatedAt: sql`clock_timestamp()` },
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
