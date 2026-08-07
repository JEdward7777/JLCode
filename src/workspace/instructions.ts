/**
 * X-15 — the workspace's own agent-instruction file, read into the system prompt.
 *
 * A project ships `AGENTS.md` (or `CLAUDE.md`, or a KiloCode/Cline/Cursor rules
 * file) saying how work is done in it. Until now JLCode read **nothing** from the
 * workspace: the system prompt was `BASE_SYSTEM` plus a per-*config* addendum, so
 * a repo's harness could not auto-integrate — including this repo's own.
 *
 * Two properties shape everything here, and both come from the *other* half of
 * the seam X-25 built (D-64):
 *
 *  - **This is the static half.** Anything that varies per turn is an
 *    `EnvSection` on the user turn (`src/conversation/wire.ts`); anything static
 *    for the whole conversation goes in the system message. That is exactly
 *    KiloCode's `staticEnvLines` / `environmentDetails` split.
 *  - **Read once, at session construction — never per turn.** The system message
 *    is the stable prompt-cache prefix (D-26 puts a breakpoint after system +
 *    tools). Re-reading the file into a re-rendered system message every turn
 *    would invalidate the whole cached prefix every turn — the exact defect D-58
 *    fixed at a measured **12.3x**. So the read happens once, the text is frozen
 *    for the life of the session, and an edit (including one the agent makes with
 *    its own tools) applies to the *next* session. That matches D-50, which
 *    already declines to hot-reload config into a running session.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Filenames tried, in precedence order, **first hit wins** (X-15a).
 *
 * `AGENTS.md` is the emerging cross-tool convention and is the primary.
 * `CLAUDE.md` is honored because it is what most repos that have thought about
 * this already have on disk (this one included). The three dotfiles are the
 * KiloCode / Cline / Cursor formats, kept because porting KiloCode setups
 * verbatim is a stated goal (X-01).
 *
 * They are alternatives, not layers: a repo carrying both `AGENTS.md` and
 * `CLAUDE.md` almost always carries the *same* rules twice (often a symlink), and
 * concatenating would bill for them twice on every turn.
 */
export const INSTRUCTION_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".clinerules",
  ".kilocoderules",
  ".cursorrules",
] as const;

/**
 * The size cap (X-15e): 32 KiB, roughly 8k tokens.
 *
 * These bytes sit in the system message of **every** request for the life of the
 * session. Caching makes that cheap after the first turn but never free, and a
 * runaway file would quietly eat the context window compaction is trying to
 * protect. Over the cap the *head* is kept — the top of an instruction file is
 * where the rules are — and the truncation is said out loud, in the prompt and on
 * the console, rather than silently costing money.
 */
export const MAX_INSTRUCTION_BYTES = 32 * 1024;

/** Guard against a pathological path; the walk normally stops far sooner. */
const MAX_WALK_DEPTH = 64;

export interface WorkspaceInstructions {
  /** Absolute path of the file that was read. */
  path: string;
  /** Its basename, for display — e.g. `AGENTS.md`. */
  name: string;
  /** The directory it was found in (the launch dir, or an ancestor up to the repo root). */
  dir: string;
  /** The text to inject — already truncated to the cap if it had to be. */
  text: string;
  /** Size on disk, in bytes. */
  bytes: number;
  /** Bytes actually injected (== `bytes` unless truncated). */
  injectedBytes: number;
  /** True when the file exceeded the cap and only its head was injected. */
  truncated: boolean;
}

export interface InstructionReadOptions {
  /** Override the filename precedence list (tests). */
  filenames?: readonly string[];
  /** Override the size cap (tests). */
  maxBytes?: number;
  /** Ceiling for the upward walk; the walk never goes above it. Defaults to the
   *  user's home directory. Injectable so tests don't depend on where they run. */
  home?: string;
}

/**
 * Candidate files, nearest first (X-15b).
 *
 * The launch directory is searched first — that is Joshua's ask, verbatim ("any
 * AGENTS.md file in the current folder"). If it has none we walk **up to and
 * including the repo root** (the first ancestor holding `.git`), because being
 * launched in `repo/packages/web` is the one case where the file you meant is
 * demonstrably somewhere else. The walk also stops at `$HOME` and at the
 * filesystem root, so it can never wander into unrelated territory.
 *
 * Nested *per-directory* files (Claude Code reads them on demand as you touch a
 * subtree) are deliberately **not** read in v1: content discovered mid-session is
 * per-turn content by definition, so it could not live in the system message
 * without re-rendering the cached prefix — it belongs on a user turn, which is
 * X-25's half of the seam, not this one.
 */
export function* instructionCandidates(
  startDir: string,
  opts: InstructionReadOptions = {},
): Generator<string> {
  const filenames = opts.filenames ?? INSTRUCTION_FILENAMES;
  const home = opts.home ?? os.homedir();
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    yield* candidatesIn(dir, filenames);
    // The repo root is the top of "this project". $HOME and `/` are the backstops
    // for a workspace that isn't a git repo at all.
    if (fs.existsSync(path.join(dir, ".git"))) return;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return;
    dir = parent;
  }
}

