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

---

## P5e — concurrent sessions (the "bag of agents") · 2026-07-24 · ✅ looked good

**Screenshots:** [`visual/p5e-multi-approval.png`](visual/p5e-multi-approval.png) ·
[`visual/p5e-multi-chat.png`](visual/p5e-multi-chat.png)

Drove the built server with the fake agent driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs) and seeded **three live sessions** in distinct states over the
HTTP API, then screenshotted via CDP. All three ride **one multiplexed `/events`
stream** (D-43). Confirmed with my own eyes:

- **Left rail of live sessions (D-43)** — three cards, each with the model
  (`fake/echo-model`), a status dot, live spend (`$0.0000` — the fake driver has
  no API cost and this peek config carries no fallback pricing; spend accrual is
  covered by the P5c tests), and the mode (`CODE`). The focused card has the
  accent border. A **+ New** sits at the top; a **✕** closes each card.
- **Distinct per-session badges, live in the background** — session A **idle**
  (grey dot), session B **needs approval** (amber dot), session C **working…**
  (blue dot — it has a `sleep 40` running under full-auto). Crucially, in the
  second shot I focused A and **B and C kept their amber/blue badges** — the
  background slices stay current off the multiplexed bus while another session is
  focused (the whole point of the fan-in).
- **Focus swaps the pane** — focusing B shows its `write_file` **approval card**
  (WRITE badge, editable `path`, Approve/Deny) and the composer reads "Respond to
  the agent above…" with **Queue**; focusing A shows its clean reply ("You said:
  …") with the per-message TTS/ⓘ tools and the composer back to "Message JLCode…"
  with **Send** (A is idle, so it takes a fresh send; B is blocked, so it queues).
- **Header controls are per-focused-session** — journal, spend chip, Stop (+ soft
  caret), the ask/plan/code segmented control, and the approval dropdown all bind
  to whichever session is focused.

Close-to-stop (the ✕: hard-stop + drop from the bag + `session-removed`) is
covered by the server tests; the removed-frame → drop-tab → refocus path is the
client reducer's `removed` case (Tier-0). Not exercised visually (later): auth
(P5f).

---

## P5f — serve modes & auth (D-40) · 2026-07-24 · ✅ looked good

**Screenshots:** [`visual/p5f-login.png`](visual/p5f-login.png) ·
[`visual/p5f-authed-app.png`](visual/p5f-authed-app.png)

Ran the built server **bound outward** (`serve --host 0.0.0.0 --generate-password`,
`JLCODE_FAKE_LLM=1`, isolated config/data dirs) so the auth guard is active, then
drove Chrome via CDP. The launch banner printed **`AUTH ON (outward bind)`** with
the generated password and a **one-hit sign-in URL** (`/?token=…`). Confirmed with
my own eyes:

- **Login page (unauthenticated)** — navigating to `/` with no cookie serves the
  self-contained sign-in card ("JLCode", a password field, **Sign in**), light/dark
  aware, centered. This is the guard returning the login HTML (with a 401) for a
  browser navigation rather than leaking the app.
- **One-hit URL logs in** — visiting the printed `/?token=…` set the **httpOnly
  session cookie** (303 → clean `/`) and the **full app loaded authenticated**: the
  green SSE status dot (the live `/events` stream connected *carrying the cookie*),
  the left rail, and the seeded conversation ("Hello from behind auth!" → "You said:
  …"). So the cookie authorizes SSE + every API call, not just the first page.
- **The guard actually guards (not just the UI)** — probed server-side during the
  peek: an in-browser (cookie-bearing) `GET /health` returned **200**, while the
  same endpoint hit from Node **without** the cookie returned **401**, and a
  `POST /auth/login` with the wrong password returned **401**. Nothing sensitive is
  served unauthenticated when bound outward.

Not exercised visually (covered by `test/auth.test.ts`): the one-hit token being
**single-use** (a second exchange 401s), cookie **tamper/expiry** rejection, scrypt
hash verify, and that a **localhost bind serves auth-free** (no guard installed).

---

## P6c — compaction trigger-mode UX · 2026-07-24 · ✅ looked good

**Screenshots:** [`visual/p6c-cancelable-pause.png`](visual/p6c-cancelable-pause.png) ·
[`visual/p6c-suggest-banner.png`](visual/p6c-suggest-banner.png)

Drove the built server with the fake driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs) and a **tiny context window** (`compaction.contextLength: 1500`,
`bufferTokens: 1000` → threshold 500) so any turn crosses the budget without a
key/spend. Seeded the two blocking/non-blocking surfaces over the HTTP API and
screenshotted via CDP. Confirmed with my own eyes:

