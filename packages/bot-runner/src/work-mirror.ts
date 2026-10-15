import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  EMPTY_WORK_HEAD,
  HubLaneSnapshot,
  advanceWorkHead,
  type BotId,
  type GroupId,
  type RunId,
  type WorkAppend,
  type WorkStream,
} from "@baize/shared";
import { createRetainer, toolListFingerprint, type RetainSnapshot } from "@baize/shared/work-record";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  parseSessionEntries,
  type ExtensionAPI,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import type { WorkAppender, WorkAppendOutcome } from "./lane-fence.js";

const MirrorStream = z.object({
  sessionFile: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  head: z.string().regex(/^[0-9a-f]{64}$/),
});
const MirrorFile = z.object({
  epoch: z.number().int().positive(),
  streams: z.object({ chat: MirrorStream.optional(), table: MirrorStream.optional() }),
});
type MirrorFile = z.infer<typeof MirrorFile>;
export type WorkCause = WorkAppend["cause"];
export type WorkFlush = (cause: WorkCause) => Promise<WorkAppendOutcome>;

export function installWorkFlush(pi: ExtensionAPI, flush: WorkFlush): void {
  pi.on("turn_end", async () => {
    await flush("turn_end");
  });
  pi.on("session_compact", async () => {
    await flush("compact");
  });
  pi.on("agent_settled", async () => {
    await flush("settled");
  });
}

interface MirrorOptions {
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly stream: WorkStream;
  readonly groupDir: string;
  readonly sessionDir: string;
  readonly workDir: string;
  readonly append: () => WorkAppender | undefined;
  readonly live: () => {
    hub: { baseUrl: string };
    gateway: { apiKey: string };
    localOnlyToolNames: ReadonlySet<string>;
  };
  readonly log: (message: string) => void;
  readonly cold: () => void;
}

/** 一条 Pi 流的已确认前缀。试发帧使用快照副本，ACK 成功才推进留存状态。 */
export class WorkMirror {
  #options: MirrorOptions;
  #manager: SessionManager | undefined;
  #epoch = 1;
  #seq = 0;
  #head = EMPTY_WORK_HEAD;
  #uploaded = 0;
  #lastId: string | undefined;
  #snapshot: RetainSnapshot | undefined;
  #halted: WorkAppendOutcome | undefined;
  #rebuild = false;
  #importing = false;
  #coldStarted = false;
  #tail: Promise<unknown> = Promise.resolve();
  #interrupt: (() => void) | undefined;
  #control = new AbortController();
  #reading = false;
  #flushing = false;
  #importSource: string | undefined;
  #revision = 0;

