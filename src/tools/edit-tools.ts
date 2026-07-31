/**
 * `apply_edits` — native anchor-based multi-edit across multiple files (D-53).
 *
 * Extracted from what the agent was already doing by hand: writing throwaway
 * Python into /tmp that read a file, asserted an anchor appeared exactly N
 * times, replaced it, and wrote once at the end. With only `write_file` (whole
 * file, D-03), seventeen edits to a 107 KB source cost ~27K tokens *each*, so
 * scripting the edit was cheaper than performing it. This is that script, made
 * native — and it keeps the safety rail the model invented for itself: an
 * anchor whose occurrence count doesn't match expectation is a **failure**, not
 * something to silently absorb.
 *
 * Two properties are load-bearing:
 *   - **All-or-nothing.** Every anchor in every file is located and verified
 *     before *any* file is written, so a batch that is wrong in its last edit
 *     leaves nothing half-applied.
 *   - **`expected_count`, not `replace_all`.** The call states how many sites it
 *     means to change; the file disagreeing is drift the model needs to see.
 *
 * Truncation (D-30): this is a *replacing* op, so a partial call must never be
 * applied. A stream cut short leaves `arguments` as unparseable JSON, which
 * `Session.tryExecute` rejects before reaching here — the atomic-reject D-30
 * asks for. Nothing in this file repairs or salvages partial args.
 */
import fs from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ClassifiedPaths, Tool, ToolContext, ToolPreview, ToolResult } from "./types.js";

/** Context lines shown either side of a change in the approval diff. */
const DIFF_CONTEXT = 3;
/** Per-file cap on diff lines sent to the browser, so a huge batch can't flood it. */
const MAX_DIFF_LINES = 400;
/** Line numbers listed per edit in the receipt before it summarizes instead. */
const MAX_REPORTED_LINES = 10;

export interface EditSpec {
  old_string: string;
  new_string: string;
  expected_count?: number;
}

export interface PlannedEdit {
  /** 0-based index into the file's `edits` array. */
  index: number;
  /** 1-based line numbers where this anchor matched, in the buffer as it stood. */
  lines: number[];
}

export type EditPlan =
  | { ok: true; output: string; edits: PlannedEdit[] }
  | { ok: false; reason: string };

/** 1-based line number of a character offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Offsets of every non-overlapping occurrence — the same sites `replaceAll` hits. */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/**
 * Verify and apply one file's edits against an in-memory buffer (pure).
 *
 * Edits apply in order, so a later anchor may legitimately match text an
 * earlier edit produced — that is how a 17-edit batch stays expressible as a
 * flat list rather than a dependency graph.
 */
export function planFileEdits(source: string, edits: EditSpec[]): EditPlan {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, reason: "no edits given" };
  }
  let buf = source;
  const planned: PlannedEdit[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    const at = `edit ${i + 1}`;
    if (typeof e?.old_string !== "string" || typeof e?.new_string !== "string") {
      return { ok: false, reason: `${at}: needs string 'old_string' and 'new_string'` };
    }
    if (e.old_string === "") {
      return { ok: false, reason: `${at}: 'old_string' is empty — use write_file to create a file` };
    }
    if (e.old_string === e.new_string) {
      return { ok: false, reason: `${at}: 'old_string' and 'new_string' are identical (no-op)` };
    }
    const expected = e.expected_count ?? 1;
    if (!Number.isInteger(expected) || expected < 1) {
      return { ok: false, reason: `${at}: 'expected_count' must be a positive integer` };
    }
    const hits = occurrences(buf, e.old_string);
    if (hits.length !== expected) {
      // The rail the model built for itself: never guess which site was meant.
      const hint =
        hits.length === 0
          ? " — the anchor must match the file exactly, whitespace included"
          : expected === 1
            ? " — extend the anchor until it is unique, or set 'expected_count'"
            : "";
      return {
        ok: false,
        reason: `${at}: anchor found ${hits.length} time(s), expected ${expected}${hint}`,
      };
    }
    planned.push({ index: i, lines: hits.map((h) => lineOf(buf, h)) });
    buf = buf.split(e.old_string).join(e.new_string);
  }
  return { ok: true, output: buf, edits: planned };
}

