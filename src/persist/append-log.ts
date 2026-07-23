/**
 * AppendLog (D-37) — the persistence primitive. Append-only, coherence via a
 * **single serialized async queue per file** (NOT OS file locks): every
 * `append()` chains off the previous write, so records never interleave even
 * when multiple agent loops append to the same file. `append()` resolves when
 * that record is durably written (fsync on by default — records are coarse,
 * finalized units, not token deltas). A `forPath` registry hands back one
 * instance per path so all appenders truly share the same queue.
 */
import fs from "node:fs";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

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
  private tail: Promise<void> = Promise.resolve();
  private handle: FileHandle | undefined;

  constructor(filePath: string, options: { fsync?: boolean } = {}) {
    this.filePath = path.resolve(filePath);
    this.fsyncEnabled = options.fsync ?? true;
  }

  /** Append one record; resolves when it is durably written. */
  append(record: unknown): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    const done = this.tail.then(() => this.write(line));
    this.tail = done.catch(() => {}); // keep the queue alive if one write fails
    return done;
  }

  private async write(line: string): Promise<void> {
    if (!this.handle) {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      this.handle = await fs.promises.open(this.filePath, "a");
    }
    await this.handle.write(line);
    if (this.fsyncEnabled) await this.handle.sync();
  }

  /** Await all queued writes (without closing). */
  async flush(): Promise<void> {
    await this.tail;
  }

  async close(): Promise<void> {
    await this.tail;
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
    AppendLog.registry.delete(this.filePath);
  }
}
