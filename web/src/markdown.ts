/**
 * Markdown → sanitized HTML for assistant messages, plus rich rendering (P5d,
 * §11). `marked` renders, DOMPurify scrubs — the agent's output is untrusted
 * content on a page that will later be auth'd/remote (P5f), so we sanitize from
 * the start. Inline images are allowed (http/https/data); ```mermaid fences are
 * left as `<code class="language-mermaid">` markers and turned into diagrams
 * after mount by `renderMermaid` (the real mermaid library, lazy-loaded so a
 * diagram-free page never pays for it).
 */
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

// Allow inline images (the agent may embed screenshots/diagrams) with safe
// schemes only. `<img>` is default-allowed; we keep DOMPurify's default URI
// policy, which permits http/https and data: image URIs but blocks javascript:.
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/** True if a rendered fragment contains at least one mermaid code block. */
export function hasMermaid(html: string): boolean {
  return html.includes("language-mermaid");
}

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

/** Lazy-load + init mermaid once (strict security for untrusted agent input). */
async function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      const dark = window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "default" : "dark";
      m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark });
      return m.default;
    });
  }
  return mermaidReady;
}

let mermaidSeq = 0;

/**
 * Turn any `pre > code.language-mermaid` blocks under `root` into rendered SVG.
 * Idempotent: a processed block is marked so re-renders skip it. Render failures
 * leave the source visible with an error note rather than throwing.
 */
export async function renderMermaid(root: HTMLElement): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("code.language-mermaid")).filter(
    (el) => !el.dataset.mermaidDone,
  );
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  for (const code of blocks) {
    const pre = code.closest("pre") ?? code;
    const source = code.textContent ?? "";
    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, source);
      code.dataset.mermaidDone = "1"; // only on success, so a partial block can retry
      const fig = document.createElement("figure");
      fig.className = "mermaid";
      fig.innerHTML = svg; // mermaid strict-mode output is already sanitized
      pre.replaceWith(fig);
    } catch (err) {
      const note = document.createElement("div");
      note.className = "mermaid-err";
      note.textContent = `mermaid: ${(err as Error).message}`;
      pre.after(note);
    }
  }
}
