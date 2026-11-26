/**
 * `read_file(process: id, stream?)` — reading a command's output like a file
 * (D-104). The log is on disk (`TaskRegistry`), so `offset`/`limit` mean what
 * they mean for a file and stay stable while the process keeps writing.
 *
 * Rules that differ from an ordinary file, and why:
 *
 *   - **No `classifyFile`** (R1 G5): ANSI colour codes are not binary, and a
 *     log is ours, not a file of unknown kind.
 *   - **Streamed, never read whole** (G5): a log has no size cap (D-104), so the
 *     window is found by scanning in chunks; memory stays flat on a multi-GB log.
 *   - **Complete lines only, while running** (R2 must-fix 3, R3 nit): N counts
 *     the `\n`s written so far. A trailing partial line (a `read -p "Name: "`
 *     prompt, a progress bar) is shown only when the window reaches line N, does
 *     not count toward `limit`, and is marked as still being written; the
 *     continuation offset points at it. `offset: N+1` while running is legal and
 *     answers "no new lines yet", so a tail cursor can poll. Once the process has
 *     ended, the partial line counts as an ordinary last line.
 *   - **The footer always states the process state** ("lines 1–200 of 1,412 so
 *     far · running"), because a log, unlike a file, is still changing.
 */
import fs from "node:fs";
import type { ToolResult } from "./types.js";
import { describeState, type ProcessStream, type TaskRegistry, type TaskView } from "./task-registry.js";

const CHUNK = 64 * 1024;

export interface ProcessReadRequest {
  id: string;
  stream: ProcessStream;
  /** 1-based; negative counts from the end (D-104). Never 0 — checked upstream. */
  offset?: number;
  limit?: number;
  /** The output char budget — `read_file`'s, shared. */
  maxChars: number;
}

