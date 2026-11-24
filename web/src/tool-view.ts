/**
 * Presentation helpers for tool results in the transcript (X-11). The approval
 * card shows a call's arguments and then disappears once approved, so the tool
 * block is the only durable place to read what was run and what came back —
 * these turn the raw JSON args + output into a one-line header you can scan.
 * Kept pure (no DOM, no React) so they're Tier-0 testable like tree.ts.
 */

export interface OutputStats {
  lines: number;
  bytes: number;
  /** The collapsed header's hint: "42 lines · 1.2 KB", or "no output". */
  label: string;
}

/** Human byte size, one decimal past KB (a size hint, not an accounting figure). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Size of a tool result, so you know what you're unfolding before you unfold it. */
export function outputStats(content: string): OutputStats {
  const bytes = new TextEncoder().encode(content).length;
  if (content === "") return { lines: 0, bytes: 0, label: "no output" };
  // A trailing newline terminates the last line, it doesn't start another — so a
  // two-line file reads "2 lines", the way `wc -l` and a terminal see it.
  const lines = content.replace(/\n$/, "").split("\n").length;
  return { lines, bytes, label: `${lines} ${lines === 1 ? "line" : "lines"} · ${formatBytes(bytes)}` };
}

/** Collapse a value to one readable line for the header. */
function inline(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-line gist of a call's arguments for the collapsed header. A single-field
 *  call (`{command: "ls -la"}`) reads as its value alone; multi-field calls are
 *  `key: value` pairs. Unparsable args fall back to the raw string — never empty
 *  when there was something there, since that's the bit worth spying on. */
export function summarizeArgs(raw: string | undefined, max = 90): string {
  if (raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "{}") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return clamp(inline(trimmed), max); // partial/repaired args (D-31) still show
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return clamp(inline(parsed), max);
  }
  const fields = Object.entries(parsed as Record<string, unknown>);
  if (fields.length === 0) return "";
  if (fields.length === 1) return clamp(inline(fields[0]![1]), max);
  return clamp(fields.map(([k, v]) => `${k}: ${clamp(inline(v), 40)}`).join(" · "), max);
}

/** The expanded view's arguments: pretty JSON when it parses, raw otherwise. */
export function prettyArgs(raw: string | undefined): string {
  if (raw === undefined) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** A call whose arguments *are* a file: the path, and the body as text (X-23). */
export interface FileArgs {
  path: string;
  body: string;
}

/**
 * `write_file`'s arguments read as a file, not as JSON (X-23).
 *
 * The approval card gets a diff from the server, but it disappears once
 * approved — after that the args are the only record of what was written, and
 * `JSON.stringify` renders a 300-line file as one string of `\n` escapes. There
 * is deliberately **no stored diff**: the transcript is read long after the
 * fact, and a diff against a file that has since changed is a lie waiting to
 * happen. The content is what was actually sent, and stays true.
 *
 * Returns `null` — meaning "fall back to JSON" — for anything that isn't
 * exactly this shape, including a call carrying *extra* arguments, since
 * hiding an argument would be a worse failure than showing escapes.
 */
export function fileArgs(tool: string | undefined, raw: string | undefined): FileArgs | null {
  if (tool !== "write_file" || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // a truncated/repaired call (D-31) shows raw, as it always did
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length !== 2 || !keys.includes("path") || !keys.includes("content")) return null;
  if (typeof rec["path"] !== "string" || typeof rec["content"] !== "string") return null;
  return { path: rec["path"], body: rec["content"] };
}

/** One argument of a call, ready to show (X-61). */
export interface ArgField {
  key: string;
  /** Strings verbatim (real newlines, no escapes); anything else as pretty JSON. */
  text: string;
  /** Long or multi-line → its own box under the key, instead of beside it. */
  block: boolean;
  /** Not a string, so `text` is JSON. */
  json: boolean;
}

/**
 * A call's arguments as labeled fields, not one JSON blob (X-61).
 *
 * The JSON view escapes every string. A `spawn_agent` task or a `send_message`
 * text is prose, and `JSON.stringify` turns it into one long line of `\n`s,
 * which is the opposite of what someone reading history needs. Here each
 * string reads as written. Nested values (arrays, objects) stay JSON, because
 * that is still the clearest flat rendering of a structure.
 *
 * Returns `null` (fall back to `prettyArgs`) for anything that isn't a JSON
 * object: truncated or repaired args (D-31) must still show, exactly as sent.
 */
export function argFields(raw: string | undefined): ArgField[] | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
    const json = typeof value !== "string";
    const text = json ? JSON.stringify(value, null, 2) ?? String(value) : (value as string);
    return { key, text, json, block: text.includes("\n") || text.length > 80 };
  });
}

/** One anchored replacement in an `apply_edits` call (X-61). */
export interface EditView {
  old: string;
  new: string;
  /** `expected_count`, when the model set it (more than one site). */
  count?: number;
}

export interface EditFileView {
  path: string;
  edits: EditView[];
}

/**
 * `apply_edits`'s arguments as files and replacements, not nested JSON (X-61).
 *
 * The approval card showed a real diff, computed against the file as it was.
 * History deliberately stores no diff, for the same reason `fileArgs` doesn't
 * (X-23): the file may have changed since, and a diff against today's file is
 * wrong. What *was* sent is each anchor and its replacement, and that stays
 * true, so that is what this returns.
 *
 * `null` (fall back to JSON) for any shape it doesn't recognize, including
 * extra keys, since hiding an argument is worse than showing JSON.
 */
export function editArgs(tool: string | undefined, raw: string | undefined): EditFileView[] | null {
  if (tool !== "apply_edits" || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const only = (rec: Record<string, unknown>, allowed: string[]) => Object.keys(rec).every((k) => allowed.includes(k));
  if (!isRec(parsed) || !only(parsed, ["files"]) || !Array.isArray(parsed["files"])) return null;
  const out: EditFileView[] = [];
  for (const f of parsed["files"]) {
    if (!isRec(f) || !only(f, ["path", "edits"]) || typeof f["path"] !== "string" || !Array.isArray(f["edits"])) {
      return null;
    }
    const edits: EditView[] = [];
    for (const e of f["edits"]) {
      if (!isRec(e) || !only(e, ["old_string", "new_string", "expected_count"])) return null;
      if (typeof e["old_string"] !== "string" || typeof e["new_string"] !== "string") return null;
      const count = e["expected_count"];
      if (count !== undefined && typeof count !== "number") return null;
      edits.push({ old: e["old_string"], new: e["new_string"], ...(typeof count === "number" ? { count } : {}) });
    }
    out.push({ path: f["path"], edits });
  }
  return out;
}

/** `apply_edits`' collapsed header (X-61): which files, how many edits, not JSON. */
export function editsGist(files: EditFileView[], max = 90): string {
  const n = files.reduce((sum, f) => sum + f.edits.length, 0);
  const names = files.map((f) => f.path).join(", ");
  return clamp(`${n} ${n === 1 ? "edit" : "edits"} · ${names}`, max);
}
