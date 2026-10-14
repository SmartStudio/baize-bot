import {
  AgentToControl,
  BotId,
  UserId,
  ControlToAgent,
  DOWNLINK_DELIVERY,
  RUN_CLOSED_ACCEPTS,
  UPLINK_DELIVERY,
  UplinkFrame,
  UplinkHeader,
  type ComputerId,
  type RunId,
  type UplinkAck,
  type UplinkRejection,
} from "@baize/shared";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentOutbox, bots, computers, groupMembers, routineRuns, routines, runs } from "../db/schema.js";
import type { Tx } from "../repo/messages.js";
import { lockOwner, shareBotRunsLock } from "../repo/runs.js";

export type Hello = Extract<AgentToControl, { type: "hello" }>;

/** 发件箱和上行共用电脑行锁，先过删除入口的归属人、Bot 锁，避免与级联删除反序。 */
export async function lockEnvelopeComputer(
  tx: Tx,
  computerId: ComputerId,
  botIds: BotId | readonly BotId[] = [],
): Promise<void> {
  const [computer] = await tx
    .select({ ownerId: computers.ownerId })
    .from(computers)
    .where(eq(computers.id, computerId));
  if (computer === undefined) return;
  await lockOwner(tx, UserId.parse(computer.ownerId), "shared");
  for (const botId of [...new Set(typeof botIds === "string" ? [botIds] : botIds)].toSorted())
    await shareBotRunsLock(tx, botId);
  await tx.select({ id: computers.id }).from(computers).where(eq(computers.id, computerId)).for("no key update");
}

export async function beginHandshake(db: Db, computerId: ComputerId, hello: Hello, leaseMs = 60_000) {
  return db.transaction(async (tx) => {
    await lockEnvelopeComputer(tx, computerId);
    const [row] = await tx
      .update(computers)
      .set({
        connGen: sql`${computers.connGen} + 1`,
        upStream: hello.uplinkStream,
        upAcked: sql`CASE WHEN ${computers.upStream} = ${hello.uplinkStream} THEN ${computers.upAcked} ELSE 0 END`,
        downApplied: sql`greatest(${computers.downApplied}, least(${hello.downApplied}, ${computers.downSeq}))`,
        installId: hello.installId,
        leaseUntil: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
      })
      .where(eq(computers.id, computerId))
      .returning();
    if (row === undefined) throw new Error("电脑已删除");
    await tx
      .delete(agentOutbox)
      .where(and(eq(agentOutbox.computerId, computerId), lte(agentOutbox.seq, row.downApplied)));
    return { conn: row.connGen, upAcked: row.upAcked };
  });
}

export async function isCurrentConnection(db: Db | Tx, computerId: ComputerId, conn: number): Promise<boolean> {
  const [row] = await db
    .select({ id: computers.id })
    .from(computers)
    .where(and(eq(computers.id, computerId), eq(computers.connGen, conn)));
  return row !== undefined;
}

export async function enqueueDownlink(
  tx: Tx,
  computerId: ComputerId,
  body: ControlToAgent,
  runId?: RunId,
): Promise<boolean> {
  const parsed = ControlToAgent.parse(body);
  if (DOWNLINK_DELIVERY[parsed.type] !== "reliable") throw new Error("无状态报文不入发件箱");
  const [computer] = await tx
    .update(computers)
    .set({ downSeq: sql`${computers.downSeq} + 1` })
    .where(eq(computers.id, computerId))
    .returning({ seq: computers.downSeq });
  if (computer === undefined) return false;
  if (parsed.type === "cancel" && "lane" in parsed && parsed.lane !== undefined && parsed.epoch !== undefined) {
    const epoch = parsed.epoch;
    const pending = await tx
      .select()
      .from(agentOutbox)
      .where(
        and(
          eq(agentOutbox.computerId, computerId),
          sql`${agentOutbox.body}->>'type' = 'cancel'`,
          sql`${agentOutbox.body}->'lane'->>'botId' = ${parsed.lane.botId}`,
          sql`${agentOutbox.body}->'lane'->>'groupId' = ${parsed.lane.groupId}`,
        ),
      );
    if (
      pending.some(
        ({ body: queuedBody }) =>
          queuedBody.type === "cancel" &&
          "epoch" in queuedBody &&
          queuedBody.epoch !== undefined &&
          queuedBody.epoch >= epoch,
      )
    )
      return true;
    for (const row of pending)
      await tx.delete(agentOutbox).where(and(eq(agentOutbox.computerId, computerId), eq(agentOutbox.seq, row.seq)));
  }
  // 和上行处理同样先锁电脑再锁 run，避免并发审批决定与 run 收尾互等。
  if (runId !== undefined) {
    const [run] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.computerId, computerId), isNull(runs.endedAt)))
      .for("share");
    if (run === undefined) return false;
  }
  await tx.insert(agentOutbox).values({ computerId, seq: computer.seq, body: parsed, runId: runId ?? null });
  return true;
}

