/**
 * What a file actually *is*, decided from its bytes (P8a, D-78b).
 *
 * `read_file` used to decode every path as UTF-8 unconditionally, so a `.png`
 * came back as a run of U+FFFD through `ok()` — the agent was told the read
 * succeeded and handed itself mush. Classification happens before any decode,
 * from a small sample, so a 2 GB video is never slurped just to discover it is
 * not text.
 *
 * **Magic bytes decide; the filename never does.** An extension is a claim by
 * whoever named the file, and the two cases that matter are exactly the ones it
 * gets wrong: a `.png` holding text (readable, and it should stay readable) and
 * a screenshot saved as `.txt` (not readable, and pretending otherwise is the
 * bug this closes). `file-type` (D-45 — the mainline package for this) reads the
 * signature; anything it cannot name falls through to the UTF-8 test below.
 *
 * SVG is deliberately **text**: `file-type` does not claim it, so it lands on
 * the text path, which is what we want — it is an image the model can read
 * *and edit* as source. KiloCode draws the same line (`isImageAttachment`
 * excludes `image/svg+xml`).
 */
import fs from "node:fs";
import { fileTypeFromBuffer } from "file-type";

/**
 * What a vision model will accept, and nothing else. These four are the
 * intersection of OpenRouter's documented list and KiloCode's `IMAGE_MIMES`;
 * a format outside it is a binary we refuse, not an image we mangle.
 */
export const IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Enough bytes for a signature with room to spare — `file-type` asks for ~4100
 * for the formats that carry their magic past the header, so the next power of
 * two buys the margin for free. Never the whole file: the point is to classify
 * *before* committing to a read.
 */
export const SAMPLE_BYTES = 8192;

/**
 * The largest image we will hand to a model (P8b). Two independent reasons for a
 * cap, and the smaller of the two wins: providers refuse oversized images
 * outright (Anthropic's per-image limit is 5 MB), and until P8c moves the bytes
 * to a sidecar every attachment is inline base64 in an **append-only** log —
 * 4/3 of this number, in a file `ConversationStore.load()` re-parses on every
 * resume, fork and rewind, forever. A screenshot is a few hundred KB; anything
 * near this is not a screenshot, so the refusal costs nothing real and the
 * silent alternative (a 400 from the provider mid-turn) costs a turn.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type FileKind =
  /** A vision model could look at this. */
  | { kind: "image"; mime: string; ext: string }
  /** Not text and not an image. `mime`/`ext` are absent when nothing named it. */
  | { kind: "binary"; mime?: string; ext?: string }
  /** Decodes as UTF-8 with nothing mangled — the ordinary path. */
  | { kind: "text" };

/**
 * Not text: a NUL byte survives the utf8 decode, and anything else invalid comes
 * back as U+FFFD. Either way the "content" is already mangled.
 *
 * Applied to the **sample**, so a replacement character that the file genuinely
 * contains near the end cannot condemn it — but a sample that decodes cleanly
 * while the tail does not is still read as text, which matches the old
 * behaviour and is the conservative direction (we read it rather than refuse).
 */
export function looksBinary(text: string): boolean {
  return /[\u0000\uFFFD]/.test(text);
}

/**
 * Classify from a sample. Async because `file-type` is; every caller is already
 * in an async tool `execute`.
 */
export async function classifySample(sample: Buffer): Promise<FileKind> {
  const found = await fileTypeFromBuffer(sample);
  if (found) {
    if (IMAGE_MIMES.has(found.mime)) return { kind: "image", mime: found.mime, ext: found.ext };
    return { kind: "binary", mime: found.mime, ext: found.ext };
  }
  // Nothing claimed it. A signature-less binary still fails the UTF-8 test.
  if (looksBinary(sample.toString("utf8"))) return { kind: "binary" };
  return { kind: "text" };
}

/**
 * Classify a path by reading only its first `SAMPLE_BYTES`. Throws whatever
 * `fs` throws (missing file, EISDIR, EACCES) so the caller's existing error
 * handling keeps reporting those the way it always has.
 */
export async function classifyFile(absPath: string): Promise<FileKind> {
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(SAMPLE_BYTES);
    const read = fs.readSync(fd, buf, 0, SAMPLE_BYTES, 0);
    return await classifySample(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}

/** Human-readable size, for a refusal that says how big the thing it declined is. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
