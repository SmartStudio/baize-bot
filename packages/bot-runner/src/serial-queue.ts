interface Entry<T> {
  readonly value: T;
  phase: "queued" | "running" | "discarded";
  onDiscard: (() => void) | null;
}

export class SerialQueue<T> {
  private tail: Promise<void> = Promise.resolve();
  private readonly entries = new Set<Entry<T>>();

  enqueue(value: T, operation: () => Promise<void>): Promise<void> {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const entry: Entry<T> = { value, phase: "queued", onDiscard: null };
    this.entries.add(entry);
    const next = this.tail.then(async () => {
      if (entry.phase === "discarded") {
        try {
          entry.onDiscard?.();
          resolve();
        } catch (error) {
          reject(error);
        }
        return;
      }
      entry.phase = "running";
      try {
        await operation();
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        this.entries.delete(entry);
      }
    });
    this.tail = next.catch(() => undefined);
    return completion;
  }

  find(predicate: (value: T) => boolean): { readonly phase: "queued" | "running"; readonly value: T } | null {
    for (const entry of this.entries) {
      if (entry.phase !== "discarded" && predicate(entry.value)) return { phase: entry.phase, value: entry.value };
    }
    return null;
  }

  discard(predicate: (value: T) => boolean, onDiscard?: (value: T) => void): readonly T[] {
    const discarded: T[] = [];
    for (const entry of this.entries) {
      if (entry.phase !== "queued" || !predicate(entry.value)) continue;
      entry.phase = "discarded";
      entry.onDiscard = onDiscard === undefined ? null : () => onDiscard(entry.value);
      this.entries.delete(entry);
      discarded.push(entry.value);
    }
    return discarded;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