- **Header trigger-mode selector (D-27)** — a new dropdown sits after the approval
  policy: **`compact: cancelable`** in the first shot, **`compact: suggest`** in the
  second. Switching it POSTs `/session/:id/trigger-mode`; the session re-resolves
  live and it's persisted as the config default (like mode/approval).
- **`cancelable` pre-send pause** — after the budget crossed on turn 1, sending a
  second message **held the turn** and raised the **"context nearly full — compact to
  continue?"** card: the token detail ("~1,052 tokens, 70% of the window"),
  **Compact & continue** (primary) + **Skip once**. The composer correctly flipped to
  **"Queue a message for the next turn…"** with a **Queue** button — the pause blocks
  a fresh Send, exactly like an approval/ask pause.
- **`suggest` banner (non-blocking)** — the same budget crossing in suggest mode
  showed the **"◆ Context is getting large — compacting will keep replies fast and
  in-window."** banner with **Compact now**, but the reply still came through and the
  composer stayed in normal **Send** mode — confirming suggest never gates the loop.

Not exercised visually (covered by tests / headless): `auto` (silent, P6b),
`hard` (Compact-only card — same component, `cancelable:false`), `manual` (the
header **compact** button), the actual compact round-trip, and the cross-model
summary path (`test/compaction-p6c.test.ts`, `test/server-p6c.test.ts`).

---

## D-46 — persistence-fault banner (closes H-01) · 2026-07-25 · ✅ looked good

**Screenshot:** [`visual/d46-persistence-fault.png`](visual/d46-persistence-fault.png)

Drove the built server with the fake driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs), sent one turn that saved normally, then **made that
conversation's log read-only** (`chmod 400 cv_….jsonl`) — a real EACCES on
`open(…, "a")`, the stand-in for a full disk — and sent a second turn. Confirmed
with my own eyes:

- **The session stops instead of drifting** — `/chat` returned
  `status: "awaiting-persistence"` with `pending: 2`, and the blocking
  **"⚠ can't save this conversation / stopped"** card rendered: the filename, the
  errno reason, "2 records are queued and unwritten", and what to do about it.
- **The composer is gated** — it flipped to **"Queue a message for the next turn…"**
  with a **Queue** button, exactly like an approval/ask pause. No fresh Send while
  records are unwritten.
- **The rail agrees** — the session card shows **`can't save`** with the red
  (halt) dot rather than a stale "idle".
- **Retry while still broken fails honestly** — clicking **Retry save** with the
  file still read-only kept the banner up and flipped its header to
  **`retry failed`**. It does not pretend to have saved.
