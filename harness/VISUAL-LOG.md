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

---

## P5c — cost & interruption control · 2026-07-23 · ✅ looked good

**Screenshots:** [`visual/p5c-spend-cap.png`](visual/p5c-spend-cap.png) ·
[`visual/p5c-tasks-queue.png`](visual/p5c-tasks-queue.png) ·
[`visual/p5c-stop-menu.png`](visual/p5c-stop-menu.png) ·
[`visual/p5c-cap-reached.png`](visual/p5c-cap-reached.png)

Drove the built server with the fake driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs, **full-auto** so `run_command` runs without a gate). The fake
driver now emits token usage, and the peek config carries fallback **pricing**
($3 / $60 per Mtok), so spend is real. Seeded each surface over the HTTP API and
screenshotted via CDP. Confirmed with my own eyes:

- **Whole-tree spend in the corner (D-33)** — after two turns the chip reads
  **`$0.0127`**; clicking it opens the cap popover (input + Set / Clear). Spend
  is priced from token usage × the config's fallback pricing (the fake driver
  reports no API `cost`).
- **Settable cap + breach (D-33)** — with a tiny cap set, a tool turn that
  crosses it turns the chip **red** (`$0.0042 / $0.00`) and drops a banner:
  "Spend cap reached … The agent stopped before the next model call; **nothing
  was killed**," with **Double the cap** / **+$1.00** to raise-and-resume —
  exactly Joshua's "don't kill anything, just don't make another LLM call."
- **Background-task list + kill (D-34)** — `run: sleep 30` shows a **background
  tasks** card ("running · killable") with the command, a live elapsed counter,
  and a red **Kill**. The 30s timeout is gone; the child is its own process
  group, so Kill / global Stop take the whole tree.
- **Queued message (D-34)** — typing while a command runs flips the composer to
  **Queue** ("Enter to queue"); the message parks as a **QUEUED** chip with an
  **✕** to cancel, and applies at the next turn boundary (it did **not** barge
  into the running turn — `send()` now refuses a busy session).
- **Global stop, two-mode (D-34)** — a red **◼ Stop** (hard: abort the LLM +
  kill tasks + clear the queue) with a **▾** caret opening **"Stop LLM loop
  only — let running commands finish; take no further turn"** (soft), matching
  Joshua's dropdown ask.

Fixed while peeking: `pricing` was dropped by the config-store loader (spend read
$0.0000 until `normalizeModelConfig` carried it through); and `send()` now
refuses a running session so a mis-timed Send can't re-enter the loop (the UI
queues instead once anything is busy).

Not yet exercised visually (later slices): the watchdog's 30-min out-of-band kill
prompt (covered by tests; impractical to screenshot); branch nav / journal /
Mermaid / images / TTS (P5d); multi-session UI (P5e); auth (P5f).

---

## P5d — branching, journal & rich rendering · 2026-07-23 · ✅ looked good

**Screenshots:** [`visual/p5d-rich.png`](visual/p5d-rich.png) ·
[`visual/p5d-branches.png`](visual/p5d-branches.png) ·
[`visual/p5d-journal-drawer.png`](visual/p5d-journal-drawer.png)

Drove the built server with the fake driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs, full-auto). A new **`demo`** prefix in the fake driver returns
a rich-markdown reply (heading / list / inline PNG data-URI / mermaid graph), and
I seeded a **branch** by sending a message, edit-forking the user turn, then
rewinding to branch A. Screenshotted via CDP (forcing the hover-only `.msg-tools`
visible so the per-message buttons show). Confirmed with my own eyes:

- **Rich rendering (§11)** — the assistant reply renders the `## heading`, the
  bullet list with **bold** / `inline code` / a link, a real **inline image**
  (the red PNG, rounded via `.markdown img`), and a **Mermaid** flowchart
  (User → JLCode → Sandbox / Browser) — the *actual* mermaid library, loaded as
  a separate lazy chunk (D-42a/b). No network; all offline.
- **Branch arrows + pencil (D-10/D-17)** — the user message "What is a monad?"
  shows **‹ 1/2 ›** (we're on branch A of the two siblings from the edit-fork)
  and a **✎** to edit-and-fork again. The arrows POST `/rewind` to
  `leafOf(sibling)`; the pencil opens an inline editor → `/edit`.
- **Per-turn journal (D-15)** — the **ⓘ** on the assistant reply expands that
  turn's debug record inline: `LLM fake/model · 0ms · 2 msgs · stop`, the tool
  list, `tokens: 1000→26`, and the reasoning/text previews. It's tied to the
  turn by the new `entryId` on each record.
- **Journal drawer (D-15)** — the header **journal** button opens a slide-over
  listing the **whole conversation's** records (here both branches: `↳ You said:
  What is a monad?` and `↳ You said: Explain monoids instead`), each grouped
  under its turn, with a reload ↻ and close ✕.
- **TTS (§11)** — the **🔊** button sits on each assistant reply (audio can't be
  screenshotted; it toggles `speechSynthesis` speak/stop).

Not exercised visually (covered by tests / later): the actual branch *switch* and
pencil-edit round trips (fork-rewind + server tests); multi-session UI (P5e);
auth (P5f).