export async function acknowledgeDownlink(
  db: Db | Tx,
  computerId: ComputerId,
  conn: number,
  upTo: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(computers)
      .set({ downApplied: sql`greatest(${computers.downApplied}, ${upTo})` })
      .where(and(eq(computers.id, computerId), eq(computers.connGen, conn), lte(sql`${upTo}`, computers.downSeq)))
      .returning();
    if (row === undefined) return;
    await tx
      .delete(agentOutbox)
      .where(and(eq(agentOutbox.computerId, computerId), lte(agentOutbox.seq, row.downApplied)));
  });
}

export async function replayOutbox(
  db: Db,
  computerId: ComputerId,
  send: (frame: string) => boolean,
  after = 0,
): Promise<number> {
  let sent = after;
  for (const row of await db
    .select()
    .from(agentOutbox)
    .where(and(eq(agentOutbox.computerId, computerId), gt(agentOutbox.seq, after)))
    .orderBy(asc(agentOutbox.seq))) {
    if (!send(JSON.stringify({ type: "downlink", seq: row.seq, body: row.body }))) break;
    sent = row.seq;
  }
  return sent;
}

export async function pendingPrompts(db: Db, computerId: ComputerId): Promise<Set<RunId>> {
  const rows = await db
    .select({ runId: agentOutbox.runId, body: agentOutbox.body })
    .from(agentOutbox)
    .where(eq(agentOutbox.computerId, computerId));
  return new Set(rows.flatMap((row) => (row.body.type === "prompt" && row.runId !== null ? [row.runId as RunId] : [])));
}

