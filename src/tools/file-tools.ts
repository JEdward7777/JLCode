/**
 * Native, sandboxed file tools (D-03): read / write / delete / list / glob /
 * grep, plus the anchor-based `apply_edits` from `edit-tools.ts` (D-53). Every
 * path goes through the workspace fence. Writes are atomic (temp → rename), so
 * a bad/partial write never leaves a half file (D-30).
 */
import fs from "node:fs";
import path from "node:path";
import { editTools } from "./edit-tools.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_READ_CHARS = 100_000;
const MAX_GLOB = 500;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 512 * 1024;
/**
 * Backstop against a pathological tree, not a search limit: grep reads every file it is asked
 * about, because a non-matching file costs no output. There is deliberately no cap on the *number*
 * of files searched — capping that made grep answer "no matches" for files it never opened.
 */
const MAX_GREP_SCAN_BYTES = 128 * 1024 * 1024;
/** Dot-directories that are machine state rather than source, so grep never walks into them. */
const GREP_EXCLUDED_DIRS = new Set([".git"]);

/**
 * Depth-first walk yielding every file under `root`, relative-path style.
 *
 * Hand-rolled rather than `fs.globSync`: `**` never descends into dot-directories (verified —
 * `**\/.*` and `**\/.*\/**` both return `[]`), which silently hid `.github/`, `.env` and friends
 * from every search. Symlinked directories are not followed, so a cycle cannot hang the walk.
 */
function* walkFiles(
  root: string,
  stats: { unreadableDirs: number },
  rel = "",
): Generator<{ abs: string; display: string }> {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    stats.unreadableDirs++;
    return;
  }
  for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const childRel = rel ? path.join(rel, dirent.name) : dirent.name;
    if (dirent.isDirectory()) {
      if (GREP_EXCLUDED_DIRS.has(dirent.name)) continue;
      yield* walkFiles(root, stats, childRel);
    } else if (dirent.isFile()) {
      yield { abs: path.join(root, childRel), display: childRel };
    }
  }
}

function ok(content: string): ToolResult {
  return { content };
}
function err(content: string): ToolResult {
  return { content, isError: true };
}
function reqStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}
function reqInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isInteger(v)) return v;
  // Models sometimes stringify numeric args; accept a clean integer string.
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

const readFile: Tool = {
  name: "read_file",
  kind: "read",
  mutates: false,
  pathArgs: ["path"],
  def: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file within the workspace. Large files are capped, so use 'offset' and 'limit' " +
        "to page through one that doesn't fit — the reply says how many lines the file has and where the " +
        "returned window sits, so you can always reach the tail.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative or absolute path" },
          offset: { type: "integer", description: "1-based line number to start at (default 1)" },
          limit: { type: "integer", description: "How many lines to return (default: as many as fit)" },
        },
        required: ["path"],
      },
    },
  },
  async execute(args, ctx) {
    const p = reqStr(args, "path");
    if (p === undefined) return err("read_file requires a string 'path'");
    const offset = reqInt(args, "offset");
    const limit = reqInt(args, "limit");
    if (offset !== undefined && offset < 1) return err("read_file 'offset' is a 1-based line number");
    if (limit !== undefined && limit < 1) return err("read_file 'limit' must be at least 1");
    const r = ctx.sandbox.resolve(p);
    if (!r.ok) return err(r.reason);
    try {
      const data = fs.readFileSync(r.path, "utf8");
      // Whole file, unwindowed, within the cap: hand back exactly what's on disk.
      if (offset === undefined && limit === undefined && data.length <= MAX_READ_CHARS) return ok(data);

      const lines = data.split("\n");
      const total = lines.length;
      const from = (offset ?? 1) - 1;
      if (from >= total) return err(`offset ${offset} is past the end of ${p} (${total} lines)`);
      const window = lines.slice(from, limit === undefined ? undefined : from + limit);

      // The char cap still applies to whatever window was asked for — a 'limit'
      // of 100000 lines must not blow the context (D-53: the old unpageable cap
      // is what left the agent anchoring into a file whose tail it never saw).
      let text = window.join("\n");
      let shownLines = window.length;
      if (text.length > MAX_READ_CHARS) {
        const kept: string[] = [];
        let size = 0;
        for (const line of window) {
          if (size + line.length + 1 > MAX_READ_CHARS) break;
          kept.push(line);
          size += line.length + 1;
        }
        text = kept.join("\n");
        shownLines = kept.length;
      }
      const last = from + shownLines;
      const more = last < total ? ` — continue with offset ${last + 1}` : "";
      return ok(`${text}\n[lines ${from + 1}-${last} of ${total}${more}]`);
    } catch (e) {
      return err(`read failed: ${(e as Error).message}`);
    }
  },
};