/** A unified diff of one file's planned change, trimmed for the approval card. */
export function renderDiff(rel: string, before: string, after: string): {
  patch: string;
  added: number;
  removed: number;
} {
  const full = createTwoFilesPatch(rel, rel, before, after, undefined, undefined, {
    context: DIFF_CONTEXT,
  });
  // Drop the `Index:`/`===`/`---`/`+++` preamble — the card shows the path itself.
  const lines = full.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  const body = start === -1 ? [] : lines.slice(start);
  let added = 0;
  let removed = 0;
  for (const l of body) {
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  const shown =
    body.length > MAX_DIFF_LINES
      ? [...body.slice(0, MAX_DIFF_LINES), `… ${body.length - MAX_DIFF_LINES} more diff lines`]
      : body;
  return { patch: shown.join("\n").trimEnd(), added, removed };
}

interface FileEditsArg {
  path: string;
  edits: EditSpec[];
}

/** Pull the `files` argument into shape, or say why it isn't one. */
function readFilesArg(args: Record<string, unknown>): FileEditsArg[] | string {
  const files = args["files"];
  if (!Array.isArray(files) || files.length === 0) {
    return "apply_edits requires a non-empty 'files' array";
  }
  const out: FileEditsArg[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const rec = f as Record<string, unknown> | null;
    const p = rec && typeof rec["path"] === "string" ? (rec["path"] as string) : undefined;
    if (p === undefined) return "each entry of 'files' needs a string 'path'";
    if (seen.has(p)) return `'${p}' appears twice in 'files' — put all its edits in one entry`;
    seen.add(p);
    out.push({ path: p, edits: (rec!["edits"] ?? []) as EditSpec[] });
  }
  return out;
}

/** Plan every file: resolve, read, verify anchors. Never writes. */
function planAll(
  files: FileEditsArg[],
  ctx: ToolContext,
): { path: string; before: string; plan: EditPlan }[] {
  return files.map((f) => {
    const r = ctx.sandbox.resolve(f.path);
    if (!r.ok) return { path: f.path, before: "", plan: { ok: false, reason: r.reason } as EditPlan };
    let before: string;
    try {
      before = fs.readFileSync(r.path, "utf8");
    } catch (e) {
      return { path: f.path, before: "", plan: { ok: false, reason: `read failed: ${(e as Error).message}` } as EditPlan };
    }
    return { path: f.path, before, plan: planFileEdits(before, f.edits) };
  });
}

const applyEdits: Tool = {
  name: "apply_edits",
  kind: "write",
  mutates: true,
  // Paths are nested (`files[].path`), so the fence finds them through
  // classifyPaths rather than the flat `pathArgs` list (D-19/D-47d).
  classifyPaths(args): ClassifiedPaths {
    const files = args["files"];
    const paths = Array.isArray(files)
      ? files
          .map((f) => (f as Record<string, unknown> | null)?.["path"])
          .filter((v): v is string => typeof v === "string")
          .map((value) => ({ field: "files[].path", value }))
      : [];
    // Native tool: nothing here is a guess, so there is nothing to learn (D-48).
    return { paths, unknown: [] };
  },
  def: {
    type: "function",
    function: {
      name: "apply_edits",
      description:
        "Edit existing files by exact-anchor replacement — many edits across many files in one call. " +
        "Prefer this over write_file for changing part of a file: it sends only the changed text, not the whole file. " +
        "Every anchor is verified before anything is written, and the whole batch is applied or none of it is. " +
        "Each anchor must match the file exactly (whitespace included) and, by default, exactly once — include " +
        "enough surrounding context to make it unique, or set expected_count to the number of identical sites you " +
        "intend to change. Edits apply in order, so a later anchor may match text an earlier edit produced. " +
        "Use write_file to create a new file or replace one wholesale.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description: "The files to edit, each with its own list of edits.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace-relative or absolute path to an existing file" },
                edits: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      old_string: { type: "string", description: "Exact text to find, including indentation" },
                      new_string: { type: "string", description: "Text to replace it with" },
                      expected_count: {
                        type: "integer",
                        description: "How many sites this anchor should match. Default 1; the call fails if the file disagrees.",
                      },
                    },
                    required: ["old_string", "new_string"],
                  },
                },
              },
              required: ["path", "edits"],
            },
          },
        },
        required: ["files"],
      },
    },
  },

  /** The approval card's unified diff (D-53). Planning *is* the preview, so a
   *  batch that cannot apply shows its reason here rather than after approval. */
  preview(args, ctx): ToolPreview | undefined {
    const files = readFilesArg(args);
    if (typeof files === "string") return undefined;
    const planned = planAll(files, ctx);
    return {
      kind: "diff",
      files: planned.map(({ path: p, before, plan }) => {
        if (!plan.ok) return { path: p, patch: "", added: 0, removed: 0, sites: 0, error: plan.reason };
        const { patch, added, removed } = renderDiff(p, before, plan.output);
        const sites = plan.edits.reduce((n, e) => n + e.lines.length, 0);
        return { path: p, patch, added, removed, sites };
      }),
    };
  },

  async execute(args, ctx): Promise<ToolResult> {
    const files = readFilesArg(args);
    if (typeof files === "string") return { content: files, isError: true };

    // Plan everything first — all-or-nothing means no file is touched until
    // every anchor in every file has been found (D-53).
    const planned = planAll(files, ctx);
    const failures = planned.filter((p) => !p.plan.ok);
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `  ${f.path}: ${(f.plan as { ok: false; reason: string }).reason}`)
        .join("\n");
      return {
        content: `no edits applied — ${failures.length} of ${planned.length} file(s) failed to plan:\n${detail}`,
        isError: true,
      };
    }

    const report: string[] = [];
    let totalEdits = 0;
    let totalSites = 0;
    for (const { path: rel, plan } of planned) {
      const p = plan as { ok: true; output: string; edits: PlannedEdit[] };
      const r = ctx.sandbox.resolve(rel);
      if (!r.ok) return { content: `fence rejected ${rel} after planning: ${r.reason}`, isError: true };
      try {
        // Atomic per file (temp → rename), same as write_file (D-30).
        const tmp = path.join(path.dirname(r.path), `.${path.basename(r.path)}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, p.output);
        fs.renameSync(tmp, r.path);
      } catch (e) {
        // Planning is where essentially every failure lives, so reaching here
        // means the filesystem refused mid-batch — say so plainly rather than
        // claiming the batch applied.
        return {
          content: `partially applied — ${rel} failed to write: ${(e as Error).message}\n${report.join("\n")}`,
          isError: true,
        };
      }
      const sites = p.edits.reduce((n, e) => n + e.lines.length, 0);
      totalEdits += p.edits.length;
      totalSites += sites;
      const lines = p.edits.flatMap((e) => e.lines).sort((a, b) => a - b);
      const shown =
        lines.length > MAX_REPORTED_LINES
          ? `${lines.slice(0, MAX_REPORTED_LINES).join(", ")}, +${lines.length - MAX_REPORTED_LINES} more`
          : lines.join(", ");
      report.push(`  ${rel} — ${p.edits.length} edit(s), ${sites} site(s) at line ${shown}`);
    }
    return {
      content: `applied ${totalEdits} edit(s) across ${planned.length} file(s), ${totalSites} site(s):\n${report.join("\n")}`,
    };
  },
};

export function editTools(): Tool[] {
  return [applyEdits];
}
