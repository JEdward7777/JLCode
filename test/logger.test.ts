import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createLogger } from "../src/logger";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "jlcode-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("createLogger", () => {
  it("writes structured JSONL with the message and fields", () => {
    const log = createLogger({ dir, level: "debug", mirror: false });
    log.info("hello", { a: 1 });
    const [entry] = readLines(log.file) as Array<Record<string, unknown>>;
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello");
    expect(entry.a).toBe(1);
    expect(typeof entry.ts).toBe("string");
  });

  it("expands Error fields into name/message/stack", () => {
    const log = createLogger({ dir, level: "debug", mirror: false });
    log.error("boom", { err: new Error("kaboom") });
    const [entry] = readLines(log.file) as Array<Record<string, any>>;
    expect(entry.err.name).toBe("Error");
    expect(entry.err.message).toBe("kaboom");
    expect(String(entry.err.stack)).toContain("kaboom");
  });

  it("respects the minimum level", () => {
    const log = createLogger({ dir, level: "warn", mirror: false });
    log.debug("skipped");
    log.info("skipped");
    log.warn("kept");
    const lines = readLines(log.file) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toBe("kept");
  });

  it("rotates when the file would exceed maxBytes", () => {
    const log = createLogger({ dir, level: "debug", mirror: false, maxBytes: 200, backups: 2 });
    for (let i = 0; i < 20; i++) log.info("line", { i, pad: "x".repeat(40) });
    expect(existsSync(`${log.file}.1`)).toBe(true);
  });
});