const writeFile: Tool = {
  name: "write_file",
  kind: "write",
  mutates: true,
  pathArgs: ["path"],
  def: {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file within the workspace (atomic).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args, ctx) {
    const p = reqStr(args, "path");
    const content = reqStr(args, "content");
    if (p === undefined || content === undefined) return err("write_file requires string 'path' and 'content'");
    const r = ctx.sandbox.resolve(p);
    if (!r.ok) return err(r.reason);
    try {
      const tmp = path.join(path.dirname(r.path), `.${path.basename(r.path)}.${process.pid}.tmp`);
      fs.mkdirSync(path.dirname(r.path), { recursive: true });
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, r.path);
      return ok(`wrote ${Buffer.byteLength(content)} bytes to ${p}`);
    } catch (e) {
      return err(`write failed: ${(e as Error).message}`);
    }
  },
};

const deleteFile: Tool = {
  name: "delete_file",
  kind: "write",
  mutates: true,
  pathArgs: ["path"],
  def: {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file within the workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  async execute(args, ctx) {
    const p = reqStr(args, "path");
    if (p === undefined) return err("delete_file requires a string 'path'");
    const r = ctx.sandbox.resolve(p);
    if (!r.ok) return err(r.reason);
    try {
      fs.unlinkSync(r.path);
      return ok(`deleted ${p}`);
    } catch (e) {
      return err(`delete failed: ${(e as Error).message}`);
    }
  },
};

const listDir: Tool = {
  name: "list_dir",
  kind: "read",
  mutates: false,
  pathArgs: ["path"],
  def: {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries of a directory within the workspace.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Default '.'" } } },
    },
  },
  async execute(args, ctx) {
    const p = reqStr(args, "path") ?? ".";
    const r = ctx.sandbox.resolve(p);
    if (!r.ok) return err(r.reason);
    try {
      const entries = fs.readdirSync(r.path, { withFileTypes: true });
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return ok(lines.length > 0 ? lines.join("\n") : "(empty)");
    } catch (e) {
      return err(`list failed: ${(e as Error).message}`);
    }
  },
};

const glob: Tool = {
  name: "glob",
  kind: "read",
  mutates: false,
  def: {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern (e.g. 'src/**/*.ts') within the workspace.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  },
  async execute(args, ctx) {
    const pattern = reqStr(args, "pattern");
    if (pattern === undefined) return err("glob requires a string 'pattern'");
    try {
      const matches = fs.globSync(pattern, { cwd: ctx.sandbox.primary }).slice(0, MAX_GLOB);
      return ok(matches.length > 0 ? matches.join("\n") : "(no matches)");
    } catch (e) {
      return err(`glob failed: ${(e as Error).message}`);
    }
  },
};