export async function closedActiveRuns(db: Db, computerId: ComputerId, activeRuns: readonly RunId[]): Promise<RunId[]> {
  const closed: RunId[] = [];
  for (const runId of activeRuns) {
    const [run] = await db
      .select({ endedAt: runs.endedAt, computerId: runs.computerId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (run === undefined || run.computerId !== computerId || run.endedAt !== null) closed.push(runId);
  }
  return closed;
}

export async function clearOutbox(db: Db | Tx, computerId: ComputerId): Promise<void> {
  await db.delete(agentOutbox).where(eq(agentOutbox.computerId, computerId));
}

type Accepted =
  | { readonly kind: "ack"; readonly upTo: number; readonly rejected: readonly UplinkRejection[] }
  | { readonly kind: "stale" | "gap" };

export async function acceptUplinkFrame(
  db: Db,
  computerId: ComputerId,
  conn: number,
  raw: unknown,
  handle: (
    tx: Tx,
    body: AgentToControl,
    afterCommit: (() => Promise<void> | void)[],
    afterRollback: (() => void)[],
  ) => Promise<void | Omit<UplinkRejection, "seq">>,
): Promise<Accepted> {
  const header = UplinkHeader.safeParse(raw);
  if (!header.success || header.data.conn !== conn) return { kind: "stale" };
  const frame = header.data;
  const parsed = UplinkFrame.safeParse(raw);
  const advance = async (process: boolean) => {
    const effects: (() => Promise<void> | void)[] = [];
    const rollbacks: (() => void)[] = [];
    let result: Accepted;
    try {
      result = await db.transaction(async (tx): Promise<Accepted> => {
        const botIds: BotId[] = [];
        if (process && parsed.success && parsed.data.body.type === "work_append") {
          const lane = parsed.data.body.lane;
          const [scope] = await tx
            .select({ ownerId: computers.ownerId })
            .from(computers)
            .innerJoin(bots, and(eq(bots.id, lane.botId), eq(bots.ownerId, computers.ownerId)))
            .where(eq(computers.id, computerId));
          if (scope !== undefined) {
            await lockOwner(tx, UserId.parse(scope.ownerId), "shared");
            await shareBotRunsLock(tx, lane.botId);
            botIds.push(lane.botId);
            await tx
              .select({ id: computers.id })
              .from(computers)
              .where(eq(computers.ownerId, scope.ownerId))
              .orderBy(asc(computers.id))
              .for("no key update");
          }
        }
        if (
          process &&
          parsed.success &&
          parsed.data.body.type !== "work_append" &&
          "runId" in parsed.data.body &&
          parsed.data.body.runId !== undefined &&
          parsed.data.body.runId !== null
        ) {
          const [run] = await tx
            .select({
              botId: runs.botId,
              groupId: runs.groupId,
              tableRole: runs.tableRole,
              ownerId: runs.ownerId,
              routineRunId: runs.routineRunId,
            })
            .from(runs)
            .where(and(eq(runs.id, parsed.data.body.runId), eq(runs.computerId, computerId)));
          if (run !== undefined && run.botId !== null) botIds.push(BotId.parse(run.botId));
          if (run !== undefined && run.tableRole !== null && run.groupId !== null && run.ownerId !== null) {
            const members = await tx
              .select({ botId: groupMembers.botId })
              .from(groupMembers)
              .where(eq(groupMembers.groupId, run.groupId));
            botIds.push(...members.map((member) => BotId.parse(member.botId)));
            await lockOwner(tx, UserId.parse(run.ownerId), "shared");
            for (const botId of [...new Set(botIds)].toSorted()) await shareBotRunsLock(tx, botId);
            // 桌锁内可能把下一位派到另一台电脑，上行也要按 id 锁齐，不能先持有发送者再锁其他电脑。
            await tx
              .select({ id: computers.id })
              .from(computers)
              .where(eq(computers.ownerId, run.ownerId))
              .orderBy(asc(computers.id))
              .for("no key update");
          }
        }
        // 删除 Bot 先锁 run，删除例行先锁例行；共享 Bot 锁让这两条入口在结账期间都等待。
        await lockEnvelopeComputer(tx, computerId, botIds);
        const [claimed] = await tx
          .update(computers)
          .set({ upAcked: frame.seq })
          .where(
            and(
              eq(computers.id, computerId),
              eq(computers.connGen, conn),
              eq(computers.upStream, frame.stream),
              eq(computers.upAcked, frame.seq - 1),
            ),
          )
          .returning();
        if (claimed === undefined) {
          const [row] = await tx.select().from(computers).where(eq(computers.id, computerId));
          if (row === undefined || row.connGen !== conn) return { kind: "stale" };
          if (row.upStream === frame.stream && frame.seq <= row.upAcked)
            return { kind: "ack", upTo: row.upAcked, rejected: [] };
          return { kind: "gap" };
        }
        let rejection: UplinkRejection | undefined;
        if (!process || !parsed.success) {
          rejection = { seq: frame.seq, code: "invalid" };
          if (process && !parsed.success) {
            const rawBody = frame.body as { type?: unknown } | null;
            const type =
              rawBody !== null &&
              typeof rawBody === "object" &&
              typeof rawBody.type === "string" &&
              Object.hasOwn(UPLINK_DELIVERY, rawBody.type)
                ? rawBody.type
                : "unknown";
            const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(整条)"))].join("、");
            console.warn(`电脑 ${computerId} 上行 ${frame.seq} 的 ${type} 被拒收 invalid，出错的字段：${paths}`);
          }
        } else {
          const body = parsed.data.body;
          if (body.type !== "work_append" && "runId" in body && body.runId !== undefined) {
            const [run] = await tx.select().from(runs).where(eq(runs.id, body.runId));
            if (
              run === undefined ||
              run.computerId !== computerId ||
              ("botId" in body && body.botId !== run.botId) ||
              ("groupId" in body && body.groupId !== run.groupId)
            )
              rejection = { seq: frame.seq, code: "invalid", runId: body.runId };
            else if (run.endedAt !== null && !RUN_CLOSED_ACCEPTS.has(body.type))
              rejection = { seq: frame.seq, code: "run_closed", runId: body.runId };
          }
          if (rejection === undefined) {
            if (body.type !== "work_append" && "runId" in body && body.runId !== undefined) {
              // 删除例行先锁例行再锁 run；信封内的结账、审批停跑也必须遵守这个顺序。
              await tx.execute(sql`SELECT ${routines.id} FROM ${routines}
              JOIN ${routineRuns} ON ${routineRuns.routineId} = ${routines.id}
              JOIN ${runs} ON ${runs.routineRunId} = ${routineRuns.id}
              WHERE ${runs.id} = ${body.runId} FOR UPDATE OF ${routines}`);
            }
            const handled = await handle(tx, body, effects, rollbacks);
            if (handled !== undefined) rejection = { seq: frame.seq, ...handled };
          }
        }
        return { kind: "ack", upTo: frame.seq, rejected: rejection === undefined ? [] : [rejection] };
      });
    } catch (error) {
      for (const rollback of rollbacks.toReversed()) rollback();
      throw error;
    }
    // 确认依赖数据库提交，推送故障不能让已提交的帧再次执行处理器。
    for (const effect of effects) {
      try {
        await effect();
      } catch (error) {
        console.error(`信封提交后的推送失败：${error instanceof Error ? error.name : typeof error}`);
      }
    }
    return result;
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await advance(true);
    } catch (error) {
      const kind =
        error instanceof Error
          ? `${error.name}${"code" in error && typeof error.code === "string" ? ` ${error.code}` : ""}`
          : typeof error;
      const runId = parsed.success && "runId" in parsed.data.body ? parsed.data.body.runId : undefined;
      console.error(
        `电脑 ${computerId} 上行 ${frame.seq}${runId === undefined ? "" : ` run ${runId}`} 处理失败，第 ${attempt + 1} 次：${kind}`,
      );
    }
  }
  return advance(false);
}

export class AckBatch {
  #timer: NodeJS.Timeout | undefined;
  #upTo = 0;
  readonly #rejected: UplinkRejection[] = [];
  constructor(readonly send: (ack: UplinkAck) => void) {}
  add(upTo: number, rejected: readonly UplinkRejection[]): void {
    this.#upTo = Math.max(this.#upTo, upTo);
    this.#rejected.push(...rejected);
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.send({ type: "uplink_ack", upTo: this.#upTo, rejected: this.#rejected.splice(0) });
    }, 20);
    this.#timer.unref();
  }
  stop(): void {
    clearTimeout(this.#timer);
  }
}
