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
import { AppendLog } from "./append-log.js";

export class DebugJournal {
  private readonly logs = new Map<string, AppendLog>();

  constructor(private readonly dir: string) {}

  private file(convId: string): string {
    return path.join(this.dir, `${convId}.journal.jsonl`);
  }

  private log(convId: string): AppendLog {
    let log = this.logs.get(convId);
    if (!log) {
      log = new AppendLog(this.file(convId));
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
