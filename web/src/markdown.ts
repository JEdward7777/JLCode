/**
 * Markdown → sanitized HTML for assistant messages. `marked` renders, DOMPurify
 * scrubs — the agent's output is untrusted content on a page that will later be
 * auth'd/remote (P5f), so we sanitize from the start. Mermaid + inline images
 * (richer rendering) arrive in P5d.
 */
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
