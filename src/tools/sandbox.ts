/**
 * The workspace fence (D-19): the single place every file path is validated
 * before any tool touches disk. Paths resolve against the primary root, `..`
 * escapes are blocked, and symlink escapes are caught by realpath-checking the
 * target (or its parent, for not-yet-existing files). Out-of-fence access is
 * rejected here; the allow-once / allow-and-remember prompt is layered on in
 * Phase 3b via the approval gate.
 */
import fs from "node:fs";
import path from "node:path";

export type Resolved = { ok: true; path: string } | { ok: false; reason: string };

export class Sandbox {
  /** Allowed roots, realpath-normalized. The first is the primary workspace. */
  readonly roots: string[];

  constructor(roots: string[]) {
    if (roots.length === 0) throw new Error("Sandbox needs at least one root");
    this.roots = roots.map((r) => {
      try {
        return fs.realpathSync(path.resolve(r));
      } catch {
        return path.resolve(r);
      }
    });
  }

  get primary(): string {
    return this.roots[0]!;
  }

  private within(p: string): boolean {
    return this.roots.some((root) => p === root || p.startsWith(root + path.sep));
  }

  /** Resolve a tool-supplied path to an absolute path inside the fence. */
  resolve(input: string): Resolved {
    const abs = path.resolve(this.primary, input);
    if (!this.within(abs)) return { ok: false, reason: `path escapes the workspace: ${input}` };

    // Anchor on the nearest existing ancestor (the target may not exist yet).
    let existing = abs;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    let realExisting: string;
    try {
      realExisting = fs.realpathSync(existing);
    } catch {
      return { ok: false, reason: `cannot resolve path: ${input}` };
    }
    const remainder = path.relative(existing, abs);
    const real = remainder ? path.join(realExisting, remainder) : realExisting;
    if (!this.within(real)) return { ok: false, reason: `path escapes the workspace via symlink: ${input}` };
    return { ok: true, path: abs };
  }
}
