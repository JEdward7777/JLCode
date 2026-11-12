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
import type { Mode } from "../config/types.js";
import { MODES } from "../config/types.js";
import type { Conversation, Entry, InboundMeta } from "../conversation/types.js";
import { AppendLog, type AppendFault, type FaultListener } from "./append-log.js";

export interface ConversationMeta {
  id: string;
  workingDir: string;
  configName?: string;
}

/**
 * A sub-agent's own row in its tree's file (X-56 Q14, D-88): the whole tree
 * lives in the **root's** JSONL, and this is what says an agent exists there,
 * where it hangs and what it is called. Written once, when it is spawned.
 */
export interface AgentRecord {
  /** The agent id — the suffix of its conversation id (`<root>~<agent>`). */
  agentId: string;
  /** The parent's agent id; `null` when the parent is the root thread. */
  parentAgentId: string | null;
  /** What other agents call it (`agent-3`); unique within the tree. */
  name: string;
  /** Levels below the root (a root's child is 1). */
  depth: number;
  /** The mode it was spawned in when that was stricter than its parent's
   *  (P9d, X-56 Q10) — kept so a revival does not loosen it back to the
   *  parent's — or the one its parent last set with `set_agent_mode` (P9f2),
   *  folded from `agent-mode` control records, newest wins. Absent = it runs
   *  at its parent's mode. A revival still caps it at the parent's mode then. */
  mode?: Mode;
  createdAt: string;
  /** Closed (P9f, X-56 Q18–Q20): unloaded, grey in the rail, out of
   *  `list_agents` unless asked, skipped by Wake. Folded from `agent-closed`
   *  control records, newest wins; a message or a click reopens it. */
  closed?: boolean;
}

/** Joins a root conversation id and an agent id into the agent's own
 *  conversation id. A character `newId` never produces, so the split is exact. */
export const AGENT_ID_SEP = "~";

/** The conversation id a sub-agent's session runs under (D-88). Everything that
 *  addresses a conversation by id — the persistence projection, the journal,
 *  the attachment and file routes — keeps working unchanged, and the store
 *  routes it to the root's file from the id alone, so it holds across a restart
 *  with no lookup table to lose. */
export function agentConversationId(rootId: string, agentId: string): string {
  return `${rootId}${AGENT_ID_SEP}${agentId}`;
}

/** Which file a conversation id lives in, and which agent's subtree within it
 *  (`undefined` = the root thread itself). */
export function splitConversationId(convId: string): { file: string; agent?: string } {
  const at = convId.indexOf(AGENT_ID_SEP);
  return at < 0 ? { file: convId } : { file: convId.slice(0, at), agent: convId.slice(at + 1) };
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
  /** The thread has sub-agents (P9f): history can nest them under it without
   *  opening every file to find out. Marked when an agent is spawned. */
  agents?: boolean;
}

export class ConversationStore {
  private readonly logs = new Map<string, AppendLog>();
  private readonly index: AppendLog;
  /** Fault subscribers, applied to every log — including ones opened later (D-46). */
  private readonly faultListeners = new Set<FaultListener>();
  /** Roots this store has marked in the index as having agents (P9f) — once
   *  per root per process; a repeat would be harmless, only wasteful. */
  private readonly treesMarked = new Set<string>();

  /** Whether every log this store opens fsyncs each record (D-37). Production
   *  always does; logic-only tests turn it off so their run time stops scaling
   *  with disk contention — the records still land in the file, only the
   *  crash-durability guarantee goes. */
  private readonly fsync: boolean;

