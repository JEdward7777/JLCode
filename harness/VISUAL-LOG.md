# JLCode — Visual Verification Log

Tests catch regressions, but a test with more mocks than target code can pass
while the real thing is broken or ugly. So for anything with a rendered surface
(the browser frontend, §11), we **look at it in a real browser at least once**
per slice and record it here — what we loaded, what we confirmed with our own
eyes, and a screenshot. This complements the automated tests; it does not
replace them.

**How the peeks are driven** (no extra deps, D-25): run the built server with the
fake echo driver (`JLCODE_FAKE_LLM=1`, isolated `JLCODE_CONFIG_DIR`/`JLCODE_DATA_DIR`,
no real key/spend), seed a conversation over the HTTP API, then screenshot the
page via Chrome's DevTools Protocol (`--remote-debugging-port` + a tiny
`WebSocket` client). Chrome's `--virtual-time-budget` screenshot stalls on the
long-lived SSE connection, so CDP with a real wait is the reliable path.

---

## P5a — transport + streaming chat · 2026-07-23 · ✅ looked good

**Screenshot:** [`visual/p5a-chat.png`](visual/p5a-chat.png)

Loaded `/?session=<id>` for a seeded conversation (fake echo driver). Confirmed
with my own eyes:

- **Layout renders** — "JLCode" header, right-aligned user bubble, left assistant
  bubble, composer with placeholder + Send button; dark theme intact.
- **SSE connected** — the header status dot is green (the `ready` frame arrived;
  the browser is subscribed to the live event stream).
- **Deep-link history loads** — the page reconstructed the prior turn from
  `GET /session/:id` on load (not just live deltas).
- **Markdown pipeline works** (marked → DOMPurify) — the assistant reply rendered
  `- alpha` / `- beta` as a real bullet list and `inline code` as monospace. (The
  `## Hello` stayed inline because it followed "You said:" on the same line —
  correct markdown, not a bug.)
- **Reasoning disclosure** — the echo driver's reasoning shows as a collapsible
  "reasoning" `<details>` above the answer.

Not yet exercised visually (later slices): live token-by-token streaming *as it
arrives* (only the settled result was captured here), approvals/ask_user (P5b),
cost/controls (P5c), branch nav / journal / Mermaid / images / TTS (P5d).
