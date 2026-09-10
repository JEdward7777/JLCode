/**
 * `file_url` — show Joshua a file without the bytes going through the model
 * (X-43, D-83).
 *
 * Two ways to put something on screen existed before this and neither fit. An
 * **attachment** (P8b, D-78j) only carries bytes a tool handed back *inline*,
 * and it costs a full image in the wire — so "here is the chart you asked for"
 * was priced like "read this chart and tell me what it says". A **markdown link
 * the agent writes itself** cannot resolve at all: the web client's static root
 * is the JLCode install, not the workspace, and the SPA fallback answers the
 * miss with `index.html`, so the browser draws a broken image over a 200.
 *
 * This is the third way, and it is a **capability, not a rewrite rule**. The
 * agent names a file; the fence checks it; a token is minted; the URL that comes
 * back is the only way to reach those bytes. Nothing is guessable, and rewriting
 * relative paths at render time — the obvious alternative — was rejected in D-83
 * precisely because it would turn any string in a model's prose into a file
 * read, at a moment when model prose is partly attacker-influenced (page content
 * arrives through `browser_snapshot`).
 *
 * **A pointer, never a snapshot** (Joshua's call): the entry records where the
 * file was, not what was in it. So an old conversation serves the *current* file
 * or a 404, and the append-only log does not grow by 4/3 × filesize forever —
 * which is P8c's unpaid bill, and not one to take out a second loan against.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { newId } from "../util/id.js";
import { classifyFile, humanBytes } from "./media.js";
import type { SharedFile } from "../conversation/types.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/**
 * The largest file this will hand to a browser. Not a security boundary — the
 * fence is that — just the point past which a "look at this" is not what is
 * happening: every byte is hashed at mint time and then pushed down a socket to
 * a tab. Images are hundreds of KB; a log worth reading is smaller still.
 */
export const MAX_SHARE_BYTES = 25 * 1024 * 1024;

/** Markdown keeps its own type (Joshua's call); every other text file is served
 *  as `text/plain`, which is also what makes SVG inert — `media.ts` classifies
 *  it as text (D-78b), so it can never come back as active content. */
const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown", ".mkd"]);

/** What the fetch route will send for a file that classified as text. */
export function textMimeFor(filePath: string): string {
  return MARKDOWN_EXTS.has(path.extname(filePath).toLowerCase()) ? "text/markdown" : "text/plain";
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** `/conversation/<id>/file/<token>/<index>` — the shape the server serves and
 *  the only thing the agent is ever told. Root-relative on purpose: it resolves
 *  against whatever origin the browser already has, so it survives a session
 *  reached over a tunnel as readily as one on localhost. */
export function fileUrl(conversationId: string, token: string, index: number): string {
  return `/conversation/${encodeURIComponent(conversationId)}/file/${encodeURIComponent(token)}/${index}`;
}

/**
 * Classify one path for sharing. Returns the metadata to record, or the reason
 * it cannot be shared — named, because a refusal a model cannot act on is just a
 * failed call it will retry.
 */
async function describe(
  input: string,
  token: string,
  ctx: ToolContext,
): Promise<{ ok: true; file: SharedFile } | { ok: false; reason: string }> {
  const r = ctx.sandbox.resolve(input);
  if (!r.ok) return { ok: false, reason: r.reason };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(r.path);
  } catch {
    return { ok: false, reason: `${input}: no such file` };
  }
  if (!stat.isFile()) return { ok: false, reason: `${input} is not a regular file` };
  if (stat.size > MAX_SHARE_BYTES) {
    return { ok: false, reason: `${input} is ${humanBytes(stat.size)}, over the ${humanBytes(MAX_SHARE_BYTES)} limit` };
  }
  // Bytes decide, never the extension (D-78b) — a `.png` holding text is text,
  // and a screenshot named `.txt` is still an image.
  const kind = await classifyFile(r.path);
  if (kind.kind === "binary") {
    const named = kind.mime ? `a binary file (${kind.mime})` : "not text and not an image";
    return { ok: false, reason: `${input} is ${named} — only images and text files can be shown` };
  }
  const mime = kind.kind === "image" ? kind.mime : textMimeFor(r.path);
  return {
    ok: true,
    file: {
      token,
      path: input,
      resolved: r.path,
      fenceRoot: ctx.sandbox.primary,
      mime,
      bytes: stat.size,
      sha256: sha256(r.path),
    },
  };
}

export function fileUrlTool(): Tool {
  return {
    name: "file_url",
    kind: "read",
    mutates: false,
    pathArgs: ["paths"],
    def: {
      type: "function",
      function: {
        name: "file_url",
        description:
          "Get URLs for files in the workspace so you can show them to the user in your reply. Put a " +
          "returned URL in markdown — ![caption](url) for an image, [caption](url) for a text file — and " +
          "it renders in their browser. The file's contents do NOT come back to you and you do not see " +
          "them: use read_file when you need to look at something yourself. Images, text and markdown " +
          "only. Never invent one of these URLs; only ones this tool returned will work.",
        parameters: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Workspace-relative or absolute paths to make viewable",
            },
          },
          required: ["paths"],
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const raw = args.paths;
      const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
      if (paths.length === 0) return { content: "file_url requires 'paths': an array of file paths", isError: true };
      if (!ctx.conversationId) {
        // Only reachable from an embedding that runs tools outside a conversation.
        // Saying so beats minting a URL that addresses nothing.
        return { content: "file_url is not available in this context (no conversation to address).", isError: true };
      }
      const token = newId("fu");
      const files: SharedFile[] = [];
      const lines: string[] = [];
      for (const p of paths) {
        const r = await describe(p, token, ctx);
        if (!r.ok) {
          lines.push(`- ${r.reason}`);
          continue;
        }
        // The index is the file's position in `files`, which is what the route
        // indexes into — so it must be taken after the push decision, not from
        // the input list, whose failures leave holes.
        lines.push(
          `- ${r.file.path} → ${fileUrl(ctx.conversationId, token, files.length)}  (${r.file.mime}, ${humanBytes(r.file.bytes)})`,
        );
        files.push(r.file);
      }
      if (files.length === 0) return { content: `No files could be shown:\n${lines.join("\n")}`, isError: true };
      const shown = files.length === 1 ? "1 file is" : `${files.length} files are`;
      return {
        content: `${shown} now viewable. Put these URLs in your reply to show them:\n${lines.join("\n")}`,
        files,
      };
    },
  };
}
