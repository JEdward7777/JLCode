/**
 * The debug journal (D-15): a separate, append-only, per-conversation record of
 * verbose per-turn detail (raw request summary, result, tool I/O, timings,
 * errors) — the "Halp!! something broke" artifact. It is **never replayed to a
 * model**, so it can hold detail the API-safe transcript must not. Written
 * through the same AppendLog primitive; lives under the data store's logs dir.
 */
import fs from "node:fs";
import path from "node:path";
import type { DebugRecord } from "../session/types.js";
import { AppendLog, type AppendFault, type FaultListener } from "./append-log.js";

export class DebugJournal {
  private readonly logs = new Map<string, AppendLog>();
  private readonly faultListeners = new Set<FaultListener>();

  constructor(private readonly dir: string) {}

  /** Subscribe to journal write failures (D-46). Returns an unsubscribe fn.
   *  The journal is diagnostic, never replayed to a model, so the server treats
   *  a fault here as a warning — it does not pause the session over it. */
  onFault(listener: FaultListener): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  private get stalled(): AppendLog[] {
    return [...this.logs.values()].filter((l) => l.fault !== null);
  }

  get fault(): AppendFault | null {
    return this.stalled[0]?.fault ?? null;
  }

  async retry(): Promise<void> {
    await Promise.all(this.stalled.map((l) => l.retry()));
  }

  discardPending(): number {
    return this.stalled.reduce((n, l) => n + l.discardPending(), 0);
  }

  private file(convId: string): string {
    return path.join(this.dir, `${convId}.journal.jsonl`);
  }

  private log(convId: string): AppendLog {
    let log = this.logs.get(convId);
    if (!log) {
      log = new AppendLog(this.file(convId));
      log.onFault((fault) => {
        for (const listener of this.faultListeners) listener(fault);
      });
      this.logs.set(convId, log);
    }
    return log;
  }

  record(convId: string, rec: DebugRecord): Promise<void> {
    return this.log(convId).append({ ts: new Date().toISOString(), ...rec });
  }

  /** Read a conversation's journal back (tolerant of a torn last line). */
  read(convId: string): Record<string, unknown>[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file(convId), "utf8");
    } catch {
      return [];
    }
    const out: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // tolerate a crash-truncated line
      }
    }
    return out;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.logs.values()].map((l) => l.flush()));
  }

  async close(): Promise<void> {
    await Promise.all([...this.logs.values()].map((l) => l.close()));
    this.logs.clear();
  }
}