/**
 * Every matching filename in one directory, in precedence order.
 *
 * *Every* one, not just the best: an empty `AGENTS.md` must hand over to the
 * `CLAUDE.md` beside it rather than to the next directory up, so the caller —
 * which is the thing that knows a blank file reads as nothing — needs to see the
 * rest of the list.
 *
 * Matched **case-insensitively against a directory listing** rather than by
 * stat-ing each exact name. A case-insensitive filesystem (macOS, Windows) would
 * match `agents.md` for a stat of `AGENTS.md` while Linux would not, so the same
 * repo would behave differently on two machines — the listing makes it behave the
 * same everywhere.
 */
function* candidatesIn(dir: string, filenames: readonly string[]): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — nothing here, keep walking
  }
  const byLowerName = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const key = entry.name.toLowerCase();
    if (!byLowerName.has(key)) byLowerName.set(key, entry.name);
  }
  for (const want of filenames) {
    const actual = byLowerName.get(want.toLowerCase());
    if (actual) yield path.join(dir, actual);
  }
}

/** Keep the head of an over-cap file, cut at the last whole line inside the cap
 *  (which also keeps the cut off the middle of a multi-byte character). */
function head(buf: Buffer, maxBytes: number): Buffer {
  const slice = buf.subarray(0, maxBytes);
  const lastNewline = slice.lastIndexOf(0x0a);
  return lastNewline > 0 ? slice.subarray(0, lastNewline) : slice;
}

/**
 * Read the workspace's instruction file, or undefined if there isn't one.
 *
 * Synchronous on purpose: this is called once, from the session factory, on the
 * construction path that has to hand back a `Session` — and it reads one small
 * file that must be in the prompt before the first request goes out.
 *
 * An **empty (or whitespace-only) file reads as no instructions** and the search
 * carries on to the next candidate, so a stray `touch AGENTS.md` neither injects
 * an empty heading nor shadows a real `CLAUDE.md` beside it.
 */
export function readWorkspaceInstructions(
  startDir: string,
  opts: InstructionReadOptions = {},
): WorkspaceInstructions | undefined {
  const maxBytes = opts.maxBytes ?? MAX_INSTRUCTION_BYTES;
  for (const file of instructionCandidates(startDir, opts)) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue; // raced away, or unreadable — try the next candidate
    }
    if (buf.toString("utf8").trim() === "") continue;
    const truncated = buf.length > maxBytes;
    const kept = truncated ? head(buf, maxBytes) : buf;
    return {
      path: file,
      name: path.basename(file),
      dir: path.dirname(file),
      text: kept.toString("utf8").trimEnd(),
      bytes: buf.length,
      injectedBytes: kept.length,
      truncated,
    };
  }
  return undefined;
}

/**
 * The block appended to the base system prompt.
 *
 * It says three things the model would otherwise have to guess: where the text
 * came from, that it is binding, and — the part that matters for X-15g — that it
 * was read **once**. An agent that rewrites `AGENTS.md` with its own tools would
 * otherwise reasonably assume its new rules are now in force; they are not, and
 * cannot be without invalidating the cached prefix mid-session.
 */
export function renderProjectInstructions(found: WorkspaceInstructions): string {
  const lines = [
    `# Project instructions (${found.name})`,
    ``,
    `The workspace at ${found.dir} ships its own instructions for agents working in it, ` +
      `reproduced verbatim below from ${found.path}. Treat them as standing instructions ` +
      `from the user for work in this project.`,
    ``,
    `They were read once, when this session started. Editing that file — including with ` +
      `your own tools — does not change these instructions; the edit takes effect in the ` +
      `next session.`,
    ``,
    found.text,
  ];
  if (found.truncated) {
    lines.push(
      ``,
      `[Truncated: ${found.name} is ${found.bytes.toLocaleString()} bytes and only the first ` +
        `${found.injectedBytes.toLocaleString()} are included. JLCode caps project instructions ` +
        `so they are not re-billed in full on every turn. Tell the user if you need the rest.]`,
    );
  }
  return lines.join("\n");
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** How a surface names what was (or wasn't) loaded — X-15f, the visibility half.
 *  A file above the launch dir is shown by its path relative to it, so "which
 *  file is this" never needs a second command to answer. */
export function describeWorkspaceInstructions(
  found: WorkspaceInstructions | undefined,
  cwd?: string,
): string {
  if (!found) {
    return `none — no ${INSTRUCTION_FILENAMES.join(", ")} in this workspace`;
  }
  const where = cwd && path.resolve(cwd) !== found.dir ? path.relative(path.resolve(cwd), found.path) : found.name;
  const size = formatBytes(found.injectedBytes);
  return found.truncated
    ? `${where} (${size} of ${formatBytes(found.bytes)} — ⚠ truncated at the ${formatBytes(MAX_INSTRUCTION_BYTES)} cap)`
    : `${where} (${size})`;
}

/** The single line `serve` and `config which` both print (X-15f). One function so
 *  the two surfaces cannot drift, the way the window and threshold lines are. */
export function summarizeProjectInstructions(enabled: boolean, cwd: string): string {
  if (!enabled) return "off — the workspace's own instructions are not read (environment.projectInstructions=false)";
  return describeWorkspaceInstructions(readWorkspaceInstructions(cwd), cwd);
}
