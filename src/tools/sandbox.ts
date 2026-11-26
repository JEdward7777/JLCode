/**
 * The workspace fence (D-19) — a **soft** fence: it prevents escaping the
 * allowed roots *without the user's consent*. Out-of-fence access is surfaced
 * (as an `escape`) so the session can ask the user to allow it — once, or by
 * **remembering the root** (e.g. a sibling project). The sandbox supports both:
 * `addRoot` (the "remember this root" choice) and `allowOnce` (one-shot). `..`
 * escapes and symlink escapes are caught by realpath-checking the target.
 *
 * Access is split (D-104, R1 G1): besides the roots, the fence holds
 * **read-only roots** — a conversation's own `processes/<conversation-id>/` —
 * that a read may enter without a prompt and a write may not. Callers say which
 * they are doing; anything unsaid is a write, the strict side.
 */
import fs from "node:fs";
import path from "node:path";

/** What a resolved path will be used for (R1 G1). */
export type Access = "read" | "write";

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
  /** Read-only roots (D-104), kept as given and realpath-resolved per check:
   *  a process directory may not exist yet when it is added, and resolving it
   *  then would miss a symlinked ancestor (macOS's `/var` → `/private/var`).
   *  Separate from `roots`, so `restoreRoots` never touches them (R1 G1). */
  private readonly readOnly: string[] = [];

  constructor(roots: string[]) {
    if (roots.length === 0) throw new Error("Sandbox needs at least one root");
    this.roots = roots.map(safeReal);
  }

  get primary(): string {
    return this.roots[0]!;
  }

  private within(p: string): boolean {
    return this.roots.some((root) => under(p, root)) || this.once.has(p);
  }

  /** Let reads (only) into `dir` without a prompt — a conversation's own
   *  process directory (D-104). Idempotent. */
  addReadOnlyRoot(dir: string): void {
    const abs = path.resolve(dir);
    if (!this.readOnly.includes(abs)) this.readOnly.push(abs);
  }

  /** Is real path `p` inside a read-only root? */
  private withinReadOnly(p: string): boolean {
    return this.readOnly.some((dir) => {
      const real = realTarget(dir);
      return real !== undefined && under(p, real);
    });
  }

  /** Permanently widen the fence (the "remember this root" choice). */
  addRoot(dir: string): void {
    const real = safeReal(dir);
    if (!this.roots.includes(real)) this.roots.push(real);
  }

  /** Put the fence back to a snapshot of `roots` — undoing a widening whose
   *  approval was refused before its call ran (D-99). In place, so anything
   *  holding `roots` keeps seeing the live list. */
  restoreRoots(snapshot: readonly string[]): void {
    this.roots.splice(0, this.roots.length, ...snapshot);
  }

  /** Allow a specific resolved path for the next operation(s), until cleared. */
  allowOnce(realPath: string): void {
    this.once.add(realPath);
  }

  clearOnce(): void {
    this.once.clear();
  }

  /** Resolve a path for `access` (default: write, the strict side). `escape`
   *  means out-of-fence (offer to allow); `invalid` means genuinely
   *  unresolvable. A read-only root admits reads only (D-104). */
  resolve(input: string, access: Access = "write"): Resolved {
    const abs = path.resolve(this.primary, input);
    const real = realTarget(abs);
    if (real === undefined) return { ok: false, kind: "invalid", reason: `cannot resolve path: ${input}` };
    if (this.within(real)) return { ok: true, path: abs };
    if (access === "read" && this.withinReadOnly(real)) return { ok: true, path: abs };
    return { ok: false, kind: "escape", reason: `path is outside the workspace: ${input}`, escapedPath: real };
  }
}

/** Is `p` equal to or inside `root`? (Both real, absolute.) */
export function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** The real target path of an absolute path: its nearest existing ancestor,
 *  realpath'd, plus the remainder. `undefined` if even that can't be resolved. */
export function realTarget(abs: string): string | undefined {
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