/** "1,412" — the footer's number style (D-104's example). */
function n(x: number): string {
  return x.toLocaleString("en-US");
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

/** Every id this conversation can read, for the unknown-id error (D-104, G14). */
function readableList(tasks: TaskRegistry | undefined): string {
  const all = tasks?.all() ?? [];
  if (all.length === 0) return "This conversation has no processes to read.";
  const rows = all.map((v) => `  ${v.id} · ${describeState(v)} · ${v.command.slice(0, 80)}`);
  return `Readable processes in this conversation:\n${rows.join("\n")}`;
}

/**
 * Scan `file` and return lines `from`..`from+count-1` (1-based, complete lines
 * only — those ending in `\n`) plus, if asked, the bytes after the last `\n`.
 * Lines are decoded whole, so a multi-byte character split across chunks is
 * never mangled. Stops once `maxChars` is spent (`clipped`). A line is never
 * buffered past `maxChars * 4` bytes — enough for `maxChars` characters of any
 * width — so one endless progress-bar line can't exhaust memory either.
 */
function scan(
  file: string,
  from: number,
  count: number,
  maxChars: number,
  wantTail: boolean,
): { lines: string[]; tail: string; clipped: boolean } {
  const lines: string[] = [];
  const byteCap = maxChars * 4;
  let chars = 0;
  let line = 1;
  let pending: Buffer[] = []; // the current line's bytes, kept only when they matter
  let pendingBytes = 0;
  const keep = (b: Buffer): void => {
    if (pendingBytes >= byteCap) return;
    const room = byteCap - pendingBytes;
    const part = b.length > room ? b.subarray(0, room) : b;
    pending.push(Buffer.from(part));
    pendingBytes += part.length;
  };
  const clip = (text: string): string => `${text.slice(0, maxChars)}… [line clipped at ${n(maxChars)} chars]`;
  const last = from + count - 1;
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    while (pos < size) {
      const got = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (got <= 0) break;
      pos += got;
      const chunk = buf.subarray(0, got);
      let start = 0;
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
        if (line >= from && line <= last) {
          keep(chunk.subarray(start, i));
          const text = Buffer.concat(pending).toString("utf8");
          if (chars + text.length + 1 > maxChars) {
            // One line longer than the whole budget still shows its head —
            // better a clipped line than an empty answer.
            if (lines.length === 0) lines.push(clip(text));
            return { lines, tail: "", clipped: true };
          }
          lines.push(text);
          chars += text.length + 1;
        }
        pending = [];
        pendingBytes = 0;
        line++;
        start = i + 1;
        if (line > last && !wantTail) return { lines, tail: "", clipped: false };
      }
      if (start < got && ((line >= from && line <= last) || (wantTail && line > last))) {
        keep(chunk.subarray(start));
      }
    }
    if (!wantTail) return { lines, tail: "", clipped: false };
    let tail = Buffer.concat(pending).toString("utf8");
    if (tail.length > Math.max(0, maxChars - chars)) tail = clip(tail.slice(0, Math.max(0, maxChars - chars)));
    return { lines, tail, clipped: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** `read_file(process:)`. */
export function readProcess(tasks: TaskRegistry | undefined, req: ProcessReadRequest): ToolResult {
  const view: TaskView | undefined = tasks?.get(req.id);
  if (!tasks || !view) {
    // An id from before a restart lands here too (G14): the new registry is
    // empty, so it reads as unknown; its files stay readable by path until swept.
    return err(`No process "${req.id}" in this conversation. ${readableList(tasks)}`);
  }
  const log = tasks.log(req.id, req.stream);
  if (!log) {
    return err(`Process ${req.id} has no output to read: ${describeState(view)}.`);
  }
  const state = describeState(log.view);
  const running = !log.ended;
  // While running, N is complete lines; once ended, a last unterminated line
  // counts like any other (R2 must-fix 3).
  const total = running ? log.lines : log.lines + (log.partial ? 1 : 0);
  const soFar = running ? " so far" : "";
  const label = req.stream === "combined" ? `process ${req.id}` : `process ${req.id} (${req.stream})`;

  let from = req.offset ?? 1;
  if (from < 0) from = Math.max(1, total + from + 1); // past the start clamps to line 1
  const partialLine = running && log.partial;

  try {
    if (total === 0 && !partialLine) {
      return { content: running ? `[no output yet · running]` : `[no output · ${state}]` };
    }
    if (running ? from > total + 1 : from > total) {
      return err(
        `offset ${req.offset} is past the end of ${label} (${n(total)} ${running ? "complete " : ""}lines${soFar} · ${state})`,
      );
    }
    // The window over the counted lines. `from === total + 1` while running is
    // the tail cursor's poll: no complete line to show, maybe a partial one.
    const count = req.limit === undefined ? Math.max(0, total - from + 1) : Math.min(req.limit, total - from + 1);
    const reaches = from + count - 1 >= total; // the window ends at line N
    // The bytes after the last `\n` are wanted when the window reaches the end:
    // while running they are the marked partial line (outside the count); once
    // ended they *are* line N, an ordinary line inside it.
    const wantTail = log.partial && reaches;
    const r = scan(log.file, from, Math.max(0, Math.min(count, log.lines - from + 1)), req.maxChars, wantTail);
    const endTail = !running && wantTail && !r.clipped ? [r.tail] : [];
    const shown = r.lines.length + endTail.length;
    const lastShown = from + shown - 1;
    const tail = running && wantTail && !r.clipped ? r.tail : undefined;

    const body = [...r.lines, ...endTail, ...(tail !== undefined ? [tail] : [])].join("\n");
    let footer: string;
    if (shown === 0) {
      footer =
        tail !== undefined
          ? `[no new complete lines yet; line ${n(total + 1)} (above) is still being written · running — continue with offset ${total + 1}]`
          : `[no new lines yet · ${n(total)} lines so far · running — poll again with offset ${total + 1}]`;
    } else {
      const range = `lines ${n(from)}–${n(lastShown)} of ${n(total)}${soFar}`;
      const partialNote = tail !== undefined ? `, then line ${n(total + 1)} (still being written)` : "";
      // While running there is always somewhere to continue from: new output may
      // come. The cursor points at the partial line when one was shown.
      const next = tail !== undefined ? total + 1 : lastShown + 1;
      const more = running || lastShown < total ? ` — continue with offset ${next}` : "";
      footer = `[${range}${partialNote} · ${state}${more}]`;
    }
    return { content: body === "" ? footer : `${body}\n${footer}` };
  } catch (e) {
    return err(`read failed: ${(e as Error).message}`);
  }
}
