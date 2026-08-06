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
import { AppendLog, type AppendFault, type FaultListener } from "./append-log.js";

export interface ConversationMeta {
  id: string;
  workingDir: string;
  configName?: string;
}

/**
 * Canonicalize a working directory so the history filter can't split one project
 * into two invisible buckets (X-12). `list()` compares stored dirs as exact
 * strings, so a trailing slash, a relative path, or a launch through a symlink
 * files conversations under a directory the next launch won't match. Resolving
 * the symlink is what makes it work for rows written *before* this existed, so
 * this runs on both sides of the compare rather than only at write time.
 *
 * A dir that no longer exists (a deleted project) can't be realpath'd — fall back
 * to the lexical form, which still fixes the trailing-slash and relative cases.
 */
export function normalizeWorkingDir(dir: string, cache?: Map<string, string>): string {
  const cached = cache?.get(dir);
  if (cached !== undefined) return cached;
  let out = path.resolve(dir);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    /* gone or unreadable — the lexical form is the best we can do */
  }
  cache?.set(dir, out);
  return out;
}

export interface IndexRow {
  id: string;
  workingDir: string;
  createdAt: string;
  /** A human label for the thread (X-09). Absent on rows written before titles
   *  existed, and on threads whose first exchange hasn't happened yet. */
  title?: string;
}

export class ConversationStore {
  private readonly logs = new Map<string, AppendLog>();
  private readonly index: AppendLog;
  /** Fault subscribers, applied to every log — including ones opened later (D-46). */
  private readonly faultListeners = new Set<FaultListener>();

  constructor(private readonly dir: string) {
    this.index = this.watch(new AppendLog(path.join(dir, "index.jsonl")));
  }

  /** Route a log's write failures to this store's subscribers (D-46). */
  private watch(log: AppendLog): AppendLog {
    log.onFault((fault) => {
      for (const listener of this.faultListeners) listener(fault);
    });
    return log;
  }

  /** Subscribe to persistence failures anywhere in this store. Returns an
   *  unsubscribe fn. The server turns these into an `awaiting-persistence`
   *  session pause rather than letting the write vanish (D-46). */
  onFault(listener: FaultListener): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  /** Every currently-stalled log (D-46). */
  private get stalled(): AppendLog[] {
    return [this.index, ...this.logs.values()].filter((l) => l.fault !== null);
  }

  /** The first outstanding fault, if any — what the UI banner reports. */
  get fault(): AppendFault | null {
    return this.stalled[0]?.fault ?? null;
  }

  /** Retry every stalled write (the disk-full recovery path, D-46). Rejects if
   *  any of them fails again, leaving those logs stalled. */
  async retry(): Promise<void> {
    await Promise.all(this.stalled.map((l) => l.retry()));
  }

  /** Give up on the stalled records, accepting the loss, so the store can keep
   *  taking writes. Returns how many records were dropped (D-46). */
  discardPending(): number {
    return this.stalled.reduce((n, l) => n + l.discardPending(), 0);
  }

  private file(convId: string): string {
    return path.join(this.dir, `${convId}.jsonl`);
  }

  private log(convId: string): AppendLog {
    let log = this.logs.get(convId);
    if (!log) {
      log = this.watch(new AppendLog(this.file(convId)));
      this.logs.set(convId, log);
    }
    return log;
  }

  /** Start a new conversation log (header + index row). Both appends are issued
   *  before awaiting, so their queue tails are registered synchronously — a
   *  `flush()`/`close()` can never slip into a gap between them (which, with a
   *  fire-and-forget `create()`, would let the index write outlive teardown). */
  async create(meta: ConversationMeta): Promise<void> {
    const createdAt = new Date().toISOString();
    const workingDir = normalizeWorkingDir(meta.workingDir); // canonical on the way in (X-12)
    await Promise.all([
      this.log(meta.id).append({
        kind: "header",
        id: meta.id,
        workingDir,
        configName: meta.configName,
        createdAt,
      }),
      this.index.append({ id: meta.id, workingDir, createdAt }),
    ]);
  }

  /** Persist a newly-appended tree entry. */
  entry(convId: string, entry: Entry): Promise<void> {
    return this.log(convId).append(entry);
  }

