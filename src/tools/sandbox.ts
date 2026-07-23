/**
 * The workspace fence (D-19) — a **soft** fence: it prevents escaping the
 * allowed roots *without the user's consent*. Out-of-fence access is surfaced
 * (as an `escape`) so the session can ask the user to allow it — once, or by
 * **remembering the root** (e.g. a sibling project). The sandbox supports both:
 * `addRoot` (the "remember this root" choice) and `allowOnce` (one-shot). `..`
 * escapes and symlink escapes are caught by realpath-checking the target.
 */
import fs from "node:fs";
import path from "node:path";

export type Resolved =
  | { ok: true; path: string }
  | { ok: false; kind: "escape"; reason: string; escapedPath: string }
  | { ok: false; kind: "invalid"; reason: string };

function safeReal(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export class Sandbox {
  /** Allowed roots, realpath-normalized. The first is the primary workspace. */
  readonly roots: string[];
  /** One-shot allowances (resolved real paths) for allow-once access. */
  private readonly once = new Set<string>();

  constructor(roots: string[]) {
    if (roots.length === 0) throw new Error("Sandbox needs at least one root");
    this.roots = roots.map(safeReal);
  }

  get primary(): string {
    return this.roots[0]!;
  }

  private within(p: string): boolean {
    return this.roots.some((root) => p === root || p.startsWith(root + path.sep)) || this.once.has(p);
  }

  /** Permanently widen the fence (the "remember this root" choice). */
  addRoot(dir: string): void {
    const real = safeReal(dir);
    if (!this.roots.includes(real)) this.roots.push(real);
  }

  /** Allow a specific resolved path for the next operation(s), until cleared. */
  allowOnce(realPath: string): void {
    this.once.add(realPath);
  }

  clearOnce(): void {
    this.once.clear();
  }

  /** The real target path for an input (nearest existing ancestor + remainder). */
  private realOf(input: string): string | undefined {
    const abs = path.resolve(this.primary, input);
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
      return undefined;
    }
    const remainder = path.relative(existing, abs);
    return remainder ? path.join(realExisting, remainder) : realExisting;
  }

  /** Resolve a path. `escape` means out-of-fence (offer to allow); `invalid`
   *  means genuinely unresolvable. */
  resolve(input: string): Resolved {
    const abs = path.resolve(this.primary, input);
    const real = this.realOf(input);
    if (real === undefined) return { ok: false, kind: "invalid", reason: `cannot resolve path: ${input}` };
    if (this.within(real)) return { ok: true, path: abs };
    return { ok: false, kind: "escape", reason: `path is outside the workspace: ${input}`, escapedPath: real };
  }
}
