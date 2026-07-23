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

---

## P5b — interactive gating in the browser · 2026-07-23 · ✅ looked good

**Screenshots:** [`visual/p5b-approval.png`](visual/p5b-approval.png) ·
[`visual/p5b-ask.png`](visual/p5b-ask.png) ·
[`visual/p5b-fence.png`](visual/p5b-fence.png) ·
[`visual/p5b-e2e-done.png`](visual/p5b-e2e-done.png)

Drove the built server with the new **fake agent driver** (`JLCODE_FAKE_LLM=1`,
isolated config/data dirs) — it turns prefixes in a message into real tool calls
(`write:` / `run:` / `ask:` / `form:`), so the gated flows run end-to-end offline
with no key/spend. Seeded each surface over the HTTP API, then screenshotted via
CDP. Confirmed with my own eyes:

- **Header mode/approval controls** — the `ask · plan · code` segmented control
  (Code active) and the approval-policy dropdown (`manual`) render in the top bar
  on every surface. Flipping them POSTs `/session/:id/mode`; the session re-gates
  live and the choice is persisted as the config default (Joshua's call).
- **Approval card, hybrid editor (D-16)** — `write_file` with a red **WRITE**
  capability badge, the reason, a prominent editable **`path`** primary field, a
  collapsible **raw args (JSON)** box, and **Approve / Deny**. The composer
  placeholder switches to "Respond to the agent above…" and Send is disabled
  while a prompt is open.
- **Soft-fence out-of-fence prompt (D-19)** — writing to `/tmp/…` (outside the
  fence) shows the ⚠ "outside the workspace fence" note with the offending path
  and the three choices: **Allow once**, **Remember `/tmp`** (the suggested root
  in a code chip), **Deny**.
- **Multi-question ask_user form (D-18)** — three fields with header chips
  (STORE / TARGETS / NOTES), option pills, a "choose any" hint on the multiSelect
  field, free-text inputs where allowed, and a single **Submit**.
- **End-to-end gated work from the browser** (P5b "done when") — typed
  `write: from-browser.txt | …` into the composer, pressed Enter, the approval
  card appeared, clicked **Approve**; the file was **written to disk** (verified)
  and the assistant's final answer streamed in. A tool-call-only turn no longer
  renders an empty bubble.

Not yet exercised visually (later slices): live spend/cost + cap, queued message,
background-task kill, global stop (P5c); branch nav / journal / Mermaid / images /
TTS (P5d); multi-session UI (P5e); auth (P5f).