  constructor(
    private readonly dir: string,
    options: { fsync?: boolean } = {},
  ) {
    this.fsync = options.fsync ?? true;
    this.index = this.watch(new AppendLog(path.join(dir, "index.jsonl"), { fsync: this.fsync }));
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

  /** The file a conversation id is written to — the root's, for a sub-agent
   *  (D-88). Public so the server can tell which session a fault belongs to. */
  filePath(convId: string): string {
    return path.join(this.dir, `${splitConversationId(convId).file}.jsonl`);
  }

  /** One `AppendLog` per **file**, never per agent: every writer in a tree goes
   *  through the same serialized queue (D-37), so interleaved agents can never
   *  tear each other's lines. */
  private log(convId: string): AppendLog {
    const { file } = splitConversationId(convId);
    let log = this.logs.get(file);
    if (!log) {
      log = this.watch(new AppendLog(this.filePath(file), { fsync: this.fsync }));
      this.logs.set(file, log);
    }
    return log;
  }

  /** Stamp a control or entry record with the agent it belongs to, when it
   *  belongs to one. The root's records carry nothing, which is also exactly
   *  what every log written before sub-agents looks like. */
  private static tag<T extends object>(convId: string, record: T): T & { agent?: string } {
    const { agent } = splitConversationId(convId);
    return agent === undefined ? record : { ...record, agent };
  }

  /** Record a sub-agent in its tree's file (D-88). No index row: history lists
   *  root threads, and an agent is reached through its root. */
  agent(rootId: string, record: AgentRecord): Promise<void> {
    const written = this.log(rootId).append({ kind: "agent", ...record });
    if (this.treesMarked.has(rootId)) return written;
    this.treesMarked.add(rootId);
    // The index learns the root has a tree, so history can nest it (P9f).
    return Promise.all([written, this.index.append({ kind: "tree", id: rootId })]).then(() => {});
  }

  /** Close or reopen a sub-agent (P9f, X-56 Q18–Q20) — a control record in its
   *  tree's file, untagged like the `agent` row it amends; newest wins. */
  agentClosed(rootId: string, agentId: string, closed: boolean): Promise<void> {
    return this.log(rootId).append({ kind: "agent-closed", agentId, closed, ts: new Date().toISOString() });
  }

  /** A parent changed a sub-agent's mode (P9f2, X-58) — a control record in
   *  its tree's file, untagged like `agent-closed`; newest wins. */
  agentMode(rootId: string, agentId: string, mode: Mode): Promise<void> {
    return this.log(rootId).append({ kind: "agent-mode", agentId, mode, ts: new Date().toISOString() });
  }

  /** Every agent ever spawned in a tree, in spawn order. */
  agents(rootId: string): AgentRecord[] {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath(rootId), "utf8");
    } catch {
      return [];
    }
    const out: AgentRecord[] = [];
    const closed = new Map<string, boolean>();
    const modes = new Map<string, Mode>();
    const isMode = (m: unknown): m is Mode => typeof m === "string" && (MODES as readonly string[]).includes(m);
    for (const r of ConversationStore.parseLines(text)) {
      if (r.kind === "agent-closed") {
        if (typeof r.agentId === "string") closed.set(r.agentId, r.closed === true);
        continue;
      }
      if (r.kind === "agent-mode") {
        if (typeof r.agentId === "string" && isMode(r.mode)) modes.set(r.agentId, r.mode);
        continue;
      }
      if (r.kind !== "agent" || typeof r.agentId !== "string" || typeof r.name !== "string") continue;
      out.push({
        agentId: r.agentId,
        parentAgentId: typeof r.parentAgentId === "string" ? r.parentAgentId : null,
        name: r.name,
        depth: typeof r.depth === "number" ? r.depth : 1,
        ...(isMode(r.mode) ? { mode: r.mode } : {}),
        createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      });
    }
    for (const rec of out) {
      if (closed.get(rec.agentId)) rec.closed = true;
      const mode = modes.get(rec.agentId);
      if (mode) rec.mode = mode;
    }
    return out;
  }

  /** An agent message was **sent** to this conversation (D-88, X-56 Q15) —
   *  written now, before the receiver has taken it into its transcript, so a
   *  message owed a reply survives a crash. Delivery is the user entry carrying
   *  the same `inbound.id`; load pairs the two. */
  inbox(convId: string, message: InboundMeta & { text: string }): Promise<void> {
    const record = {
      kind: "inbox",
      id: message.id,
      from: message.from,
      // `kind` names the record; the message's own kind rides beside it.
      msgKind: message.kind,
      text: message.text,
      ts: new Date().toISOString(),
    };
    return this.log(convId).append(ConversationStore.tag(convId, record));
  }

  /** Inbox messages that will never be delivered — a hard Stop emptied the
   *  queue, or the person cancelled them — so load stops calling them pending. */
  inboxDropped(convId: string, ids: string[]): Promise<void> {
    return this.log(convId).append(ConversationStore.tag(convId, { kind: "inbox-drop", ids }));
  }

  /** "Continue, don't ask again in this thread" (P9d, D-89): the tool-round
   *  pause is off here and in this thread's sub-agents from now on. A control
   *  record, not a tree entry — it belongs to the thread, not to a branch, and
   *  carries nothing a model reads. */
  roundsOff(convId: string): Promise<void> {
    return this.log(convId).append(ConversationStore.tag(convId, { kind: "rounds-off", ts: new Date().toISOString() }));
  }

  /** Does a conversation's file still have records queued for disk? A read
   *  of it now would miss them (P9f: reopening an agent just closed). */
  writesPending(convId: string): boolean {
    return (this.logs.get(splitConversationId(convId).file)?.pending ?? 0) > 0;
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
    return this.log(convId).append(ConversationStore.tag(convId, entry));
  }

  /** Record an active-leaf move (rewind / branch switch). `null` is the point
   *  above the root, where editing the first message forks (H-05). */
  activeLeaf(convId: string, leaf: string | null): Promise<void> {
    return this.log(convId).append(ConversationStore.tag(convId, { kind: "activeLeaf", leaf }));
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
    // A sub-agent's name lives in its tree's file only — the index lists roots.
    if (splitConversationId(convId).agent !== undefined) {
      await this.log(convId).append(ConversationStore.tag(convId, { kind: "title", title, source, ts: new Date().toISOString() }));
      return;
    }
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

  /** Fold a conversation's log back into an in-memory tree — for a sub-agent's
   *  id, only **its** records out of its tree's file (D-88). Each agent has its
   *  own root entry, its own `activeLeaf` records and its own forks; entries
   *  find each other by `parent` pointer, so how the writers interleaved on
   *  disk does not matter. */
  load(convId: string): Conversation | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath(convId), "utf8");
    } catch {
      return undefined;
    }
    const want = splitConversationId(convId).agent;
    const all = ConversationStore.parseLines(text);
    // An agent's id must name an agent this file actually records; a typo is
    // "no such conversation", not an empty one.
    const agentRow = want === undefined ? undefined : all.find((r) => r.kind === "agent" && r.agentId === want);
    if (want !== undefined && !agentRow) return undefined;
    const header = all.find((r) => r.kind === "header");
    const records = all.filter(
      (r) =>
        r.kind !== "header" &&
        r.kind !== "agent" &&
        r.kind !== "agent-closed" &&
        r.kind !== "agent-mode" &&
        (typeof r.agent === "string" ? r.agent : undefined) === want,
    );
    const inbox = new Map<string, InboundMeta & { text: string }>();
    const delivered = new Set<string>();
    const entries: Entry[] = [];
    let activeLeaf: string | null = null;
    let title: string | undefined;
    /** Newest title record wins, and its `source` rides with it (X-17): a
     *  hand-rename must still read as hand-picked after a restart, or the
     *  drift re-title would quietly undo it. */
    let titleSource: "auto" | "manual" | undefined;
    let roundsOff = false;
    // An explicit `activeLeaf` record is *in force* until an append actually
    // continues from it. While it is, a non-matching append is a turn writing to
    // the branch it was pinned to (H-05) and must not drag the pointer over.
    // With no record in force we follow every append — which is also how logs
    // written before H-05 replay, since their edit-fork moved the leaf silently.
    let pinned = false;
    for (const r of records) {
      if (r.kind === "inbox") {
        if (typeof r.id === "string" && typeof r.from === "string" && typeof r.text === "string") {
          const kind =
            r.msgKind === "task" || r.msgKind === "finished" || r.msgKind === "question" ? r.msgKind : "message";
          inbox.set(r.id, { id: r.id, from: r.from, kind, text: r.text });
        }
      } else if (r.kind === "inbox-drop") {
        if (Array.isArray(r.ids)) for (const id of r.ids) if (typeof id === "string") delivered.add(id);
      } else if (r.kind === "rounds-off") {
        roundsOff = true;
      } else if (r.kind === "activeLeaf") {
        if (r.leaf === null || typeof r.leaf === "string") {
          activeLeaf = r.leaf;
          pinned = true;
        }
      } else if (r.kind === "title") {
        if (typeof r.title === "string") {
          title = r.title; // newest wins
          titleSource = r.source === "manual" ? "manual" : "auto";
        }
      } else {
        const { agent: _agent, ...rest } = r;
        const entry = rest as unknown as Entry;
        entries.push(entry);
        if (entry.type === "user" && entry.inbound) delivered.add(entry.inbound.id);
        if (typeof entry.id !== "string") continue;
        const follows = (entry.parent ?? null) === activeLeaf;
        if (follows || !pinned) activeLeaf = entry.id; // mirrors appendEntry
        if (follows) pinned = false;
      }
    }
    if (!header || typeof header.id !== "string") return undefined;
    const last = entries[entries.length - 1];
    const pending = [...inbox.values()].filter((m) => !delivered.has(m.id));
    // A sub-agent's name is its title unless someone renamed it since.
    if (title === undefined && agentRow && typeof agentRow.name === "string") {
      title = agentRow.name;
      titleSource = "manual";
    }
    return {
      id: want === undefined ? header.id : convId,
      title,
      titleSource,
      ...(pending.length > 0 ? { inbox: pending } : {}),
      ...(roundsOff ? { roundsOff: true } : {}),
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
    const trees = new Set<string>(); // roots with sub-agents (P9f)
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
      if (r.kind === "tree") {
        if (typeof r.id === "string") trees.add(r.id);
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
      if (trees.has(row.id)) row.agents = true;
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