  /** Record an active-leaf move (rewind / branch switch). `null` is the point
   *  above the root, where editing the first message forks (H-05). */
  activeLeaf(convId: string, leaf: string | null): Promise<void> {
    return this.log(convId).append({ kind: "activeLeaf", leaf });
  }

  /** Hide a conversation from the history list (X-12b). A **masking flag**, not
   *  a tombstone and never an unlink: the files stay on disk, so `load()` still
   *  reads a masked thread and recovery by id works before any dumpster diving.
   *  Written to the index **only** — `list()` is the only reader — so there is
   *  exactly one file and one flag to flip back by hand when it was an oops.
   *
   *  Masking also sidesteps the trap a hard delete carried: this store and
   *  `DebugJournal` each memoize an `AppendLog` per conversation id, so an
   *  unlink without evicting those handles lets a queued append recreate the
   *  file. */
  setDeleted(convId: string, deleted = true): Promise<void> {
    return this.index.append({ kind: "deleted", id: convId, deleted, ts: new Date().toISOString() });
  }

  /** Name a conversation (X-09). Append-only like everything else: the newest
   *  title record wins, so a rename is just another append and old logs (which
   *  have none) simply stay untitled. Written to the conversation log *and* the
   *  index, so the history list can show labels without opening every file. */
  async title(convId: string, title: string, source: "auto" | "manual" = "auto"): Promise<void> {
    await Promise.all([
      this.log(convId).append({ kind: "title", title, source, ts: new Date().toISOString() }),
      this.index.append({ kind: "title", id: convId, title }),
    ]);
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
    let title: string | undefined;
    // An explicit `activeLeaf` record is *in force* until an append actually
    // continues from it. While it is, a non-matching append is a turn writing to
    // the branch it was pinned to (H-05) and must not drag the pointer over.
    // With no record in force we follow every append — which is also how logs
    // written before H-05 replay, since their edit-fork moved the leaf silently.
    let pinned = false;
    for (const r of records) {
      if (r.kind === "header") header = r;
      else if (r.kind === "activeLeaf") {
        if (r.leaf === null || typeof r.leaf === "string") {
          activeLeaf = r.leaf;
          pinned = true;
        }
      } else if (r.kind === "title") title = typeof r.title === "string" ? r.title : title; // newest wins
      else {
        const entry = r as unknown as Entry;
        entries.push(entry);
        if (typeof entry.id !== "string") continue;
        const follows = (entry.parent ?? null) === activeLeaf;
        if (follows || !pinned) activeLeaf = entry.id; // mirrors appendEntry
        if (follows) pinned = false;
      }
    }
    if (!header || typeof header.id !== "string") return undefined;
    const last = entries[entries.length - 1];
    return {
      id: header.id,
      title,
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
    const titles = new Map<string, string>(); // later title records win (X-09)
    const deleted = new Map<string, boolean>(); // …as do later delete flags (X-12b)
    // Compare canonical dirs, not raw strings (X-12). Rows written before
    // `create()` normalized are the reason this resolves each row rather than
    // only the filter; the cache keeps that to one syscall per distinct dir.
    const dirCache = new Map<string, string>();
    const wanted = workingDir === undefined ? undefined : normalizeWorkingDir(workingDir, dirCache);
    for (const r of ConversationStore.parseLines(text)) {
      if (r.kind === "title") {
        if (typeof r.id === "string" && typeof r.title === "string") titles.set(r.id, r.title);
        continue;
      }
      if (r.kind === "deleted") {
        if (typeof r.id === "string") deleted.set(r.id, r.deleted !== false);
        continue;
      }
      if (typeof r.id !== "string" || typeof r.workingDir !== "string") continue;
      if (wanted !== undefined && normalizeWorkingDir(r.workingDir, dirCache) !== wanted) continue;
      rows.push({
        id: r.id,
        workingDir: r.workingDir,
        createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      });
    }
    for (const row of rows) {
      const title = titles.get(row.id);
      if (title !== undefined) row.title = title;
    }
    return rows.filter((row) => !deleted.get(row.id)).reverse();
  }

  async flush(): Promise<void> {
    await Promise.all([this.index.flush(), ...[...this.logs.values()].map((l) => l.flush())]);
  }

  async close(): Promise<void> {
    await Promise.all([this.index.close(), ...[...this.logs.values()].map((l) => l.close())]);
    this.logs.clear();
  }
}
