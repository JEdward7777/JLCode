import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AppendLog } from "../src/persist/append-log";

// FLAKE HISTORY (2026-07-23): this suite failed once — 1 of 83 — during a commit
// run (all other runs green). Suspected cause: AppendLog instances created
// directly here (not via the forPath registry) were never closed by closeAll(),
// leaking file descriptors across tests; under load that likely tripped a
// descriptor limit. FIX (hoped-for): track every log opened here and close it in
// afterEach (below). 6/6 clean runs afterward. If this suite flakes AGAIN, the
// fd-leak theory was WRONG — look instead at fsync latency or a real
// write-ordering race in AppendLog, not test isolation.
// 2026-07-24 (P6a): one unidentified test failed once during a `build && test`
// run (1 of 166; the retry was green) — the failing test name was NOT captured,
// so it is UNCONFIRMED whether it was this suite. append-log was then stress-run
// ~12x under concurrent build-load with no reproduction. So: no confirmed
// recurrence here; the escalation above still stands only if append-log is the
// suite that fails next time (capture the test name before concluding).
// 2026-07-24 (P6c): CONFIRMED and ROOT-CAUSED. The "concurrent appends" case below
// reproduced reliably once P6c added test files (more parallel suites → more fsync
// contention): it does 50 *serialized durable fsyncs* and already takes ~4.4s in
// isolation, right at Vitest's 5s default; under full-suite load it crossed it and
// timed out. So the earlier fd-leak theory was the wrong lens — the flake is
// **fsync latency** on a legitimately IO-heavy test, not a hang, a write-ordering
// race, or a descriptor leak (the ordering assertion still completes correctly).
// Fix: a realistic timeout for this one durable-IO test (it is not a perf
// assertion). The H-01 fd-bounding work is still worth doing, but it is NOT what
// makes this test flake.
let dir: string;
const opened: AppendLog[] = [];
/** Create a log and track it so afterEach closes its fd (no leaks under load). */
function mk(file: string): AppendLog {
  const log = new AppendLog(file);
  opened.push(log);
  return log;
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-alog-"));
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((l) => l.close()));
  await AppendLog.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function read(file: string): unknown[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("AppendLog", () => {
  it("appends records as JSONL and resolves when durable", async () => {
    const file = path.join(dir, "a.jsonl");
    const log = mk(file);
    await log.append({ n: 1 });
    await log.append({ n: 2 });
    await log.flush();
    expect(read(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  // 50 serialized durable fsyncs is legitimately slow (~4.4s isolated) and slower
  // under full-suite fsync contention, so this one gets a realistic timeout — it
  // asserts ordering, not speed (see the fsync-latency note at the top).
  it("serializes concurrent appends in enqueue order (no interleave)", { timeout: 30_000 }, async () => {
    const file = path.join(dir, "b.jsonl");
    const log = mk(file);
    // Fire many appends without awaiting each — the queue must keep order.
    const proms = [];
    for (let i = 0; i < 50; i++) proms.push(log.append({ i }));
    await Promise.all(proms);
    await log.flush();
    const got = read(file) as Array<{ i: number }>;
    expect(got.map((r) => r.i)).toEqual([...Array(50).keys()]);
  });

  it("forPath returns one shared instance per path", () => {
    const file = path.join(dir, "c.jsonl");
    expect(AppendLog.forPath(file)).toBe(AppendLog.forPath(file));
  });

  it("a crash-truncated last line is recoverable by a tolerant parse", async () => {
    const file = path.join(dir, "d.jsonl");
    const log = mk(file);
    await log.append({ ok: true });
    await log.flush();
    fs.appendFileSync(file, '{"partial": '); // simulate a torn write
    const good = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    expect(good).toEqual([{ ok: true }]); // the good record survives; torn line dropped
  });
});

// ---- Write failures stall, they do not vanish (D-46, closes H-01) ----
//
// The failure is injected for real (a read-only directory → EACCES on open)
// rather than by mocking fs, so these exercise the actual recovery path: the
// disk problem is fixed and the stalled records land. Skipped as root, which
// bypasses the permission bits that make the injection work.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const describeFaults = asRoot ? describe.skip : describe;

describeFaults("AppendLog write failures (D-46)", () => {
  /** Make `dir` unwritable so the next open("a") fails, and hand back the undo.
   *  This works here only because each case writes to a log that does **not yet
   *  exist**: a read-only directory blocks *creating* an entry, not appending to
   *  one already created. To jam an existing log (as `persistence-fault.test.ts`
   *  does), chmod the file itself. */
  function jamDisk(): () => void {
    fs.chmodSync(dir, 0o500);
    return () => fs.chmodSync(dir, 0o700);
  }

  /** True if `p` is still pending after a tick — a stalled write must not settle. */
  async function isPending(p: Promise<unknown>): Promise<boolean> {
    const marker = Symbol("pending");
    p.catch(() => {}); // don't trip unhandled-rejection on the discard path
    return (await Promise.race([p, Promise.resolve(marker)])) === marker;
  }

  it("raises a fault instead of swallowing the error", async () => {
    const log = mk(path.join(dir, "fault.jsonl"));
    const seen: string[] = [];
    log.onFault((f) => seen.push(f.error.message));
    const undo = jamDisk();
    try {
      const write = log.append({ n: 1 });
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toHaveLength(1);
      expect(log.fault).not.toBeNull();
      expect(log.fault?.pending).toBe(1);
      // The record is still queued, so its promise has NOT resolved (and has not
      // rejected either — it is waiting for a retry).
      expect(await isPending(write)).toBe(true);
    } finally {
      undo();
    }
  });

  it("flush() rejects while stalled instead of resolving green (the H-01 bug)", async () => {
    const log = mk(path.join(dir, "flush.jsonl"));
    const undo = jamDisk();
    try {
      void log.append({ n: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      await expect(log.flush()).rejects.toThrow();
    } finally {
      undo();
    }
  });

  it("stalls later appends behind the failed one and preserves order on retry", async () => {
    const file = path.join(dir, "order.jsonl");
    const log = mk(file);
    const undo = jamDisk();
    const writes = [log.append({ n: 1 }), log.append({ n: 2 }), log.append({ n: 3 })];
    for (const w of writes) w.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(log.fault?.pending).toBe(3); // all three waiting, none written
    expect(fs.existsSync(file)).toBe(false);

    undo(); // the "user freed up disk space" moment
    await log.retry();
    await Promise.all(writes);
    expect(log.fault).toBeNull();
    // Order preserved — this is why a failure stalls rather than draining past:
    // record 2 must never land before record 1 (its tree parent).
    expect(read(file)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("a retry that fails again leaves the log stalled", async () => {
    const log = mk(path.join(dir, "again.jsonl"));
    const undo = jamDisk();
    try {
      void log.append({ n: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      await expect(log.retry()).rejects.toThrow(); // still unwritable
      expect(log.fault).not.toBeNull();
    } finally {
      undo();
    }
    await log.retry(); // now it works
    expect(log.fault).toBeNull();
  });

  it("discardPending drops the backlog and rejects its promises", async () => {
    const log = mk(path.join(dir, "discard.jsonl"));
    const undo = jamDisk();
    const write = log.append({ n: 1 });
    await new Promise((r) => setTimeout(r, 50));
    const dropped = log.discardPending();
    undo();
    expect(dropped).toBe(1);
    expect(log.fault).toBeNull();
    await expect(write).rejects.toThrow(/Discarded/);
    // The log still works afterward — discarding recovers, it doesn't wedge.
    await log.append({ n: 2 });
    expect(read(path.join(dir, "discard.jsonl"))).toEqual([{ n: 2 }]);
  });
});

// ---- Descriptors are not retained between writes (D-46, closes H-01) ----
describe("AppendLog descriptor use", () => {
  const canCountFds = process.platform === "linux" && fs.existsSync("/proc/self/fd");
  const itFds = canCountFds ? it : it.skip;

  itFds("does not accumulate open descriptors across many logs", async () => {
    const before = fs.readdirSync("/proc/self/fd").length;
    // The H-01 shape: one log per conversation, none ever closed.
    for (let i = 0; i < 60; i++) {
      const log = mk(path.join(dir, `conv-${i}.jsonl`));
      await log.append({ i });
    }
    const after = fs.readdirSync("/proc/self/fd").length;
    // Previously each live log held its own fd (~60 more); now none are retained.
    expect(after - before).toBeLessThan(10);
  }, 30_000);
});