- **Retry after fixing it recovers fully** — `chmod 600` (the "freed up disk
  space" moment) then **Retry save**: banner gone, rail back to **idle**, composer
  back to **"Message JLCode…"** with **Send**.
- **The records actually landed, in order** — read the JSONL back afterwards:
  header → user → assistant → user → assistant, **no dangling `parent`**. This is
  the point of stalling at the head rather than draining past a failure.

**Two defects this peek caught that the tests had not:** (1) the banner dumped the
full absolute path (already shown as the filename) and wrapped three lines — now
trimmed to the errno reason, with the path on a `title` tooltip; (2) the rail
badge read **`idle`** during a fault, because `statusLabel`/`dotClass` didn't know
about it. Also corrected the *tests*: they jammed the **directory**, which only
blocks *creating* a file — so they were passing on a timing accident (the header
not yet flushed). Jamming the **file** is deterministic, and that is what the
suite does now.

Not exercised visually (covered by tests): the discard path's confirm step
("Continue without saving…" → "Really discard N?"), a fault on the shared
`index.jsonl`, and journal-write failures (warn-only, they never stop a session).

---

## P7b — the MCP learn-on-pause card + status drawer · 2026-07-28 · ✅ looked good

**Screenshots:** [`visual/p7b-learn-card.png`](visual/p7b-learn-card.png) ·
[`visual/p7b-learn-answered.png`](visual/p7b-learn-answered.png) ·
[`visual/p7b-mcp-drawer.png`](visual/p7b-mcp-drawer.png)

Drove the built server against the **real stdio MCP fixture server**
(`test/fixtures/mcp-test-server.mjs`, spawned by the manager from an isolated
`mcp_settings.json`) with the fake agent driver — which gained an `mcp: <tool>
<json>` prefix so a bridged call can be triggered by hand offline. Sent
`mcp: testsrv__echo {"text":"…","note":"/etc/hosts"}` — a tool with no
`readOnlyHint` (presumed to write) and an unclassified slashy arg pointing
outside the fence, so every D-48 question fires at once. Confirmed with my own
eyes:

- **One card, both guesses.** The approval card shows the tool, the `COMMAND`
  class, the raw args, then *"JLCode guessed conservatively here — settle it once
  and it won't ask again"* with **Does `testsrv__echo` write anything?**
  (writes / read-only) and **Is `note` a file path?** — the offending value
  (`/etc/hosts`) shown beside it — plus the fence block below.
- **The answers change the card, live.** Clicking *just text* retires the fence
  section entirely and the buttons collapse from **Allow once / Remember /etc /
  Deny** to plain **Approve / Deny** — a field the user just called prose no
  longer widens the fence. (That's why `outOfFence` now carries the arg name per
  escape.)
- **Answering sticks, on the real file.** Clicking through Approve wrote
  `notPathFields: [text, note]` and `readTools: [echo]` into the actual
  `mcp_settings.json`, and the tool ran (*"Done — the tool ran and reported
  back."*).
- **Asked once, then never.** The identical call a second time returned
  `status: idle` with no pause at all — no fence prompt, no approval prompt.
  `jlcode mcp list --probe` agrees: `testsrv__echo [read]`.
- **The MCP drawer reads true.** The `mcp` header button opens a read-only
  drawer: `connected  testsrv  global`, each tool with its live class
  (`echo READ`, `peek READ`, `touch_file COMMAND presumed`), the learned lists
  (`paths`, `not paths`, `read-only`), and both settings-file paths. The amber
  **presumed** tag marks the classes that are still JLCode's guess.

Not exercised visually (covered by tests): the Ask-mode variant of the card
(the *"No — it only reads / Yes — it writes"* pair), a failed server's error row
in the drawer, and the workspace-scoped settings file.

---

## X-11 — tool output in the transcript · 2026-07-28 · ✅ looked good (one defect caught)

**Screenshots:** [`visual/x11-tool-collapsed.png`](visual/x11-tool-collapsed.png) ·
[`visual/x11-tool-expanded.png`](visual/x11-tool-expanded.png)

Drove the built server with the fake agent driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs, a scratch workspace) under **`full-auto`** so the calls run
without a pause — the point being what you can read *after* the approval card is
gone. Seeded four turns: `run: ls -la`, `read: src/index.ts` (success),
`read: nope/missing.txt` (error), and a deliberately **very wide** `printf` +
`ls -la src`. Confirmed with my own eyes:

- **A tool block sits in flow** between the turn that called it and the turn that
  talks about it (Joshua's call), collapsed to one line: caret, monospace tool
  name, the argument gist (`read_file src/index.ts`), and a size hint
  (`2 lines · 40 B`) right-aligned.
- **Errors read as errors** — red left rule and a red `ERROR` chip on the failed
  `read_file`, distinct from the amber rule of a normal call.
- **Expanded shows both halves** — the pretty-printed arguments above the **full**
  output (not the journal's 200-char preview), monospace, on its own panel.
- **A wide line scrolls the box, never the page** — measured, not eyeballed:
  with everything expanded the widest output box is `scrollWidth 1312` vs
  `clientWidth 847`, while `document.documentElement.scrollWidth ===
  clientWidth === 1280`. No horizontal page scroll.
- **A bare tool-call turn still draws no empty bubble** — the block carries it.

**The defect this peek caught that the tests could not:** every block rendered as
a **1px hairline**. `.thread` is a flex column, and a child whose contents scroll
has nothing to hold its height open — it shrank to nothing. `flex: none` on
`.tool-block` fixes it. A pure-function test suite would never have seen this.
Also corrected on sight: the size hint counted a trailing newline as a line, so a
two-line file read "3 lines".

Not exercised visually (covered by tests): the live path (a block appearing as
the turn streams — the same `entryView` shape now goes over SSE), and an empty
result rendering as `(no output)`.

---

## X-10 — the served workspace in the rail + tab title · 2026-07-28 · ✅ looked good

**Screenshot:** [`visual/x10-workspace.png`](visual/x10-workspace.png)

Ran a second instance from a *different* directory (`~/work2/general/JLCode-peek`,
fake driver, isolated dirs) — the actual complaint being that two projects'
tabs are indistinguishable. Read back from the live page via CDP:

- **`document.title` → `JLCode-peek`** — the **project folder**, which is the
  point: the tab used to say "JLCode", the name of the tool, on every instance.
- **Rail header → `~/work2/…/JLCode-peek`** — under the brand, monospace, muted;
  home collapsed to `~` and the middle elided so it fits the narrow rail.
- **Hover title → `/home/lansford/work2/general/JLCode-peek`** — the full path is
  still there, one hover away.

Not exercised visually (covered by tests): the no-home / short-path forms of the
abbreviation, and the `<label> — <folder>` tab composition (X-09 supplies the
label).

---

## X-09 — conversation labels in the rail + tab title · 2026-07-28 · ✅ looked good (one UX fix)

**Screenshots:** [`visual/x09-labels.png`](visual/x09-labels.png) ·
[`visual/x09-rename.png`](visual/x09-rename.png)

Two live sessions in the `JLCode-peek` instance (fake driver, isolated dirs).
The fake agent driver gained an answer for the **ephemeral auto-title question**
so labels can be peeked at offline — it replies with a few words off the opening
message instead of echoing the ask. Renaming was driven with **real** input
events (CDP `Input.insertText` + a genuine Enter key), not synthetic DOM events,
so React's controlled input was exercised the way a person exercises it.
Confirmed with my own eyes and read back from the page:

- **Both cards carry a label** instead of the same `fake/model` twice —
  `Src/index.ts` and `Why does compaction drop the` — with the model still on
  the hover title, and ✎ / ✕ appearing on hover like the existing close button.
- **The tab composes both features** — `document.title` reads
  `Src/index.ts — JLCode-peek`: what this thread is (X-09), in which project (X-10).
- **Rename is live and durable** — typed a new name, pressed Enter: the card
  updated, the tab title followed within the same tick, and
  `GET /conversations` (read from `index.jsonl`) already agreed. **Restarted the
  server** and the labels came back from disk.
- **A hand-picked name pins** — sent another turn on the renamed thread; it kept
  the manual name, no re-title.

**The UX gap this peek caught:** clicking ✎ pre-filled the field but did not
select it, so typing *appended* to the old name (`…drop theProvider pin…`) —
exactly what a real rename never wants. `onFocus → select()` fixes it; clicking
into the text still places the caret for an edit.

Not exercised visually (covered by tests): Escape-to-cancel, the empty-rename
rejection, and the auto-title's one-attempt-per-session guard.

---

## D-51 — a remark rides along with the approval decision · 2026-07-28 · ✅ looked good

**Screenshots:** [`visual/d51-note-typed.png`](visual/d51-note-typed.png) ·
[`visual/d51-note-landed.png`](visual/d51-note-landed.png)

Drove the built server with the fake agent driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs, `manual` approval), seeded a `write:` turn so a real
`write_file` approval card came up, then typed into the composer and clicked
**Approve** — via CDP, reading the page back afterwards. Confirmed with my own
eyes:

- **The composer is open while the card is up**, and its placeholder now says what
  the text will do: *"Say something with your decision — it goes in with
  Approve/Deny…  (Enter queues it for later instead)"*. Both outlets are named, so
  the queue doesn't silently lose its meaning.
- **Typed "Yes, but call it deploy-notes.txt and tell me what you find."** with the
  approval card still showing `write_file` / **WRITE** / editable `path` /
  Approve · Deny — the two coexist, nothing is disabled or greyed.
- **Clicking Approve landed the remark in the transcript** as an ordinary
  right-aligned user bubble, *below* the `write_file` tool result — the order the
  wire requires — and the composer cleared itself back to the normal
  "Message JLCode…" placeholder.
- **The agent actually saw it**: the fake driver's next turn echoed
  "You said: Yes, but call it deploy-notes.txt and tell me what you find." So the
  note is in the replayed window on the *very next* call, not a turn boundary later
  the way a queued message would have been.

Not exercised visually (covered by tests): the deny path, the trimming, and the
hold-until-the-batch-drains ordering with two tool calls in one assistant message.

---

## D-52 — a queued message is consumed mid-run · 2026-07-28 · ✅ looked good

**Screenshots:** [`visual/d52-queued-chip.png`](visual/d52-queued-chip.png) ·
[`visual/d52-queued-consumed.png`](visual/d52-queued-consumed.png)

Fake agent driver, isolated dirs, `full-auto` so the run proceeds unattended.
Started a long turn from the composer (`run:sleep 8` → a real backgrounded
command), then typed a second message *while it ran* and clicked **Queue** —
driven through the page, not the API. Confirmed with my own eyes:

- **While running**, the composer is in queue mode ("Queue a message for the next
  turn…  (Enter to queue)", Queue button), the **background tasks** card shows
  `sleep 8` with a live elapsed counter and a **Kill** button, and the queued
  message sits above the composer as a `QUEUED` chip with its ✕.
- **At the tool-loop boundary the chip cleared on its own** — no reload, no
  further input — and the message appeared in the transcript as a normal user
  bubble **directly under the `run_command` result**, which is the boundary D-52
  moves it to.
- **The model answered it in the very next turn**: the fake driver replied
  "You said: Probably should rebase things as well." Before this fix that reply
  could not have come until the whole run had settled.
- Read back from the page: `entries` = `user assistant tool user assistant`, and
  `document.querySelector('.queue')` → gone.

This is the exact message text from Joshua's stuck live session, used deliberately
so the peek reproduces the reported symptom rather than a synthetic stand-in.

Not exercised visually (covered by tests): the multi-message flush at one boundary,
and the hold-behind-a-soft-stop.

---

## X-12a — the browser history list · 2026-07-31 · ✅ looked good

**Screenshots:** [`visual/x12-rail.png`](visual/x12-rail.png) ·
[`visual/x12-peek.png`](visual/x12-peek.png) ·
[`visual/x12-promoted.png`](visual/x12-promoted.png)

Fake agent driver, isolated config/data dirs, server fenced to a scratch
workspace. Seeded four threads (one with a real `editFork` branch), then **shut
the server down and started a new process** — so every thread was genuinely
history, loaded from disk, with nothing live. Drove the rest through the page.
Confirmed with my own eyes:

- **The rail carries both lists.** `▾ LIVE 1` over `▾ HISTORY 4`, each with its
  own scroller. Titles come from X-09 (`How should I structure the`), and a
  thread recorded before it had one falls back to its short id (`cv_d4d01b768`) —
  old logs stay untitled rather than being back-filled.
- **A peek is read-only and creates nothing.** Clicking a row swapped the pane to
  a `HISTORY`-badged transcript with the thread's title and its `workingDir`; the
  rail's live card stayed exactly where it was, `GET /sessions` still reported
  the one auto-created session, and the **pencil is absent** on user messages
  (edit-fork is a write with nothing to write into).
- **Branch arrows walk locally.** Stepped `2/2 → 1/2` in the peek: the transcript
  swapped to the other branch (4 messages instead of 2) while the conversation's
  **`activeLeaf` on disk never moved** — a peek writes nothing, not even an
  `active-leaf` record.
- **Typing is the promotion, and it continues the branch you're looking at.**
  Typed into the peek composer (real CDP `Input.insertText`) while viewing branch
  1/2 and sent: the peek closed, **LIVE went 1 → 2 and HISTORY 4 → 3** — the
  thread moved across the divider, which is the "closing a session leaves it
  recoverable" story told without words — and the new turn landed on the *viewed*
  branch (checked on disk: the new entry's parent is that branch's tip, not the
  persisted leaf).
- **`all folders` works.** A thread seeded from a second server in a different
  directory was correctly absent from the default list and appeared under the
  toggle, tagged `otherproj` against the local rows' `work`.
- **A stale tab heals.** Restarted the server under the open page: the roster
  reset to zero, the transcript pane fell back to "No session open" with **no
  ghost approval card**, and every thread — including the two that had been live
  — appeared under HISTORY. Reopening one from the list and typing continued it
  across the process boundary.
- **Sections collapse and the split persists.** `▸ LIVE 2` collapses to its
  header (count still visible) and history takes the rail; both flags and the
  divider position survive a reload via `localStorage` (the X-12 prefs helper).
- **The divider appears only when it can do something.** With one live card the
  section shrinks to fit and there is no grip; at three cards against a 170px cap
  the grip appears, the live list scrolls, and dragging it (real CDP mouse
  press/move/release) moved the cap and stored it. **Fixed while looking:** the
  first cut held a fixed 240px band of empty rail above HISTORY, and the second
  showed a grip that couldn't move anything — both only visible in a browser.

Not exercised visually (covered by tests): the attach-don't-duplicate path for
two tabs reviving one conversation at once, the symlinked-`workingDir` filter
fix, and the pre-H-04 `Invalid signature` card (no such log exists to hand — the
guard is wired to the `/chat` error and unit-tested through its trigger string).

---

## D-53 — `apply_edits` unified-diff approval card · 2026-07-31 · ✅ looked good

**Screenshots:** [`visual/d53-apply-edits-diff.png`](visual/d53-apply-edits-diff.png) ·
[`visual/d53-apply-edits-cannot-apply.png`](visual/d53-apply-edits-cannot-apply.png)

Drove the built server with the fake agent driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs, throwaway workspace) using its new **`edit:`** prefix, so a real
`apply_edits` batch reaches the approval pause with no key/spend. Confirmed with my
own eyes:

- **The diff is the card.** A two-file batch (a method added to `store.py`, a line
  added to `NOTES.md`) renders as a real unified diff — `2 files +6 −0` in the
  header, then per-file rows `store.py +5 −0 1 site` / `NOTES.md +1 −0 1 site`,
  hunk headers (`@@ -5,6 +5,11 @@`) in accent, added lines green-tinted. The raw
  JSON is still there, now **collapsed by default** when a preview exists — the
  args stay editable (D-16), they just stop being the only way to read the call.
- **Approve wrote both files, in one decision.** Checked on disk afterwards:
  `store.py` gained `order_cutover_moment()` in the right place and `NOTES.md`
  gained its bullet. One pause, two files.
- **All-or-nothing is real, and visible *before* you approve.** A batch whose
  first file had an anchor matching **3** sites showed `2 files +1 −1  1 cannot
  apply`, with `adapter.py` marked **cannot apply** and its reason inline
  (*"anchor found 3 time(s), expected 1 — extend the anchor until it is unique,
  or set 'expected_count'"*) while the *other* file still rendered its clean diff.
  Approving it anyway wrote **nothing** — `NOTES.md`'s md5 was unchanged — and the
  model got the same reason back as the tool result. This is the property the
  throwaway `/tmp` scripts had and `write_file` never did.
- **Long content scrolls inside its own box**, not the page (the diff body caps at
  340px with its own `overflow`), matching the X-11 tool-output rule.

**Found while looking** (mocks could not have caught either): the preview is
computed server-side against the *real* file, so a malformed batch returns no
preview at all and the card silently falls back to raw JSON — that is the correct
behavior but it is only obvious in a browser. And the fake driver's `|`/`;`
delimiters collide with content containing those characters, which is a peek-harness
limitation, not a tool one — fixture content must avoid them.

Not exercised visually (covered by tests): `read_file`'s `offset`/`limit` paging
(headless, no rendered surface), and the per-file write failure mid-batch.

---

## H-05 — reading another branch while a turn runs · 2026-07-31 · ✅ looked good

**Screenshots:** [`visual/h05-mid-turn-off-branch.png`](visual/h05-mid-turn-off-branch.png) ·
[`visual/h05-stream-off-branch.png`](visual/h05-stream-off-branch.png) ·
[`visual/h05-back-on-branch.png`](visual/h05-back-on-branch.png)

Fake agent driver, isolated config/data dirs, server fenced to a scratch
workspace. Seeded one exchange, edit-forked the opening message into a second
branch, then drove the rest through the page. The fake driver gained
`JLCODE_FAKE_LLM_DELAY_MS` for this peek — a turn that settles in one tick cannot
be screenshotted mid-flight, so the streaming surfaces were otherwise unpeekable.
Confirmed with my own eyes:

- **Branch arrows are genuinely passive mid-turn.** Approved `run: sleep 12` on
  branch B, then stepped `2/2 → 1/2` while it ran. The transcript swapped to
  branch A's two messages and *stayed* two messages; the rail card still read
  `working…`, Stop was still live, and the **background tasks panel kept counting**
  (`sleep 12 … 8s`) — the turn never noticed. Before the fix this is the click
  that re-parented the reply.
- **Nothing leaks onto the branch you're reading.** The turn ran to completion
  with branch A on screen: the `run:` message, the `run_command` result and the
  final answer never appeared there, and A was still exactly two messages when
  the session went `idle`.
- **The live overlay stays with its own branch.** Sent a plain message on B and
  jumped to A mid-stream: `pondering…` and the rail's `working…` still showed
  (the *session* is busy, and saying so is right), but **no streaming bubble** was
  drawn on A. Stepping back to B mid-stream picked the overlay right back up,
  half-written, at the bottom of B.
- **The tree on disk matches what the screen said.** The log carries
  `{"kind":"activeLeaf","leaf":"e_8cd49…"}` — the mid-turn hop to A — with the
  turn's entries still chained onto B's tip either side of it, and a final hop
  back. Edit-fork now writes its move too (`{"leaf":null}` for a fork of the very
  first message); it used to mutate the pointer silently, which is why the reply
  looked lost.

**Found while looking:** nothing broken, but the arrows only render on hover, so
the affordance for "read the other branch while this one works" is discoverable
only if you already know it is there. Worth a look when branch nav gets its next
pass — not filed as a defect.

Not exercised visually (covered by tests): the approval/ask pause holding the pin
across a resume, and the wire being rebuilt from the pinned branch.

---

## D-57 — Retry: re-attempting a turn · 2026-08-04 · ✅ looked good

**Screenshots:** [`visual/d57-retry-live-error.png`](visual/d57-retry-live-error.png) ·
[`visual/d57-retry-recovered.png`](visual/d57-retry-recovered.png) ·
[`visual/d57-retry-error.png`](visual/d57-retry-error.png) ·
[`visual/d57-auto-retrying.png`](visual/d57-auto-retrying.png) ·
[`visual/d57-hung.png`](visual/d57-hung.png) ·
[`visual/d57-hung-recovered.png`](visual/d57-hung-recovered.png)

Fake agent driver, isolated config/data dirs, scratch workspace. The driver grew
three failure prefixes for this (`fail:` a 402, `flaky:` two 503s, `hang:` a
request that never answers) — each misbehaves once and then works, because what
needs looking at is the recovery, not the failure. Confirmed with my own eyes:

- **The reported bug, and its fix.** `OpenRouter 402 Payment Required:
  Insufficient credits` in red with **↻ Retry** sitting on the same line. Clicked
  it: the error and the button vanished, the answer streamed in **under the
  original message**, and the log on disk holds four entries —
  `user | assistant | user | assistant` — with **no "continue" message** invented
  to restart the thread. That is the whole feature in one screenshot pair.
- **A reload does not lose the button.** Opening `/?session=<id>` fresh, after a
  failure the tab never witnessed, still offers Retry — the settled state carries
  `retryable`, with a generic line standing in for the error text the page missed.
  *(Found while looking: it didn't, at first. The button was nested inside the
  live-event notice, so F5 threw the only way out of a failed turn away.)*
- **An automatic retry says so.** Mid-backoff: `percolating…` still spinning above
  `Provider failed (OpenRouter 503 Service Unavailable: upstream is busy) —
  retrying 1/3 in 1s…`. It reads as *working*, not stalled — which is the point,
  since a user who thinks it is wedged will retry by hand on top of the retry
  already in flight. *(Found while looking: the notice outlived its own success,
  leaving a red provider-failure line hanging over a perfectly good answer. It is
  now retired when the turn lands.)*
- **A hung request is a warning, not an error.** After 26s of silence: the
  half-streamed `Let me think about` still on screen, `percolating…` still going,
  and a **muted grey** `No response for 26s. The request may be stuck. ↻ Retry` —
  visibly a different weight from the red 402. **Stop stays lit right beside it**,
  which is the distinction that matters: Retry abandons the request, Stop
  abandons everything.
- **Retrying a hung turn keeps it a turn.** Clicked Retry on the wedged request:
  the abandoned half-reply was discarded (not concatenated onto the new one — the
  overlay resets per attempt), the real answer landed, and the tree again held
  exactly four entries.

Not exercised visually (covered by tests): the breaker-reset path from `halted`,
the 20s gate itself (waited it out rather than faking the clock), and the refusal
when no request is in flight.
