import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Sandbox } from "../src/tools/sandbox";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-sbx-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Sandbox", () => {
  it("resolves paths inside the fence", () => {
    const sbx = new Sandbox([root]);
    const r = sbx.resolve("sub/file.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.startsWith(fs.realpathSync(root))).toBe(true);
  });

  it("rejects ../ escapes", () => {
    const sbx = new Sandbox([root]);
    expect(sbx.resolve("../outside.txt").ok).toBe(false);
    expect(sbx.resolve("../../etc/passwd").ok).toBe(false);
  });

  it("rejects absolute paths outside the fence", () => {
    const sbx = new Sandbox([root]);
    expect(sbx.resolve("/etc/passwd").ok).toBe(false);
  });

  it("rejects symlink escapes", () => {
    const sbx = new Sandbox([root]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "s3cr3t");
    fs.symlinkSync(outside, path.join(root, "link"));
    try {
      // The path is lexically inside, but realpath lands outside → rejected.
      expect(sbx.resolve("link/secret.txt").ok).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a not-yet-existing file whose parent is inside", () => {
    const sbx = new Sandbox([root]);
    expect(sbx.resolve("new-file.txt").ok).toBe(true);
  });
});
