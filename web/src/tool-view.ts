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