const grep: Tool = {
  name: "grep",
  kind: "read",
  mutates: false,
  pathArgs: ["path"],
  def: {
    type: "function",
    function: {
      name: "grep",
      description: "Search files for a regular expression within the workspace.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "File or directory to search; default '.'" },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(args, ctx) {
    const pattern = reqStr(args, "pattern");
    if (pattern === undefined) return err("grep requires a string 'pattern'");
    const searchPath = reqStr(args, "path") ?? ".";
    const r = ctx.sandbox.resolve(searchPath);
    if (!r.ok) return err(r.reason);
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return err(`invalid regex: ${(e as Error).message}`);
    }
    try {
      // The target has to be classified before searching. `globSync` answers `[]` — never an
      // error — for a cwd that is a file or does not exist, and `sandbox.resolve` deliberately
      // admits not-yet-existing paths so `write_file` can create them. Without this check an
      // unsearched target comes back as "no matches", which reads as a *verified absence* and is
      // the one wrong answer grep must never give.
      let target: fs.Stats;
      try {
        target = fs.statSync(r.path);
      } catch {
        return err(`grep: path does not exist: ${searchPath}`);
      }

      let entries: Iterable<{ abs: string; display: string }>;
      const walk = { unreadableDirs: 0 };
      if (target.isFile()) {
        entries = [{ abs: r.path, display: searchPath }];
      } else if (target.isDirectory()) {
        entries = walkFiles(r.path, walk);
      } else {
        return err(`grep: path is neither a file nor a directory: ${searchPath}`);
      }

      const out: string[] = [];
      let searched = 0;
      let skippedLarge = 0;
      let skippedUnreadable = 0;
      let hitMatchCap = false;
      let bytesRead = 0;
      let hitByteBudget = false;

      for (const { abs, display } of entries) {
        // Only the *match* cap ends the scan early: matches cost output, and output is the
        // scarce resource. A file that does not match costs nothing, so there is no honest
        // reason to stop reading files — stopping there would report "no matches" for a corpus
        // the tool simply declined to look at.
        if (out.length >= MAX_GREP_MATCHES) {
          hitMatchCap = true;
          break;
        }
        if (bytesRead >= MAX_GREP_SCAN_BYTES) {
          hitByteBudget = true;
          break;
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          skippedUnreadable++;
          continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > MAX_GREP_FILE_BYTES) {
          skippedLarge++;
          continue;
        }
        let text: string;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch {
          skippedUnreadable++;
          continue;
        }
        searched++;
        bytesRead += stat.size;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            out.push(`${display}:${i + 1}: ${lines[i]!.trim()}`);
            if (out.length >= MAX_GREP_MATCHES) {
              hitMatchCap = true;
              break;
            }
          }
        }
      }

      // Anything the search could not cover is stated outright. An unqualified "no matches" is
      // reserved for the case where every requested file really was read end to end.
      const notes: string[] = [];
      if (hitByteBudget) {
        notes.push(
          `stopped after reading ${MAX_GREP_SCAN_BYTES / (1024 * 1024)}MB — results are INCOMPLETE, ` +
            `narrow 'path' or search a subdirectory`,
        );
      }
      if (skippedLarge > 0) {
        notes.push(`${skippedLarge} file(s) skipped: larger than ${MAX_GREP_FILE_BYTES / 1024}KB`);
      }
      if (skippedUnreadable > 0) notes.push(`${skippedUnreadable} file(s) skipped: unreadable`);
      if (walk.unreadableDirs > 0) {
        notes.push(`${walk.unreadableDirs} director(ies) skipped: unreadable`);
      }
      if (hitMatchCap) notes.push(`stopped at ${MAX_GREP_MATCHES} matches; more may exist`);
      const suffix = notes.length > 0 ? `\n[grep: ${notes.join("; ")}]` : "";

      if (out.length > 0) return ok(out.join("\n") + suffix);
      return ok(`(no matches; searched ${searched} file(s))${suffix}`);
    } catch (e) {
      return err(`grep failed: ${(e as Error).message}`);
    }
  },
};

export function fileTools(): Tool[] {
  return [readFile, writeFile, deleteFile, listDir, glob, grep, ...editTools()];
}
