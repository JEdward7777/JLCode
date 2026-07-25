/**
 * AppendLog (D-37) — the persistence primitive. Append-only, coherence via a
 * **single serialized queue per file** (NOT OS file locks): records drain one
 * at a time in submission order, so they never interleave even when multiple
 * agent loops append to the same file. `append()` resolves when that record is
 * durably written (fsync on by default — records are coarse, finalized units,
 * not token deltas). A `forPath` registry hands back one instance per path so
 * all appenders truly share the same queue.
 *
 * **No cached file descriptor (D-46).** Each record opens the file, writes,
 * fsyncs and closes via `await using` (the `Symbol.asyncDispose` scope guard —
 * Node's equivalent of a Python context manager), so an fd never outlives the
 * write that needs it and the process cannot climb toward EMFILE no matter how
 * many conversations it touches. A durable fsync costs ~140ms here; the extra
 * open/close is lost in its noise, and it is far cheaper than an LLM round-trip.
 * O_APPEND also makes each record atomic at the OS level, so the design is
 * robust even if two instances ever end up on one path.
 *
 * **Failures stall, they do not vanish (D-46).** A failed write keeps its record
 * at the head of the queue and everything else waits behind it, then raises a
 * fault. Draining past a failure would let record N+1 land referencing a parent
 * that was never written — a dangling tree on load. Callers surface the fault
 * (the session pauses on it) and call `retry()` once the disk problem is fixed.
 */
import fs from "node:fs";
import path from "node:path";

/** A stalled write: what failed, where, and how much is queued behind it. */
export interface AppendFault {
  readonly filePath: string;
  readonly error: Error;
  /** Records waiting to be written, including the one that failed. */
  readonly pending: number;
}

export type FaultListener = (fault: AppendFault) => void;

interface Pending {
  readonly line: string;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

export class AppendLog {
  private static registry = new Map<string, AppendLog>();

  /** One shared instance per file path — the coherence guarantee (D-37). */
  static forPath(filePath: string, options?: { fsync?: boolean }): AppendLog {
    const key = path.resolve(filePath);
    let log = AppendLog.registry.get(key);
    if (!log) {
      log = new AppendLog(key, options);
      AppendLog.registry.set(key, log);
    }
    return log;
  }

  /** Flush every open log (tests / graceful shutdown). */
  static async flushAll(): Promise<void> {
    await Promise.all([...AppendLog.registry.values()].map((l) => l.flush()));
  }

  /** Close every open log (tests). */
  static async closeAll(): Promise<void> {
    await Promise.all([...AppendLog.registry.values()].map((l) => l.close()));
  }

  private readonly filePath: string;
  private readonly fsyncEnabled: boolean;
  private readonly queue: Pending[] = [];
  private draining = false;
  private drainPromise: Promise<void> = Promise.resolve();
  private currentFault: AppendFault | null = null;
  private dirEnsured = false;
  private readonly faultListeners = new Set<FaultListener>();

  constructor(filePath: string, options: { fsync?: boolean } = {}) {
    this.filePath = path.resolve(filePath);
    this.fsyncEnabled = options.fsync ?? true;
  }

  /** The stalled write, if this log is currently faulted (D-46). */
  get fault(): AppendFault | null {
    return this.currentFault;
  }

  /** Subscribe to write failures. Returns an unsubscribe fn. */
  onFault(listener: FaultListener): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  /** Append one record; resolves when it is durably written. While the log is
   *  faulted the returned promise stays pending — the record is queued behind
   *  the stalled one and lands if a later `retry()` succeeds. */
  append(record: unknown): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ line, resolve, reject });
      this.kick();
    });
  }

  /** Start draining unless it is already running or the log is stalled. */
  private kick(): void {
    if (this.draining || this.currentFault) return;
    this.drainPromise = this.drain();
  }

  /** Write queued records one at a time, in order, stopping at the first
   *  failure with the offending record still at the head. */
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const head = this.queue[0]!;
        try {
          await this.write(head.line);
        } catch (err) {
          this.raiseFault(err as Error); // head stays queued; the rest waits behind it
          return;
        }
        this.queue.shift();
        head.resolve();
      }
    } finally {
      this.draining = false;
    }
  }

  private raiseFault(error: Error): void {
    const fault: AppendFault = { filePath: this.filePath, error, pending: this.queue.length };
    this.currentFault = fault;
    for (const listener of this.faultListeners) listener(fault);
  }

  private async write(line: string): Promise<void> {
    if (!this.dirEnsured) {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      this.dirEnsured = true;
    }
    // Scoped fd: disposed at the end of this block, on success or throw (D-46).
    await using handle = await fs.promises.open(this.filePath, "a");
    await handle.write(line);
    if (this.fsyncEnabled) await handle.sync();
  }

  /** Retry a stalled write — the disk-full recovery path (D-46). Resolves once
   *  the backlog drains; rejects (and stays faulted) if it fails again. */
  async retry(): Promise<void> {
    if (!this.currentFault) return;
    this.currentFault = null;
    this.kick();
    await this.drainPromise;
    // Read through the getter: assigning null above narrows `currentFault` itself,
    // but drain() can set it again from inside the await.
    const refaulted = this.fault;
    if (refaulted) throw refaulted.error;
  }

  /** Drop the stalled record and everything queued behind it, accepting the
   *  loss, so the log can keep taking new writes (the explicit "continue
   *  without saving" escape hatch — never silent). */
  discardPending(): number {
    const dropped = this.queue.splice(0, this.queue.length);
    this.currentFault = null;
    const err = new Error(`Discarded ${dropped.length} unwritten record(s) for ${this.filePath}`);
    for (const p of dropped) p.reject(err);
    return dropped.length;
  }

  /** Await all queued writes. Rejects if the log is stalled — a failed write
   *  must never look like a successful flush (that is what made D-46's data
   *  loss silent: the read-your-writes flush resolved anyway). */
  async flush(): Promise<void> {
    await this.drainPromise;
    if (this.currentFault) throw this.currentFault.error;
  }

  /** Release this log. Best-effort: a stalled backlog is reported, not thrown,
   *  so teardown can always complete. */
  async close(): Promise<void> {
    await this.drainPromise.catch(() => {});
    AppendLog.registry.delete(this.filePath);
  }
}