  constructor(options: MirrorOptions) {
    this.#options = options;
  }
  get manager(): SessionManager {
    if (this.#manager === undefined) throw new Error("工作记录尚未打开");
    return this.#manager;
  }
  invalidate(): void {
    this.#revision += 1;
    this.#rebuild = true;
    this.#halted = { kind: "disconnected" };
    this.#control.abort();
    this.#interrupt?.();
  }
  cancelPending(): void {
    if (this.#flushing || this.#reading) this.invalidate();
  }

  async prepare(
    epoch: number,
    server: { seq: number; head: string },
    runId: RunId,
    current?: SessionManager,
  ): Promise<SessionManager> {
    const revision = this.#revision;
    const memoryCurrent = this.#epoch === epoch && current !== undefined && current === this.#manager;
    await this.#tail;
    if (revision !== this.#revision) throw new Error("工作记录读取已经取消");
    if (this.#importing && this.#halted !== undefined && this.#halted.kind !== "disconnected")
      throw new Error(`旧会话导入已停止：${this.#halted.kind}`);
    this.#control = new AbortController();
    this.#epoch = epoch;
    const metadata = this.#readMetadata();
    const saved = metadata?.streams[this.#options.stream];
    const hasMetadata = existsSync(join(this.#options.groupDir, "lane.json"));
    if (saved === undefined && (metadata !== undefined || !hasMetadata) && (!this.#rebuild || this.#importing)) {
      const legacy = this.#importSource ?? this.#legacyFile();
      if (legacy !== undefined) {
        const resuming = this.#importing && this.#manager !== undefined;
        if (!resuming) {
          mkdirSync(this.#options.sessionDir, { recursive: true });
          const imported = join(this.#options.sessionDir, `import-${randomUUID()}.jsonl`);
          copyFileSync(legacy, imported);
          this.#manager = SessionManager.open(imported, this.#options.sessionDir, this.#options.workDir);
          this.#reset();
          this.#importSource = legacy;
        }
        this.#importing = true;
        if (resuming) {
          const committed = await this.#readServer();
          const prefix = this.#filter(
            this.manager
              .getEntries()
              .slice(0, committed.nextSeq)
              .map((entry) => JSON.stringify(entry)),
          );
          if (
            prefix.lines.length !== committed.nextSeq ||
            (await advanceWorkHead(EMPTY_WORK_HEAD, prefix.lines)) !== committed.head
          ) {
            this.#stop({ kind: "head_mismatch" });
            throw new Error("旧会话导入的服务器前缀不一致");
          }
          this.#assertRevision(revision);
          this.#setPrefix(committed.nextSeq, committed.head, prefix.snapshot);
        }
        const result = await this.flush("import", null);
        this.#assertRevision(revision);
        if (result.kind !== "ok") {
          // 非 ok 导入不能追着服务器游标重试，更不能把旧文件当普通尾巴补传。
          this.#options.log(`旧会话导入停止：${result.kind}`);
          throw new Error(`旧会话导入停止：${result.kind}`);
        }
        this.#importing = false;
        this.#importSource = undefined;
        this.#save();
        return this.manager;
      }
    }
    let local = current;
    if (
      local === undefined &&
      saved?.sessionFile !== null &&
      saved?.sessionFile !== undefined &&
      this.#inside(saved.sessionFile)
    ) {
      try {
        if (existsSync(saved.sessionFile))
          local = SessionManager.open(saved.sessionFile, this.#options.sessionDir, this.#options.workDir);
      } catch {
        /* 下方统一按服务器重建。 */
      }
    }
    const file = local?.getSessionFile();
    if (
      !this.#rebuild &&
      metadata?.epoch === epoch &&
      saved !== undefined &&
      (saved.sessionFile !== null || memoryCurrent) &&
      local !== undefined &&
      (file === undefined || existsSync(file))
    ) {
      const entries = local.getEntries();
      const prefix = this.#filter(entries.slice(0, server.seq).map((entry) => JSON.stringify(entry)));
      let diskMatches = true;
      if (file !== undefined) {
        try {
          const disk = parseSessionEntries(readFileSync(file, "utf8")).filter((entry) => entry.type !== "session");
          diskMatches =
            disk.length >= server.seq &&
            (await advanceWorkHead(
              EMPTY_WORK_HEAD,
              this.#filter(disk.slice(0, server.seq).map((entry) => JSON.stringify(entry))).lines,
            )) === server.head;
        } catch {
          diskMatches = false;
        }
      }
      if (
        entries.length >= server.seq &&
        prefix.lines.length === server.seq &&
        (await advanceWorkHead(EMPTY_WORK_HEAD, prefix.lines)) === server.head &&
        diskMatches
      ) {
        this.#assertRevision(revision);
        this.#manager = local;
        this.#setPrefix(server.seq, server.head, prefix.snapshot);
        this.#save();
        return local;
      }
    }
    // 全新空道不需要 HTTP；已有服务器历史只能通过授权的 Hub 快照恢复。
    if (!hasMetadata && local === undefined && server.seq === 0 && !this.#rebuild) {
      this.#manager = SessionManager.create(this.#options.workDir, this.#options.sessionDir);
      this.#reset();
      this.#save();
      return this.manager;
    }
    const snapshot = await this.#readServer();
    this.#assertRevision(revision);
    this.#stale(file ?? saved?.sessionFile ?? undefined);
    this.#reset();
    this.#manager = this.#restore(snapshot);
    if (this.#coldStarted) {
      this.#seq = snapshot.nextSeq;
      this.#head = snapshot.head;
      this.#snapshot = this.#filter(snapshot.entries.map((entry) => entry.line)).snapshot;
    } else {
      const prefix = this.#filter(snapshot.entries.map((entry) => entry.line));
      // Hub 的原始链已核对。新名单可能会改写旧前缀，下一帧让服务器复查并截断，再按新名单补传。
      if (prefix.lines.length !== snapshot.nextSeq) throw new Error("服务器记录不符合留存规则");
      this.#setPrefix(snapshot.nextSeq, snapshot.head, prefix.snapshot);
      this.#completeTools();
      const result = await this.flush("settled", runId);
      this.#assertRevision(revision);
      if (result.kind !== "ok") throw new Error(`悬空调用记录没有确认：${result.kind}`);
    }
    this.#save();
    return this.manager;
  }

  flush(cause: WorkCause, runId: RunId | null): Promise<WorkAppendOutcome> {
    const operation = this.#tail.then(async () => {
      this.#flushing = true;
      try {
        return await this.#flush(cause, runId);
      } finally {
        this.#flushing = false;
      }
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async #flush(cause: WorkCause, runId: RunId | null): Promise<WorkAppendOutcome> {
    const revision = this.#revision;
    if (this.#halted !== undefined) return this.#halted;
    const append = this.#options.append();
    if (append === undefined || this.#manager === undefined) return { kind: "disconnected" };
    const entries = this.manager.getEntries();
    if (entries.length < this.#uploaded || (this.#uploaded > 0 && entries[this.#uploaded - 1]?.id !== this.#lastId))
      return this.#stop({ kind: "head_mismatch" });
    const retried = new Set<string>();
    for (;;) {
      if (revision !== this.#revision || this.#control.signal.aborted) return { kind: "disconnected" };
      const pending = entries.slice(this.#uploaded, this.#uploaded + 64);
      if (pending.length === 0 && cause !== "before_effect") {
        this.#save();
        return { kind: "ok" };
      }
      const localOnlyToolNames = this.#options.live().localOnlyToolNames;
      const start =
        this.#snapshot !== undefined && this.#snapshot.toolFingerprint !== toolListFingerprint(localOnlyToolNames)
          ? this.#filter(entries.slice(0, this.#uploaded).map((entry) => JSON.stringify(entry))).snapshot
          : this.#snapshot;
      const retainer = createRetainer({ localOnlyToolNames }, start);
      const lines: string[] = [];
      for (const entry of pending) {
        const retained = retainer.retain(JSON.stringify(entry));
        if (retained.status === "rejected") return this.#stop({ kind: "invalid", reason: retained.reason });
        lines.push(retained.line);
      }
      const head = await advanceWorkHead(this.#head, lines);
      if (revision !== this.#revision || this.#control.signal.aborted) return { kind: "disconnected" };
      let result: WorkAppendOutcome;
      const interrupted = new Promise<WorkAppendOutcome>((done) => {
        this.#interrupt = () => done({ kind: "disconnected" });
      });
      try {
        result = await Promise.race([
          append({
            type: "work_append",
            lane: {
              botId: this.#options.botId,
              groupId: this.#options.groupId,
              stream: this.#options.stream,
              epoch: this.#epoch,
            },
            runId,
            fromSeq: this.#seq,
            lines,
            head,
            cause,
          }),
          interrupted,
        ]);
      } catch {
        result = { kind: "disconnected" };
      } finally {
        this.#interrupt = undefined;
      }
      if (revision !== this.#revision || this.#control.signal.aborted) return { kind: "disconnected" };
      if (result.kind === "ok") {
        this.#seq += lines.length;
        this.#head = head;
        this.#uploaded += lines.length;
        this.#lastId = entries[this.#uploaded - 1]?.id;
        this.#snapshot = retainer.snapshot();
        this.#save();
        if (this.#uploaded === entries.length) return result;
        continue;
      }
      if (result.kind === "disconnected") return result;
      if (this.#importing) return this.#stop(result);
      const retry = result.kind === "invalid" ? result.reason : result.kind;
      // 一次 flush 每种恢复最多一次；成功帧严格推进游标，拒帧最多三次恢复。
      if (retry === undefined || retried.has(retry)) return this.#stop(result);
      retried.add(retry);
      if (result.kind === "seq_mismatch" || (result.kind === "invalid" && result.reason === "tool_list_changed")) {
        try {
          const snapshot = await this.#readServer();
          if (result.kind === "seq_mismatch" && snapshot.nextSeq !== result.nextSeq) return this.#stop(result);
          if (
            result.kind === "invalid" &&
            ((result.nextSeq !== undefined && result.nextSeq !== snapshot.nextSeq) ||
              (result.head !== undefined && result.head !== snapshot.head))
          )
            return this.#stop(result);
          const filtered = this.#filter(entries.slice(0, snapshot.nextSeq).map((entry) => JSON.stringify(entry)));
          if (
            filtered.lines.length !== snapshot.nextSeq ||
            (await advanceWorkHead(EMPTY_WORK_HEAD, filtered.lines)) !== snapshot.head
          )
            return this.#stop({ kind: "head_mismatch" });
          this.#assertRevision(revision);
          this.#setPrefix(snapshot.nextSeq, snapshot.head, filtered.snapshot);
          continue;
        } catch {
          return this.#stop(result);
        }
      }
      if (result.kind === "invalid" && result.reason === "unfiltered") {
        const filtered = this.#filter(entries.slice(0, this.#uploaded).map((entry) => JSON.stringify(entry)));
        if (
          filtered.lines.length !== this.#uploaded ||
          (await advanceWorkHead(EMPTY_WORK_HEAD, filtered.lines)) !== this.#head
        )
          return this.#stop({ kind: "head_mismatch" });
        const refreshed = createRetainer(
          { localOnlyToolNames: this.#options.live().localOnlyToolNames },
          filtered.snapshot,
        );
        const replacement: string[] = [];
        for (const entry of pending) {
          const retained = refreshed.retain(JSON.stringify(entry));
          if (retained.status === "rejected") return this.#stop({ kind: "invalid", reason: retained.reason });
          replacement.push(retained.line);
        }
        if (JSON.stringify(replacement) === JSON.stringify(lines)) return this.#stop(result);
        this.#assertRevision(revision);
        this.#snapshot = filtered.snapshot;
        continue;
      }
      return this.#stop(result);
    }
  }

  #stop(result: WorkAppendOutcome): WorkAppendOutcome {
    this.#rebuild = true;
    this.#halted = result;
    this.#options.log(`工作记录停止上传：${JSON.stringify(result)}`);
    return result;
  }

  #assertRevision(revision: number): void {
    this.#control.signal.throwIfAborted();
    if (revision !== this.#revision) throw new Error("工作记录操作已经取消");
  }

  #reset(): void {
    this.#seq = 0;
    this.#head = EMPTY_WORK_HEAD;
    this.#uploaded = 0;
    this.#lastId = undefined;
    this.#snapshot = undefined;
    this.#halted = undefined;
    this.#rebuild = false;
    this.#coldStarted = false;
  }

  #setPrefix(seq: number, head: string, snapshot: RetainSnapshot): void {
    this.#seq = seq;
    this.#head = head;
    this.#uploaded = seq;
    this.#snapshot = snapshot;
    this.#lastId = this.manager.getEntries()[seq - 1]?.id;
    this.#halted = undefined;
    this.#rebuild = false;
  }

  #filter(lines: readonly string[]): { lines: string[]; snapshot: RetainSnapshot } {
    const retainer = createRetainer({ localOnlyToolNames: this.#options.live().localOnlyToolNames });
    const filtered: string[] = [];
    for (const line of lines) {
      const retained = retainer.retain(line);
      if (retained.status === "rejected") break;
      filtered.push(retained.line);
    }
    return { lines: filtered, snapshot: retainer.snapshot() };
  }

  async #readServer(): Promise<HubLaneSnapshot> {
    this.#reading = true;
    try {
      return await this.#fetchServer(this.#control.signal);
    } finally {
      this.#reading = false;
    }
  }

  async #fetchServer(signal: AbortSignal): Promise<HubLaneSnapshot> {
    const lines: HubLaneSnapshot["entries"] = [];
    let first: HubLaneSnapshot | undefined;
    for (;;) {
      const { hub, gateway } = this.#options.live();
      const url = new URL(
        `${hub.baseUrl.replace(/\/$/, "")}/lanes/${encodeURIComponent(this.#options.botId)}/${encodeURIComponent(this.#options.groupId)}/${this.#options.stream}`,
      );
      url.searchParams.set("after", String(lines.length - 1));
      url.searchParams.set("limit", "200");
      const response = await fetch(url, {
        signal,
        headers: {
          authorization: `Bearer ${gateway.apiKey}`,
          "x-baize-lane": `${this.#options.botId}/${this.#options.groupId}/${this.#epoch}`,
        },
      });
      if (!response.ok) throw new Error(`读取服务器工作记录失败：${response.status}`);
      const page = HubLaneSnapshot.parse(await response.json());
      signal.throwIfAborted();
      first ??= page;
      if (
        page.nextSeq !== first.nextSeq ||
        page.head !== first.head ||
        page.piSessionVersion !== first.piSessionVersion
      )
        throw new Error("分页期间服务器记录变化");
      for (const entry of page.entries) {
        if (entry.seq !== lines.length) throw new Error("服务器记录序号不连续");
        lines.push(entry);
      }
      if (lines.length === first.nextSeq) break;
      if (page.entries.length === 0 || lines.length > first.nextSeq) throw new Error("服务器记录分页没有前进");
    }
    if (
      (await advanceWorkHead(
        EMPTY_WORK_HEAD,
        lines.map((entry) => entry.line),
      )) !== first.head
    )
      throw new Error("服务器记录链头不一致");
    signal.throwIfAborted();
    return { ...first, entries: lines };
  }

  #restore(snapshot: HubLaneSnapshot): SessionManager {
    if (snapshot.piSessionVersion !== null && snapshot.piSessionVersion > CURRENT_SESSION_VERSION) return this.#cold();
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: this.#options.workDir,
    };
    const text = [JSON.stringify(header), ...snapshot.entries.map((entry) => entry.line)].join("\n") + "\n";
    try {
      mkdirSync(this.#options.sessionDir, { recursive: true });
      const file = join(this.#options.sessionDir, `rebuilt-${randomUUID()}.jsonl`);
      this.#atomic(file, text);
      const manager = SessionManager.open(file, this.#options.sessionDir, this.#options.workDir);
      if (manager.getEntries().length !== snapshot.nextSeq) throw new Error("Pi 打开记录时丢失条目");
      return manager;
    } catch (error) {
      this.#options.log(`文件重建失败：${String(error)}`);
      try {
        const entries = parseSessionEntries(text);
        const manager = SessionManager.inMemory(this.#options.workDir, undefined, entries);
        if (manager.getEntries().length !== snapshot.nextSeq)
          throw new Error("Pi 内存重建时丢失条目", { cause: error });
        return manager;
      } catch (fallback) {
        this.#options.log(`内存重建失败：${String(fallback)}`);
        return this.#cold();
      }
    }
  }

  #cold(): SessionManager {
    this.#coldStarted = true;
    this.#options.cold();
    return SessionManager.inMemory(this.#options.workDir);
  }

  #completeTools(): void {
    // 只补尾部那一步。更早的悬空调用 Pi 发请求时会在原位补上，中断的一步 Pi 整条跳过；
    // 补在末尾的结果前面没有对应的调用，上游会拒绝整个请求。
    let missing = new Map<string, string>();
    for (const entry of this.manager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "toolResult") missing.delete(message.toolCallId);
      else if (message.role === "assistant")
        missing = new Map(
          message.stopReason === "error" || message.stopReason === "aborted"
            ? []
            : message.content.flatMap((block) => (block.type === "toolCall" ? [[block.id, block.name] as const] : [])),
        );
      else if (message.role !== "system") missing.clear();
    }
    for (const [toolCallId, toolName] of missing)
      this.manager.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: "结果未知，上一台电脑在这一步断开了" }],
        isError: true,
        timestamp: Date.now(),
      });
  }

  #readMetadata(): MirrorFile | undefined {
    try {
      return MirrorFile.parse(JSON.parse(readFileSync(join(this.#options.groupDir, "lane.json"), "utf8")));
    } catch {
      return undefined;
    }
  }

  #save(): void {
    if (this.#manager === undefined || this.#importing) return;
    const previous = this.#readMetadata();
    const streams =
      previous?.epoch === this.#epoch
        ? previous.streams
        : {
            ...(previous?.streams.chat === undefined ? {} : { chat: { ...previous.streams.chat, sessionFile: null } }),
            ...(previous?.streams.table === undefined
              ? {}
              : { table: { ...previous.streams.table, sessionFile: null } }),
          };
    const metadata: MirrorFile = {
      epoch: this.#epoch,
      streams: {
        ...streams,
        [this.#options.stream]: {
          sessionFile: this.manager.getSessionFile() ?? null,
          seq: this.#seq,
          head: this.#head,
        },
      },
    };
    try {
      this.#atomic(join(this.#options.groupDir, "lane.json"), JSON.stringify(metadata) + "\n");
    } catch (error) {
      this.#options.log(`镜像元数据写入失败，下次按服务器重建：${String(error)}`);
    }
  }

  #atomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  #inside(file: string): boolean {
    return dirname(resolve(file)) === resolve(this.#options.sessionDir);
  }
  #stale(file: string | undefined): void {
    if (file === undefined || !this.#inside(file) || !existsSync(file)) return;
    const stale = join(this.#options.sessionDir, ".stale");
    mkdirSync(stale, { recursive: true });
    renameSync(file, join(stale, `${randomUUID()}-${basename(file)}`));
  }

  #legacyFile(): string | undefined {
    if (!existsSync(this.#options.sessionDir)) return undefined;
    const candidates = readdirSync(this.#options.sessionDir)
      .filter((name) => name.endsWith(".jsonl") && !name.startsWith("import-"))
      .map((name) => join(this.#options.sessionDir, name))
      .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return candidates.find((file) => {
      try {
        const header: FileEntry | undefined = parseSessionEntries(readFileSync(file, "utf8"))[0];
        return header?.type === "session" && resolve(header.cwd) === resolve(this.#options.workDir);
      } catch {
        return false;
      }
    });
  }
}
