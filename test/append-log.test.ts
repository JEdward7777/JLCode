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
