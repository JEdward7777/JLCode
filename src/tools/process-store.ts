/**
 * Where process output lives on disk, and who may delete it (D-104, R1 G2).
 *
 * Layout: `<data dir>/processes/<conversation-id>/<process-id>/{combined,stdout,stderr}.log`,
 * never in the project. A sub-agent's conversation id is `root~agent`, so each
 * thread has its own directory, matching D-104's ownership rule.
 *
 * One `ProcessStore` per server (built in `runServe`, handed to every Session
 * through the factory). It owns three things:
 *
 *   - **The set of conversation directories it owns** — leased by a Session's
 *     task registry on its first task, released on dispose.
 *   - **One heartbeat per conversation directory** (D-105e), written when the
 *     directory is leased and touched every minute by one unref'd timer. Several
 *     servers in different folders may share one data dir; the heartbeat is how
 *     one server knows another's output is live. Timestamps only — no PIDs — so
 *     it behaves the same on every OS.
 *   - **The startup sweep**: before the server listens it deletes the process
 *     directories of every conversation whose heartbeat is older than 10
 *     minutes, and nothing else. A directory with no heartbeat (a server that
 *     died between `mkdir` and the write) counts as live while the directory's
 *     own mtime is under 10 minutes.
 *
 * A server restart or crash kills nothing (D-104): orphans are the person's to
 * reap. Only their *files* are swept.
 */
import fs from "node:fs";
import path from "node:path";

/** The heartbeat's file name inside `processes/<conversation-id>/`. */
export const HEARTBEAT_FILE = ".heartbeat";
/** How often an owned directory's heartbeat is touched. */
export const HEARTBEAT_MS = 60_000;
/** A heartbeat older than this belongs to a server that is gone. */
export const STALE_MS = 10 * 60_000;

/** A conversation's process directory, held by one task registry. */
export interface ProcessDirLease {
  /** `processes/<conversation-id>/` (or a private temp dir, R1 G3). */
  readonly path: string;
  /** Give the directory up: stop its heartbeat, then remove it if empty.
   *  The registry has already removed its own process directories. Never throws. */
  release(): void;
}

export interface ProcessStoreOptions {
  heartbeatMs?: number;
  staleMs?: number;
  /** Injectable clock for the sweep's tests. */
  now?: () => number;
}

export class ProcessStore {
  /** Owned conversation directories → how many leases hold each. Two can: a
   *  thread reopened while its unloaded predecessor is still disposing. */
  private readonly owned = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(
    /** `processes/` under the data dir (`JlcodePaths.processesDir`). */
    readonly base: string,
    options: ProcessStoreOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.staleMs = options.staleMs ?? STALE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Where a conversation's process directory is, whether or not it exists yet. */
  dirFor(conversationId: string): string {
    return path.join(this.base, conversationId);
  }

  /** Is `dir` one of the directories this store currently owns? */
  owns(dir: string): boolean {
    return this.owned.has(dir);
  }

  /**
   * Take a conversation's directory: create it, write its heartbeat at once (so
   * a concurrent sweep by another server sees it live from the first moment),
   * and keep touching it. Throws if the directory can't be made — the caller
   * reports that as the task failing to start.
   */
  lease(conversationId: string): ProcessDirLease {
    const dir = this.dirFor(conversationId);
    fs.mkdirSync(dir, { recursive: true });
    this.touch(dir);
    this.owned.set(dir, (this.owned.get(dir) ?? 0) + 1);
    this.ensureTimer();
    let released = false;
    return {
      path: dir,
      release: () => {
        if (released) return;
        released = true;
        this.release(dir);
      },
    };
  }

  private release(dir: string): void {
    const n = (this.owned.get(dir) ?? 1) - 1;
    if (n > 0) {
      this.owned.set(dir, n);
      return;
    }
    // Last holder: the heartbeat goes first, then the directory, if nothing else
    // is in it (R2 nit). Files someone else put there are not ours to delete.
    this.owned.delete(dir);
    try {
      fs.rmSync(path.join(dir, HEARTBEAT_FILE), { force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      /* not empty, or already gone */
    }
    if (this.owned.size === 0) this.stop();
  }

  private touch(dir: string): void {
    try {
      fs.writeFileSync(path.join(dir, HEARTBEAT_FILE), String(this.now()));
    } catch {
      /* a missed beat is harmless; ten in a row is what the sweep needs */
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const dir of this.owned.keys()) this.touch(dir);
    }, this.heartbeatMs);
    // A heartbeat must never be what keeps the server process alive.
    this.timer.unref?.();
  }

  /** Stop the heartbeat timer (the last lease went, or a test is done). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The conversation directory's last sign of life: its heartbeat's mtime, or,
   *  with no heartbeat, the directory's own (R1 G2). Undefined if it is gone. */
  private lastBeat(dir: string): number | undefined {
    try {
      return fs.statSync(path.join(dir, HEARTBEAT_FILE)).mtimeMs;
    } catch {
      try {
        return fs.statSync(dir).mtimeMs;
      } catch {
        return undefined;
      }
    }
  }

  /** Fresh — or gone, which is nothing to sweep either. */
  private isFresh(dir: string, now: number): boolean {
    const beat = this.lastBeat(dir);
    return beat === undefined || now - beat <= this.staleMs;
  }

  /**
   * The startup sweep (D-104): remove the process directories of every
   * conversation whose heartbeat is stale, then the conversation directory
   * itself if that emptied it. Directories this store owns are never touched.
   * Returns the conversation directories it swept. Never throws.
   */
  sweep(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.base, { withFileTypes: true });
    } catch {
      return []; // no processes/ yet: nothing to sweep
    }
    const swept: string[] = [];
    const now = this.now();
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.base, e.name);
      if (this.owned.has(dir)) continue;
      if (this.isFresh(dir, now)) continue;
      // Process directories only — "and nothing else" (D-104).
      let children: fs.Dirent[] = [];
      try {
        children = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      // Look again right before deleting (review R1): a peer that came back to
      // life — or a lease taken — since the first look has beaten by now, and
      // its output must survive. Re-read the clock too, for the same reason.
      if (this.owned.has(dir) || this.isFresh(dir, this.now())) continue;
      for (const c of children) {
        if (!c.isDirectory()) continue;
        try {
          fs.rmSync(path.join(dir, c.name), { recursive: true, force: true });
        } catch {
          /* held open on Windows, say — the next start tries again */
        }
      }
      try {
        fs.rmSync(path.join(dir, HEARTBEAT_FILE), { force: true });
      } catch {
        /* best effort */
      }
      try {
        fs.rmdirSync(dir);
      } catch {
        /* something that isn't ours is still in it */
      }
      swept.push(dir);
    }
    return swept;
  }
}
