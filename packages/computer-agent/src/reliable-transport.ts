import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentToControl, UPLINK_DELIVERY, type AgentToControl as AgentMessage } from "@baize/shared";

interface StoredUplink {
  readonly seq: number;
  readonly body: Extract<AgentMessage, { type: keyof typeof UPLINK_DELIVERY }>;
}

interface OutboxState {
  readonly stream: string;
  readonly acked: number;
}

interface PendingWrite {
  readonly entry: StoredUplink;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export class ReliableOutbox {
  readonly stream: string;
  #directory: string;
  #journal: string;
  #statePath: string;
  #acked = 0;
  #next = 1;
  #durable = 0;
  #failed = false;
  #failure: unknown;
  #frames: StoredUplink[] = [];
  #writes: PendingWrite[] = [];
  #timer: NodeJS.Timeout | null = null;
  #operation: Promise<void> = Promise.resolve();

  private constructor(directory: string, state: OutboxState, frames: StoredUplink[]) {
    this.#directory = join(directory, state.stream);
    this.#statePath = join(directory, "state.json");
    this.stream = state.stream;
    this.#acked = state.acked;
    this.#frames = frames;
    this.#next = Math.max(state.acked, ...frames.map((frame) => frame.seq), 0) + 1;
    this.#durable = this.#next - 1;
    this.#journal = join(this.#directory, "frames.jsonl");
  }

  static async open(dataDir: string): Promise<ReliableOutbox> {
    const directory = join(dataDir, ".agent", "outbox");
    await mkdir(directory, { recursive: true });
    await syncDirectory(dataDir);
    await syncDirectory(dirname(directory));
    const statePath = join(directory, "state.json");
    let state: OutboxState;
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<OutboxState>;
      if (
        typeof parsed.stream !== "string" ||
        parsed.stream.length === 0 ||
        !Number.isSafeInteger(parsed.acked) ||
        (parsed.acked ?? -1) < 0
      ) {
        throw new Error("outbox state is invalid");
      }
      state = { stream: parsed.stream, acked: parsed.acked as number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { stream: randomUUID(), acked: 0 };
      await atomicWrite(statePath, JSON.stringify(state));
    }

    const streamDirectory = join(directory, state.stream);
    await mkdir(streamDirectory, { recursive: true });
    await syncDirectory(directory);
    const journal = join(streamDirectory, "frames.jsonl");
    let contents = "";
    try {
      contents = await readFile(journal, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lastNewline = contents.lastIndexOf("\n");
    if (contents.length > 0 && lastNewline !== contents.length - 1) {
      const file = await open(journal, "r+");
      try {
        await file.truncate(lastNewline + 1);
        await file.sync();
      } finally {
        await file.close();
      }
      contents = contents.slice(0, lastNewline + 1);
    }

    const frames: StoredUplink[] = [];
    for (const line of contents.split("\n").filter((item) => item.length > 0)) {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || !("seq" in value) || !("body" in value)) {
        throw new Error("outbox journal contains an invalid record");
      }
      const record = value as { seq: unknown; body: unknown };
      const body = AgentToControl.safeParse(record.body);
      if (
        !Number.isSafeInteger(record.seq) ||
        (record.seq as number) < 1 ||
        !body.success ||
        UPLINK_DELIVERY[body.data.type] !== "reliable"
      ) {
        throw new Error("outbox journal contains an invalid frame");
      }
      // 状态文件先落盘，日志压缩可能被崩溃打断；已确认的旧行仍然合法。
      if ((record.seq as number) <= state.acked) continue;
      frames.push({ seq: record.seq as number, body: body.data });
    }
    const sortedFrames = frames.toSorted((left, right) => left.seq - right.seq);
    for (let index = 0; index < sortedFrames.length; index += 1) {
      if (sortedFrames[index]?.seq !== state.acked + index + 1) throw new Error("outbox journal has a sequence gap");
    }
    return new ReliableOutbox(directory, state, sortedFrames);
  }

  get acknowledged(): number {
    return this.#acked;
  }

  pending(): readonly StoredUplink[] {
    return this.#frames.filter((frame) => frame.seq <= this.#durable);
  }

  append(body: AgentMessage): Promise<StoredUplink> {
    if (this.#failed) return Promise.reject(this.#failure);
    if (UPLINK_DELIVERY[body.type] !== "reliable") return Promise.reject(new Error(`${body.type} is not reliable`));
    const entry: StoredUplink = { seq: this.#next++, body };
    this.#frames.push(entry);
    const persisted = new Promise<void>((resolve, reject) => this.#writes.push({ entry, resolve, reject }));
    if (this.#timer === null) {
      this.#timer = setTimeout(() => void this.#flush(), 100);
      this.#timer.unref();
    }
    return persisted.then(() => entry);
  }

  async acknowledge(upTo: number): Promise<void> {
    await this.#serialize(async () => {
      await this.#flushNow();
      const bounded = Math.min(upTo, this.#next - 1);
      if (bounded <= this.#acked) return;
      const state = { stream: this.stream, acked: bounded };
      await atomicWrite(this.#statePath, JSON.stringify(state));
      this.#acked = bounded;
      this.#frames = this.#frames.filter((frame) => frame.seq > bounded);
      await this.#compact();
    });
  }

  async flush(): Promise<void> {
    await this.#serialize(() => this.#flushNow());
  }

  async #serialize(action: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(action, action);
    this.#operation = next.catch(() => undefined);
    await next;
  }

  async #flush(): Promise<void> {
    try {
      await this.#serialize(() => this.#flushNow());
    } catch {
      // append 的 Promise 把写入失败交给代理停机，不能继续产生缺号的流。
    }
  }

  async #flushNow(): Promise<void> {
    if (this.#failed) throw this.#failure;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const writes = this.#writes.splice(0);
    if (writes.length === 0) return;
    try {
      const file = await open(this.#journal, "a", 0o600);
      try {
        await file.writeFile(writes.map(({ entry }) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(this.#directory);
      this.#durable = writes.at(-1)?.entry.seq ?? this.#durable;
      for (const write of writes) write.resolve();
    } catch (error) {
      this.#failed = true;
      this.#failure = error;
      for (const write of writes) write.reject(error);
      for (const write of this.#writes.splice(0)) write.reject(error);
      throw error;
    }
  }

  async #compact(): Promise<void> {
    const contents = this.#frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
    const temporary = `${this.#journal}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.#journal);
    await syncDirectory(this.#directory);
  }
}

export class DownlinkCursor {
  #path: string;
  #applied: number;

  private constructor(path: string, applied: number) {
    this.#path = path;
    this.#applied = applied;
  }

  static async open(dataDir: string): Promise<DownlinkCursor> {
    const path = join(dataDir, ".agent", "downlink.json");
    await mkdir(dirname(path), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { applied?: unknown };
      if (!Number.isSafeInteger(parsed.applied) || (parsed.applied as number) < 0)
        throw new Error("downlink cursor is invalid");
      return new DownlinkCursor(path, parsed.applied as number);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new DownlinkCursor(path, 0);
    }
  }

  get applied(): number {
    return this.#applied;
  }

  async persist(seq: number): Promise<void> {
    if (seq <= this.#applied) return;
    await atomicWrite(this.#path, JSON.stringify({ applied: seq }));
    this.#applied = seq;
  }
}
