/**
 * Persists conversations as append-only JSONL logs (D-13/D-37), one file per
 * conversation under an **injectable** directory (so tests point it at a temp
 * dir and inspect it — no polluting real history). Each file: a header line,
 * then entry records (the tree nodes) and optional `activeLeaf` control records.
 * Load folds the log back into the in-memory tree — structure comes from
 * `parent` pointers, so append/interleave order doesn't matter. A tolerant read
 * drops any unparsable (crash-truncated) line.
 */
import fs from "node:fs";
import path from "node:path";
import type { Conversation, Entry } from "../conversation/types.js";
import { AppendLog } from "./append-log.js";

export interface ConversationMeta {
  id: string;
  workingDir: string;
  configName?: string;
}

export interface IndexRow {
  id: string;
  workingDir: string;
  createdAt: string;
}

export class ConversationStore {
  private readonly logs = new Map<string, AppendLog>();
  private readonly index: AppendLog;

  constructor(private readonly dir: string) {
    this.index = new AppendLog(path.join(dir, "index.jsonl"));
  }

  private file(convId: string): string {
    return path.join(this.dir, `${convId}.jsonl`);
  }

  private log(convId: string): AppendLog {
    let log = this.logs.get(convId);
    if (!log) {
      log = new AppendLog(this.file(convId));
      this.logs.set(convId, log);
    }
    return log;
  }

  /** Start a new conversation log (header + index row). */
  async create(meta: ConversationMeta): Promise<void> {
    const createdAt = new Date().toISOString();
    await this.log(meta.id).append({
      kind: "header",
      id: meta.id,
      workingDir: meta.workingDir,
      configName: meta.configName,
      createdAt,
    });
    await this.index.append({ id: meta.id, workingDir: meta.workingDir, createdAt });
  }

  /** Persist a newly-appended tree entry. */
  entry(convId: string, entry: Entry): Promise<void> {
    return this.log(convId).append(entry);
  }

  /** Record an active-leaf move (rewind / branch switch). */
  activeLeaf(convId: string, leaf: string): Promise<void> {
    return this.log(convId).append({ kind: "activeLeaf", leaf });
  }

  private static parseLines(text: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // tolerate a crash-truncated / corrupt line
      }
    }
    return out;
  }

  /** Fold a conversation's log back into an in-memory tree. */
  load(convId: string): Conversation | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.file(convId), "utf8");
    } catch {
      return undefined;
    }
    const records = ConversationStore.parseLines(text);
    let header: Record<string, unknown> | undefined;
    const entries: Entry[] = [];
    let activeLeaf: string | null = null;
    for (const r of records) {
      if (r.kind === "header") header = r;
      else if (r.kind === "activeLeaf") activeLeaf = typeof r.leaf === "string" ? r.leaf : activeLeaf;
      else {
        entries.push(r as unknown as Entry);
        if (typeof r.id === "string") activeLeaf = r.id; // mirrors appendEntry
      }
    }
    if (!header || typeof header.id !== "string") return undefined;
    const last = entries[entries.length - 1];
    return {
      id: header.id,
      entries,
      activeLeaf,
      createdAt: typeof header.createdAt === "string" ? header.createdAt : new Date().toISOString(),
      updatedAt: last ? last.ts : (typeof header.createdAt === "string" ? header.createdAt : new Date().toISOString()),
    };
  }

  /** History list, newest first, optionally filtered to a working dir (D-09). */
  list(workingDir?: string): IndexRow[] {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.dir, "index.jsonl"), "utf8");
    } catch {
      return [];
    }
    const rows: IndexRow[] = [];
    for (const r of ConversationStore.parseLines(text)) {
      if (typeof r.id !== "string" || typeof r.workingDir !== "string") continue;
      if (workingDir !== undefined && r.workingDir !== workingDir) continue;
      rows.push({
        id: r.id,
        workingDir: r.workingDir,
        createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      });
    }
    return rows.reverse();
  }

  async flush(): Promise<void> {
    await Promise.all([this.index.flush(), ...[...this.logs.values()].map((l) => l.flush())]);
  }

  async close(): Promise<void> {
    await Promise.all([this.index.close(), ...[...this.logs.values()].map((l) => l.close())]);
    this.logs.clear();
  }
}
