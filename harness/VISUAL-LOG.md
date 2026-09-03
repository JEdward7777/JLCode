# JLCode — Visual Verification Log

Tests catch regressions, but a test with more mocks than target code can pass
while the real thing is broken or ugly. So for anything with a rendered surface
(the browser frontend, §11), we **look at it in a real browser at least once**
per slice and record it here — what we loaded, what we confirmed with our own
eyes, and a screenshot. This complements the automated tests; it does not
replace them.

## How the peeks are driven — use the tool

**`harness/peek/peek.mjs` is the recipe. Don't hand-roll it again.** (Joshua's
call, 2026-08-06: this used to be prose here, so every slice rebuilt the same
three throwaway scripts from scratch.) No extra deps — Node's global `fetch` +
`WebSocket`, so it wants Node 22+. Nothing here ships; `package.json` publishes
`dist` only.

```bash
npm run build                                                  # peek drives dist/
node harness/peek/peek.mjs up --ctx 4000 --buffer 1000 --trigger suggest
node harness/peek/peek.mjs chat "Give me a short overview."    # prints the state frame
node harness/peek/peek.mjs shot x24-meter                      # → harness/visual/x24-meter.png
node harness/peek/peek.mjs shot x24-crop --crop topbar         # named crop, for chip-sized detail
node harness/peek/peek.mjs click ".tool-head" --shot x23-open  # a real mouse, then the shot
node harness/peek/peek.mjs new                                 # a fresh session (empty states)
node harness/peek/peek.mjs state                               # just the state frame
node harness/peek/peek.mjs down
```

What it handles, so you don't rediscover it:

- **Isolated everything.** Writes its own `config.json` under `/tmp/jlcode-peek-<port>`
  with `JLCODE_CONFIG_DIR`/`JLCODE_DATA_DIR` pointed there and `JLCODE_FAKE_LLM=1`
  — no real key, no spend, and your actual `~/.config/jlcode` is never touched.
- **`--ctx` / `--buffer` / `--trigger` are the dials that pose the compaction and
  context surfaces.** They set `contextLength`/`bufferTokens`/`triggerModes`,
  which is what decides whether a fake turn (≈1,000 prompt tokens) reads as
  quiet, crossed, or over the wall. `--delay <ms>` sets `JLCODE_FAKE_LLM_DELAY_MS`
  so mid-stream surfaces are screenshottable at all.
- **CDP, with a real wait.** Chrome's `--virtual-time-budget` screenshot stalls on
  the long-lived SSE connection the client holds open, so the tool drives a real
  page and waits (`--wait ms`, default 2500).
- **It never touches your browser — unless you ask.** By default it launches
  Chrome on a *deliberately unconventional* CDP port (9411, not 9222) with a
  throwaway `--user-data-dir`, **refuses to attach** to a listening port it
  didn't start, and opens its own tab instead of navigating whichever page is
  first in the target list. (Both hazards were real: the first version reused
  any browser on 9222.)

### Two peeks at once — `JLCODE_PEEK_PORT` (D-67)

A peek **instance is its server port**, and the port moves:

```bash
JLCODE_PEEK_PORT=7811 JLCODE_PEEK_CDP_PORT=9421 node harness/peek/peek.mjs up
```

Everything transient is keyed by it — `/tmp/jlcode-peek-<port>/` holds that
instance's state file, config, data, chrome profile and pids — so a second peek
is a second instance rather than a second writer of the first one's state. That
is what makes `down` safe with two agents on one machine: **it signals only the
pids it recorded**, and no longer POSTs `/shutdown` at whatever answers on the
port. `up` refuses a port that is already serving when it didn't start that
server, and says which env vars to move. Verified 2026-08-07 by running
7811/9421 and 7821/9431 side by side and taking the second one down: the first
one's server *and* its browser were still up, untouched.

### `peek click` — the surfaces that need a mouse (D-67)

Hover-revealed affordances and collapsed blocks can't be reached by `shot`
alone. X-12b and X-23 each hand-rolled the same throwaway CDP script; this is
that script, once. **Steps run in order in one invocation** and `--shot` captures
the result — peek opens its tab per command and closes it after, so a hover in
one process is already gone by the time a second one starts. That is also why
hover is a *step* (`hover:<sel>`) and not a verb of its own.

```bash
# X-23's case: a tool block starts collapsed — expand it, then shoot.
node harness/peek/peek.mjs click ".tool-head" --shot x23-transcript-write

# X-12b's case: the ✕ is opacity:0 until its row is hovered, and the confirm is
# a click deeper. Three steps, one invocation.
node harness/peek/peek.mjs click "hover:.rail-item.history@1" \
     ".rail-item.history .rail-close@1" ".rail-confirm-actions .danger" \
     --shot x12b-deleted --crop rail
```

- **Addressing is a CSS selector**, plus peek's own `@n` suffix. `@n` picks from
  that selector's own match list and therefore goes at the **end** — to act
  inside the nth container, index the leaf (`.rail-item.history .rail-close@1`)
  or scope it in CSS (`:nth-of-type(2)`).
- **Nothing fails quietly**, because the failure that matters is a screenshot of
  a page that never changed. No match (after `--timeout`, default 3000ms),
  several matches, a 0×0 match, or a match with something else on top of it all
  **exit 1 and write no PNG**. An ambiguous step lists its matches by their text
  *and their parent's* — which is the only thing that tells three identical `✕`
  buttons apart:

  ```
  peek: ".rail-item.history .rail-close" matches 3 elements — say which with @n …
      0  button.rail-close "✕"   in div.rail-item-top "Third thread✎✕"
      1  button.rail-close "✕"   in div.rail-item-top "Rail hover affordances✎✕"
  ```
- **A click that changed nothing says so** (`warning — the DOM is identical to
  before the click`) before the shot is written. A hover changes CSS only, so it
  is exempt.
- `--settle <ms>` (default 300) is the pause after each step for the render it
  caused; `--wait` still governs the first page load, `--timeout` how long a step
  waits for its element to appear.

Both recipes above were re-run against the real browser on 2026-08-07 as the
acceptance test for the command: the ✕/confirm sequence really did delete the
thread (`GET /conversations` dropped from 3 to 2), and the tool block really did
expand to its args and file body.

### `--attach` — screenshotting the browser *you* are looking at

The opposite default, opt-in per command (Joshua's call, 2026-08-06): sometimes
the useful thing is "grab what's on my screen". `--attach` makes that possible
without making it possible *by accident* — it is never sticky, never a fallback
from a failed launch, and has to be typed every time.

```bash
google-chrome --remote-debugging-port=9222     # you start this
node harness/peek/peek.mjs tabs --attach       # read-only: what's open
node harness/peek/peek.mjs shot look --attach --tab 2
```

In attach mode peek **navigates nothing and resizes nothing** (your tab is
captured as-is, at whatever size it is), opens no tab and closes none, and
records no pid — so `down` can never kill your browser. With several tabs open,
ambiguity is an **error listing them**, not a guess: silently capturing the wrong
window is the failure that actually matters. Named crops (`topbar`) are refused,
since they're measured against peek's own viewport; give `x,y,w,h` instead.
Captures land in `/tmp/jlcode-peek-<port>/`, **not** `harness/visual/` — they're ad-hoc,
may hold anything that was on screen, and must not drift into a commit.

*Caveat worth knowing before you try it:* a Chrome that is **already running**
can't be opted in after the fact. `google-chrome --remote-debugging-port=9222`
against a live Chrome just opens a window in the existing process and drops the
flag. Quit it first, or start a separate profile with `--user-data-dir=<dir>`.

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

---

## H-06 — the window a session measures itself against · 2026-08-06 · ✅ looked good

**Screenshots:** [`visual/h06-suggest-window.png`](visual/h06-suggest-window.png) ·
[`visual/h06-assumed-window.png`](visual/h06-assumed-window.png)

The defect being closed was invisible by construction: `serve` never injected a
context window, so `compactionBudget()` was undefined and **no compaction surface
had ever rendered in real use** — the P6c peek below was driven by a hand-set
`contextLength` that no real config has. So the thing to look at here is whether
the window is now *stated*, and whether a guessed one reads as a guess.

Drove the built server with the fake driver (`JLCODE_FAKE_LLM=1`, isolated
config/data dirs) in `suggest` mode across two turns, screenshotted via CDP.
Confirmed with my own eyes:

- **A known window is named.** The suggest banner now reads "◆ Context is getting
  large — compacting will keep replies fast and in-window. **(window 1,500
  tokens)**". Previously the banner asserted the context was "getting large"
  without ever saying large *relative to what*.
- **An assumed window says so, in the same breath.** For a model id the catalog
  doesn't list, a second line appears under the banner: "⚠ This model isn't in
  the OpenRouter catalog, so the window above is an assumed default. Set
  `compaction.contextLength` for this config (or `jlcode config set <name>
  --context-length <n>`) to measure against the real one." It renders at a
  lighter weight than the banner text, so it reads as a caveat rather than a
  second alarm, and it names the exact fix rather than just flagging doubt.
- **The state frame carries all three fields.** `GET /session/:id/state` returned
  `contextWindow: 1500, contextThreshold: 500, contextWindowSource: "config"` for
  the known case and `…Source: "fallback"` for the unknown one — the numbers X-24's
  meter needs are on the wire now, not just in the card.
- **The real presets resolve.** Outside the peek, `serve` against Joshua's own
  `MM - Opus` and `OmegaMusic-Opus` both banner **"context window 1,000,000 tokens
  (from OpenRouter)"** — including the `:online` one, which an exact-id lookup
  would have missed entirely.

*Method note:* the assumed-window shot needed a fallback small enough for a fake
turn (1,000 prompt tokens) to cross, so `FALLBACK_CONTEXT_WINDOW` was temporarily
lowered **in `dist/` only** for that one screenshot and the tree rebuilt after.
The rendering is what was being checked; the constant is covered by tests.

*Noticed while looking, not fixed here:* the header model chip truncates from the
right (`openai/gpt-4o-mi…`, `someone/unlisted-m…`), hiding the part that
identifies the model and keeping the vendor prefix that doesn't. That is Joshua's
first observed-item and is still unfiled.

Not exercised visually: the `auto`/`hard`/`cancelable` surfaces with the new
window line (same components, same props), and a real over-window compaction
against a live model.

---

## X-24 — the context meter · 2026-08-06 · ✅ looked good

**Screenshots:** [`visual/x24-meter-states.png`](visual/x24-meter-states.png) (the
three chip states stacked) · [`visual/x24-meter.png`](visual/x24-meter.png) ·
[`visual/x24-over-threshold.png`](visual/x24-over-threshold.png)

First peek driven by `harness/peek/peek.mjs` rather than hand-rolled scripts, and
the tool was hardened mid-peek after Joshua asked whether it could act in *his*
Chrome with *his* cookies (see the method section above — it could have, on a
port collision; now it refuses).

Posed with `--ctx 4000 --buffer 1000` (quiet) and `--ctx 1200 --buffer 200`
(crossed), since a fake turn reports ≈1,000 prompt tokens. Confirmed with my own
eyes:

- **The meter exists, continuously, with no crossing required.** A single quiet
  turn shows `26%` with a partly-filled blue bar. That is the whole filing: the
  same number previously appeared *only* on the compaction card, i.e. only once
  it was too late to act on. The state frame behind it read
  `contextTokens: 1054, contextWindow: 4000, contextThreshold: 3000`.
- **The threshold is a mark, not the denominator.** The hairline sits at 75% of
  the track (3,000 of 4,000) while the fill reads 26% — so "how full" and "when
  will it compact" are separately legible, which was X-24's open question (c).
- **Unmeasured reads as unmeasured, not as empty.** A fresh session shows an empty
  track and `—`, not `0%`. A confident `0%` is exactly the lie that let H-06 hide
  for a month, so this was the case most worth looking at.
- **Crossing is one visual event.** At 87% the chip turns red — border, fill and
  figure together — at the same moment the suggest banner appears below the
  thread. The meter and the banner agree because they read the same budget.
- **It sits with the spend chip and matches it.** Same height, radius, border and
  mono figure, so the corner reads as one row of instruments rather than a
  widget bolted on.

*Noticed while looking, not fixed here:* past the threshold the red fill swallows
the threshold hairline (the mark is drawn in `--muted` over `--danger`). Harmless
— once the bar is red you already know you are over it — but if the mark ever
needs to stay visible there, it wants a contrasting colour rather than one tone.

Also re-confirmed, still unfiled: the header model chip truncates from the wrong
end (`pe…` for `peek/model`), keeping the vendor and hiding the model. Same
observed-item as the H-06 peek.

Not exercised visually: the meter under `auto`/`hard`/`cancelable` (same
component, same props), and its reset across a real compaction — the post-compact
`—` is covered by tests but was not screenshotted.

---

## X-12b — deleting and renaming a past thread · 2026-08-06 · ✅ looked good

**Screenshots:** [`visual/x12b-row-hover.png`](visual/x12b-row-hover.png) (the two
affordances) · [`visual/x12b-confirm.png`](visual/x12b-confirm.png) ·
[`visual/x12b-renamed.png`](visual/x12b-renamed.png) (both writes landed) ·
[`visual/x12b-peeked-row.png`](visual/x12b-peeked-row.png) (no ✕ on the row you
are reading)

Posed by seeding three threads through the fake driver and closing each session,
so they fall to HISTORY. The hover and click states are not something
`peek.mjs shot` can reach on its own — the affordances are `opacity: 0` until
hover and the confirm is a click deeper — so this peek drove `Input.dispatchMouseEvent`
over the same CDP session the tool opens. Worth folding into the tool if a third
slice needs it; two is not yet a pattern.

Confirmed with my own eyes:

- **The row now has the same two affordances as a live card**, revealed on hover
  in the same place (✎ then ✕), and the ✕ reddens under the cursor. A past thread
  reading as a quieter version of a live one was X-12a's call; keeping the
  affordances identical is what stops "quieter" from meaning "different".
- **The confirm names the thread, in the row.** *Delete "Compaction budget math"?
  It leaves the list, but stays on disk.* Deliberately not a browser `confirm()`:
  a native dialog can't be screenshotted, and it would take the name out of the
  place the name is. The full title wraps rather than truncating — the row above
  it truncates at `Compaction budget…`, which is exactly what a confirm must not
  do.
- **The second clause is the honest one.** *Stays on disk* is literally true, and
  it is what makes the ✕ a safe thing to click. Verified underneath: after the
  delete, `index.jsonl` carries one new line —
  `{"kind":"deleted","id":"cv_91c4b9d81997","deleted":true,"ts":…}` — the
  conversation log is byte-for-byte unchanged and 619 bytes on disk, and
  `GET /conversation/<id>` still answers **200**.
- **The hand-flip recovery path works.** Editing that one line to
  `"deleted":false` and re-listing brought the row back, titled. That is Joshua's
  stated recovery ("go dumpster diving in the json file and flip the flag back"),
  and it is the reason this is a flag rather than a tombstone.
- **Rename from a row lands everywhere.** ✎ opens the same in-place input the rail
  card uses, pre-selected; Enter committed, the row relabelled, and
  `GET /conversations` agreed on the new title. No reload.
- **The peeked row does not offer ✕** while the other rows still do (asserted in
  the DOM, not just by eye: `pencil:true close:false` on the open row,
  `close:true` on both others). Deleting the thread rendered in the pane beside
  you would pull it out from under you.
- **An abandoned session leaves no trace at all.** Opening a session, typing
  nothing, and closing it left the history count at 3 and wrote **no**
  `cv_….jsonl` — the stub is gone at the source rather than masked after the
  fact.

*Environment note for whoever peeks next in a container:* headless Chrome needs
`/dev/shm` at `1777` or it dies before CDP comes up (its own error message says
so), and without a font package the rail's ✎/✕ render as `□`. Neither is a JLCode
defect — but a peek that shows boxes where the glyphs should be is not a peek.

Not exercised visually: the failed-write `.rail-notice` (the rename/delete error
path has no session card to report into, so it renders in the history section);
it is styled but was not provoked in the browser.

---

## X-23 — a write you can read before approving it · 2026-08-06 · ✅ looked good

**Screenshots:** [`visual/x23-overwrite-diff.png`](visual/x23-overwrite-diff.png)
(overwrite → diff against disk) ·
[`visual/x23-create-file.png`](visual/x23-create-file.png) (new file → its body) ·
[`visual/x23-delete-file.png`](visual/x23-delete-file.png) (delete → size + head) ·
[`visual/x23-transcript-write.png`](visual/x23-transcript-write.png) (after the
fact, in the transcript) · [`visual/x23-no-change.png`](visual/x23-no-change.png)
(an identical write) ·
[`visual/x23-whitespace-only.png`](visual/x23-whitespace-only.png) (the case that
made the point)

Posed with `peek up` plus two new fake-driver seeds — `delete: <path>` joins
`write:`/`edit:` — over a workspace seeded with a small `.ts`, a 92-line
`CHANGELOG.md` and two `.env` samples. The transcript shot needed a click (the
tool block starts collapsed), which is the same gap X-12b hit; a throwaway CDP
script did it, and that is now **twice**, so a `peek click` is worth adding the
next time a slice needs one.

Confirmed with my own eyes:

- **An overwrite renders as a diff against what is actually on disk.** The card
  reads `1 file +4 −2` with `@@` hunks, green/red rows and the file's own
  `+4 −2` on its summary — the same card `apply_edits` gets. Before this, that
  same call was `path: src/session-state.ts` and a collapsed raw-JSON box.
- **No `sites` count on a write.** Anchor sites are an `apply_edits` notion; the
  span is simply absent here rather than reading `1 site`, which would be a
  number invented for the sake of the layout.
- **A new file shows its body, not an all-green wall** — a `NEW FILE` badge, the
  path, `17 lines · 338 B`, then the markdown as text. Compared side by side
  with a hand-made `+`-diff of the same file, this is the readable one; the
  green marks add nothing when every line is new.
- **A delete finally shows what it is destroying**: a red `DELETE` badge,
  `92 lines · 6.3 KB`, the first 40 lines, and `… 52 more lines not shown`. That
  is enough to recognize the file, which is the decision (c) framing — the size
  is what tells you how much is going.
- **The transcript is readable after the fact.** The expanded `write_file` block
  now carries a `src/session-state.ts` / `17 lines · 503 B written` header and
  the file as text. This is where the old defect was worst: the approval card is
  gone by then, so the escaped-JSON args were the *only* surviving record.
- **An identical write says so** — `1 file +0 −0  identical — this changes
  nothing`, and no diff body at all. The empty body box was the first render and
  it read as broken, so it is now suppressed; the label carries the meaning.
- **The case that justifies the whole slice, found by accident while posing the
  identical one:** two files that look the same in the composer differed only in
  a **trailing newline**. The card shows `+1 −1` on the last line
  (`x23-whitespace-only.png`); the raw JSON showed nothing at all. That is the
  defect in one image.
- **The raw-args box is still there, still collapsed, still the editable one**
  (D-16). Both new cards are read-only, exactly as the diff card has been.

Not exercised visually: the not-UTF-8 and not-a-regular-file fallbacks and the
400-line cap on a create (all covered by tests, none of them worth seeding a
binary into a peek workspace for); and the out-of-fence path, where the preview
is deliberately absent and the card is the soft-fence one already logged in P5b.

---

## X-26 — a blip when a session needs attention · 2026-08-07 · ✅ looked good (and it works, but nobody heard it)

**Screenshots:** [`visual/x26-rail-notify.png`](visual/x26-rail-notify.png) (the
NOTIFICATIONS cluster, on) ·
[`visual/x26-rail-notify-off.png`](visual/x26-rail-notify-off.png) (off, and
persisted) · [`visual/x26-two-pauses.png`](visual/x26-two-pauses.png) (two
sessions wanting you at once — the state that produced exactly one note)

**Sound is the one thing a screenshot cannot show, and this container has no
audio device**, so this peek was designed around that rather than pretending
otherwise. It splits three ways, and the log says which is which every time:
what was **seen** (the toggle, the rail's attention dots, the state that
triggers it), what was **read out of the live page** (`document.title`,
`document.hidden`, `localStorage`), and what was **measured as actual audio** —
because the shipped `createBlipper` was made to render through the browser's own
`OfflineAudioContext` and the resulting samples were analysed. Nothing here was
confirmed by ear. Nobody has heard this feature yet.

Posed with `peek up --ctx 40000 --buffer 8000 --trigger suggest` and two fake-driver
sessions, then driven over CDP on the tool's own Chrome (9411) — the toggle
needs a real click (that is the whole point of the autoplay half), a hidden tab
needs a second target activated, and the audio needs a substituted context, none
of which `peek shot` does on its own. That is now the **third** slice to hand-roll
CDP clicks after X-12b and X-23; `peek click` has earned its place.

Confirmed with my own eyes:

- **The NOTIFICATIONS cluster sits at the foot of the rail**, under a header
  styled like LIVE / HISTORY but with no caret (there is nothing to collapse yet,
  and a caret that does nothing reads as broken). One checkbox — *blip on
  attention* — with room beside it for X-13 and X-16, which is the point of
  putting it here instead of next to whatever feature it belongs to.
- **Two sessions wanting you at once look like it**: `needs answer` and
  `needs approval`, both with the amber attention dot, in the same rail as the
  toggle that decides whether you hear about them.

Read out of the live page (not eyes — the DOM):

- **Nothing audio exists until you click.** On load, with the preference already
  on, `AudioContext` had been constructed **0** times. That is the autoplay trap
  in one number: a context built here would be born `suspended` and the feature
  would be silent forever.
- **The toggle round-trips.** Click → unchecked, `jlcode.notify.blip = "false"`;
  click again → checked, `"true"`, and the context was created **once** and
  resumed once across both clicks.
- **The tab marker works in a genuinely hidden tab.** With a second target
  activated (`document.hidden === true` confirmed, not simulated), a turn was
  posted to the session behind it. `document.title` went from
  `"Sketch the blip design — work"` to **`"● Sketch the blip design — work"`**,
  and back to the unmarked form the moment the tab was activated again.
- **The suppression rule holds, both directions.** A background session settling
  while the tab was *visible* and a different session focused → the blipper was
  called. The **focused** session settling on screen in the same visible tab →
  **zero** notes scheduled. That is X-26(e) working.
- **A batch is one note.** Two sessions pushed into `awaiting-input` and
  `awaiting-approval` simultaneously behind a hidden tab scheduled **2**
  oscillators — i.e. one two-note chirp, not two.

Measured as real audio (rendered by the browser, analysed sample-by-sample):

- The blip the shipped code scheduled, rendered through `OfflineAudioContext`:
  **two bursts, 65.9 ms each, starting at 0 ms and 89.8 ms, peak 0.0696 and
  0.0697, and 881 Hz then 1321 Hz** by zero-crossing count. That is the design
  (880 → 1318.5 Hz, 70 ms, gain 0.07) coming out of a real audio graph, with the
  ~4 ms shortfall exactly the ramp at each end. It ascends, it is short, and it
  is quiet.

**The defect this peek caught, which no test would have.** The first
implementation decided "a session settled" by comparing `attentionOf(slice)`
before and after each render. In a real backgrounded tab, Chrome throttles hard
enough that **an entire fake turn arrived as a single DOM mutation** — measured:
a `setInterval(…, 100)` ran 5 times in 4.5 s, and the rail's status text never
once said `working…`. So the level went `idle → idle` and the feature did
nothing at exactly the moment it exists for. Fixed by making the edge a
monotonic `settleSeq` counter bumped by the wire events themselves, which no
amount of batching can collapse; the level comparison stays as a second edge for
a session that settled while the SSE bus was disconnected. Re-peeked after the
fix — that is where the `●` above comes from.

Not verified: **that it is actually pleasant to hear.** No speaker was involved
at any point; the waveform is right, but whether 880 → 1318.5 Hz at 0.07 is the
*right* little blip is Joshua's call the first time a session settles behind his
tab, and the two constants to turn are `NOTES` and `PEAK` in `web/src/blip.ts`.
Also not exercised in the browser: the preference **off** path (a one-line `&&`
in `App.tsx`), a browser with no WebAudio at all (unit-tested — it stays silent
and the tab marker still works), and re-arming from a *remembered* preference
across a reload, which uses the same `arm()` the toggle does and was confirmed
only through an ordinary click in the second pass.

---

## X-28 — the way out of an `ask_user` question · 2026-08-07 · ✅ looked good

**Screenshots:** [`visual/x28-ask-escape.png`](visual/x28-ask-escape.png) (a
single question with options — the free-text box and the Skip that were not
there before) · [`visual/x28-ask-form.png`](visual/x28-ask-form.png) (the P5b
multi-question form, every field with a text box) ·
[`visual/x28-ask-required-blocked.png`](visual/x28-ask-required-blocked.png)
(the one case where the skip is withheld, and it says why) ·
[`visual/x28-ask-result.png`](visual/x28-ask-result.png) (what the model is
actually handed — the point of the whole slice)

Posed with `JLCODE_PEEK_PORT=7821 JLCODE_PEEK_CDP_PORT=9431 peek up`, the fake
driver's `ask:` and `form:` seeds, and `peek click` for the mouse. The `ask:`
seed now takes options (`ask: <q> | a, b, c`), because posing this card with a
Yes/No question is posing the one shape where "pick one" is nearly honest.

What was confirmed by eye:

- **`ask: Which database should I use for the ledger? | sqlite, postgres`** —
  the shape the defect was reported against. Two option buttons, and beneath
  them a text box reading *"…or say something else — you don't have to pick
  one"* and a dashed **Skip this question** beside Submit, with one line under
  the actions saying what skipping means. Before this slice the same call
  rendered two buttons and a disabled Submit, full stop.
- **Skip actually skips, and the model is told so.** Clicking it (`peek click
  ".ask-skip"`) settled the turn, and the tool result on disk reads *"The user
  declined to answer: … declined — the user did not answer this"* followed by
  the instruction not to substitute the closest option. Not an empty string,
  which is what a blank would have been.
- **The multi-question form (P5b) got the same treatment field by field** —
  including the two that only ever had buttons. The `choose any` hint and the
  header chips are untouched; the text box is simply always there now.
- **`required` is the only thing that takes the escape away, and it shows its
  work.** With `Ticket` required and left blank, *both* buttons go disabled and
  an amber line names the offender: *"An answer is required: Which ticket is
  this for?"*. A disabled button with no explanation would have been the same
  defect wearing a different hat. With two of four answered the labels read
  **Submit 2 of 4** / **Skip the rest**, so the card says what pressing either
  one would send.
- **What the model receives, read in the transcript** (expanded with `peek
  click ".tool-head"`): four labelled lines, each keeping its own shape —
  `picked none of the offered options and typed: duckdb`, two `declined`, and
  one plain `JL-411` — then the decline note, once. That is the whole argument
  of D-72 in one screenshot: three different things that used to flatten into
  one comma-joined string.
- **Live, against the real server, not a mock:** POSTing the form with the
  required field blank came back **400** (`This question requires an answer:
  Which ticket is this for?`) and the session stayed `awaiting-input`; the same
  POST with `JL-411` typed went through. `required` is enforced on the server,
  so it means the same thing to a CLI as to the card.

**A defect this turned up that no test had reached:** `submitAnswer` cleared
`pendingAsk` optimistically and never restored it on failure. Until D-72 gave
`answer()` a reason to refuse, nothing could fail there — so a rejected answer
would have left the session sitting in `awaiting-input` with the card gone and
no way to answer it. Fixed by putting the request back on the error path.

Not exercised visually: typing into a field (peek has no keyboard — the typed
cases were driven over HTTP against the same live server and are unit-tested),
and Enter-to-submit on a single question for the same reason. Also unchanged and
deliberately so: the **approval** card, whose Deny button, editable raw-args box
(D-16) and composer note (D-51) already give the refusal and the override this
slice was adding — see D-72's rationale.
## X-29 / X-30 — the chip that hid the model, and the scroll that stole the view · 2026-08-08 · ✅ looked good

**Screenshots:** [`visual/d71-chip-before.png`](visual/d71-chip-before.png) →
[`visual/d71-chip-after.png`](visual/d71-chip-after.png) (the chip) ·
[`visual/d71-scroll-before.png`](visual/d71-scroll-before.png) →
[`visual/d71-scroll-after.png`](visual/d71-scroll-after.png) (reading up while a
reply streams) · [`visual/d71-jump-new.png`](visual/d71-jump-new.png) (the count
building) · [`visual/d71-jumped.png`](visual/d71-jumped.png) (back at the tail)

Posed on `JLCODE_PEEK_PORT=7811 JLCODE_PEEK_CDP_PORT=9421` (D-67's movable port,
so this ran while a sibling drove its own browser on 7801/9411) with the fake
driver, a config id of `anthropic/claude-opus-5:online`, and turns long enough
that a reply takes real time to render.

Confirmed with my own eyes:

- **The chip before is `an…`** — two letters of "anthropic", which names neither
  the vendor nor the model. It is worse than the filed report suggested: the
  report cited `openai/gpt-4o-mi…`, but at the width the chip actually gets,
  what survives is the *first two characters of the namespace*.
- **The chip after is `…/claude-opus-5:online`** — the model, and the `:online`
  suffix that changes what it *is*, with the vendor peeled off the front. The
  full id is in the `title`, so nothing is lost, only deprioritized.
- **Reading up during a stream stays put.** Scrolled to the middle of a long
  thread, the next tokens no longer yank the viewport; the before/after pair is
  the same moment of the same reply, one chasing the bottom and one not.
- **The count is entries, not tokens.** A streaming reply is one message in
  progress, so the jump button reads a number that means something instead of
  racing upward.

Not exercised visually: the middle-elision path (no real model id is long enough
to need it at the shipped budget — it is unit-tested at absurd widths), and the
resumed-thread reset, which renders identically to a branch switch by
construction and is covered by `isViewSwitch`'s tests.

*Caught by the peek and not by the suite:* the first cut re-pinned on every
message, because `activeLeaf` advances with each appended entry and the code read
that as a branch switch. See D-71(c) — the fix is a pure `isViewSwitch`, and the
regression is now pinned by tests that can actually reach it.
## X-13 — auto-read, and the jam underneath it (H-07) · 2026-08-08 · ✅ looked good (and this time the API was made to testify)

**Screenshots:** [`visual/x13-rail-notify-off.png`](visual/x13-rail-notify-off.png)
(the NOTIFICATIONS cluster with the new toggle, **off** — the default) ·
[`visual/x13-rail-notify-on.png`](visual/x13-rail-notify-on.png) (on, persisted,
and the *◼ reading aloud* row that appears only while something is being read) ·
[`visual/x13-reading-reply.png`](visual/x13-reading-reply.png) (a reply being
read: the ◼ lit on the message itself **and** the rail row, together)

**A screenshot cannot show speech, and this container has no voice at all** —
`speechSynthesis.getVoices()` returns **0** and every utterance is handled by a
null engine. So, as in X-26, the log says which of three kinds each claim is:
what was **seen** (the cluster, the lit ◼, the states that trigger it), what was
**read out of the live page** (`localStorage`, `speechSynthesis.speaking`, and a
recorder wrapped around `speak`/`cancel` that still delegates to the real
engine), and what was **measured as engine behaviour** (utterance event traces,
timed). **Nothing here was confirmed by ear. Nobody has heard this feature yet.**

Posed with `peek up` on 7801/9411 and the fake agent driver. The toggle and the
arming gesture need a real mouse (`peek click` did the toggle); the rest needed
peek's own Chrome driven directly, because a recorder has to be installed
*before* the turn arrives and `peek shot` opens a fresh tab per command.

### The jam first — H-07, "TTS jamming intermittently"

Reproduced before anything was written, against the **shipped** `toggleSpeak`
shape run verbatim in the browser.

- **What Chrome actually does.** `error` is a normal outcome and it fires
  **instead of** `end`. Twenty replies each replacing the last (a reply every
  900 ms — the auto-read case and the impatient-clicker case at once) produced
  **19 utterances that ended in `error: "interrupted"` with no `end` event**, and
  one — run 16 — that `speak()` accepted and which **never started at all**
  before dying `interrupted`. That single silent drop is ~5%, and 5% is exactly
  what "jams intermittently" feels like from the outside.
- **The deterministic case, and the actual defect.** The simplest thing a user
  can do: click 🔊 once, on a cold engine, and wait. **Five fresh browsers, five
  latched buttons** — every trial failed `error: "synthesis-failed"` and the UI's
  `speakingId` was **still set 15 seconds later with nothing being read**. The
  shipped code registered `u.onend` and no `onerror`, so this is a state it can
  enter and never leave: the ◼ stays up, and the next auto-read believes it is
  still busy.
- **Why it is intermittent and not constant.** It depends entirely on which
  terminal event the engine picks, which varies with how cold it is and whether
  anything interrupted it. In one 20-reply run the last utterance happened to
  `end` cleanly and the UI cleared; in another the first two failed outright.
  Same code, same browser, same page.
- **Two smaller facts the browser volunteered**, both of which shape the fix:
  `start` is asynchronous (**130–620 ms** after `speak()`), so "did it begin?"
  cannot be answered in the calling task; and the failing error can arrive
  **synchronously inside `speak()` itself**, which means a naive fix that
  attaches `onerror` *after* `synth.speak(u)` would silently miss it.
- **The fix, measured the same way, in the same rig.** Five fresh browsers,
  same single click: **0/5 latched.** The trace says which mechanism did it —
  `engine.cancel@0 → ui=e1@0 → engine.speak@61 → error:synthesis-failed@61 →
  ui=null@61`. The **`onerror` handler** cleared it, immediately; neither
  watchdog was needed. That is the point worth being careful about: the fix
  addresses the *cause* (a terminal event with no handler), and the watchdogs
  are the backstop for the case where the engine says nothing at all, not the
  thing doing the work here.
- **What was *not* reproduced:** Chrome's ~15 s cutoff on long utterances. An
  1,800-character utterance here started and was still going 40 s later with no
  cutoff and no error — consistent with the null engine's simulated ~14
  characters/second (≈126 s for that text), not with a watchdog. So chunking is
  **not** what shipped: it would pay a certain ~300 ms gap at every sentence
  boundary (that measured `start` latency, once per chunk) to hedge a bug this
  container cannot demonstrate. A periodic `resume()` — free on a healthy engine
  — hedges it instead. If Joshua ever hears a reply cut off mid-sentence at
  about fifteen seconds, chunking is the fallback and `tts.ts` is where it goes.

### Auto-read, read out of the live page

A recorder wrapping `speechSynthesis.speak` (still delegating) says what the
shipped client asked to have said, and when:

- **The toggle round-trips and speaks its own confirmation.** Click →
  `checked`, `jlcode.tts.autoRead = "true"`, and one utterance: *"Auto-read is
  on."* That click is both the preference and the gesture.
- **A settled reply is read, and it is the reply.** Posting a turn produced
  exactly one utterance, `"You said: Tell me what changed in the notifications
  cluster."` — at settle, not during the stream.
- **A pause reads why it stopped, not the prose before it.** An `ask:` pause
  produced `"A question for you. Should the migration run now? Options: Yes,
  No."` That is X-13 (b) working end to end: the question, and its options, and
  nothing about the paragraph above it.
- **A background session says nothing.** A second session was posted a turn
  while the first was on screen; it settled; **zero** utterances.
- **…and switching to it stays silent.** Focusing that session afterwards
  produced **zero** utterances — it does not read out what it said while you
  were away. It has already blipped; it is history by the time you look.
- **Typing stops it mid-sentence.** One `input` event on the composer → exactly
  **one** `cancel()`.
- **Nothing speaks before a gesture, and the design depends on this being
  sticky.** The first attempt at the reply screenshot came back with no ◼ and no
  rail row, because that tab had never been clicked — `speak()` refused, exactly
  as intended. Measured separately: a `speak()` with no gesture anywhere in the
  document's history fails `not-allowed`, but **one ordinary click is enough for
  an utterance fired from a timer fourteen seconds later** (`isActive: false`,
  `hasBeenActive: true`). That is what makes auto-read possible at all, since it
  always fires from a wire event and never from a click.

### The defect this peek caught, which no test would have

**Auto-read lit a stop button nobody could see.** A reply being read gets `.on`
on its own 🔊/◼ — but `.msg-tools` is `opacity: 0` until the turn is hovered
(P5d), which is right for an affordance you go looking for and wrong for a state
you did not ask for. So the only visible sign that the machine had started
talking was in the rail. Fixed with one rule — `.msg-tools:has(.icon.on)` stays
visible — and the reply screenshot above is after the fix: the ◼ is lit on the
message *and* the rail row is up, which is what makes "what is being read" and
"make it stop" answerable without hunting.

**Screenshot honesty.** `x13-reading-reply.png` was taken with
`speechSynthesis.speak`/`cancel` **stubbed to no-ops** — the same substitution
X-26 made with `OfflineAudioContext`, and for the same reason. This engine fails
most utterances synchronously in ~60 ms, which is not a window a shutter can
catch; a `speak` that neither fails nor ends holds the app in the state a real
voice would hold it in, until the 4 s start-watchdog resolves it. Everything
rendered in that image is the real client. `x13-rail-notify-on.png` needed no
stub at all — it caught a genuine utterance in flight.

**Not verified: any of how it sounds.** Whether the reply is pleasant to listen
to, whether *"A question for you."* is the right preamble or grates by the tenth
time, whether the default rate is too slow, and whether reading a very long
reply in full is what Joshua wants rather than a cap — none of that can be known
without a voice. Also not exercised in the browser: an approval pause read aloud
(covered at Tier-0, and the ask pause exercised the same code path), the
compaction and cap pauses, and a browser with no `speechSynthesis` at all
(unit-tested — it stays silent and returns false rather than throwing).

---

## H-08 — the fence prompt that no longer offers "just once" · 2026-08-11 · ✅ looked good

**Screenshot:** [`visual/h08-fence-no-allow-once.png`](visual/h08-fence-no-allow-once.png)

Posed with a **new `peek --mcp <file>`** (D-73) pointing at the real
`file_utils` server, on `JLCODE_PEEK_PORT=7811 / 9421`, then
`peek chat 'mcp: file_utils__read_file_range {"path":"/etc/hostname",…}'`.
Worth recording why the flag had to exist: MCP children are spawned **before the
server listens** (D-47e), so an `mcp_settings.json` written after `peek up` is
too late — which is why every MCP surface built in P7a/P7b (the status drawer,
learn-on-pause, and now this) had gone unpeeked until now.

Confirmed with my own eyes:

- **"Allow once" is absent**, not greyed. What stands in its place is the reason:
  *"This goes to an MCP server, which can remember the location — so it cannot be
  allowed just once. Widen the workspace, or deny."* Only **Remember `/etc`** and
  **Deny** remain.
- **The escape still reads as an escape** — `⚠ outside the workspace fence:` over
  the offending path, unchanged from P5b.
- **D-48's learn-on-pause still rides the same pause**, which is the property that
  made this fix cheap: *Does `file_utils__read_file_range` write anything?* and
  *Is `path` a file path?* are answered here too, so nothing about the fix costs
  the user an extra stop.
- The `COMMAND` badge and *"access outside the workspace"* reason line are the
  conservative classification doing its job: this tool is genuinely read-only, but
  the server advertises no `readOnlyHint` (the separate minor row above).

Not exercised visually: the **native**-tool fence card, which deliberately still
offers "Allow once" and is unchanged since P5b (covered by a test that asserts
the difference); and the *Remember* path itself, which widens the fence and is
covered end-to-end by the live re-run recorded in H-08.

*Cosmetic, noticed and not fixed:* the `<code>/etc</code>` inside the **Remember**
button sits low against the button's fill — it inherits the transcript's code
styling, which was never meant to sit inside a primary button.

---

## X-31 — the shared todo list · 2026-08-11 · ✅ looked good

**Screenshots:** [`visual/x31-empty.png`](visual/x31-empty.png) ·
[`visual/x31-open.png`](visual/x31-open.png) ·
[`visual/x31-editing.png`](visual/x31-editing.png) ·
[`visual/x31-start.png`](visual/x31-start.png)

Posed with `peek up` + `peek chat`, then the **person's own path** —
`curl -X PUT /session/<id>/todos` with three items, which is byte-for-byte what
the Save button sends. The fake driver cannot call a tool, so the agent's half
was exercised at Tier-0 instead; everything below is the person's half plus the
live event that carries the agent's.

Confirmed with my own eyes:

- **The empty state is one quiet line** — `TODO  no items  [start a list]` above
  the composer. It is always present rather than appearing once a list exists,
  which is what makes seeding one by hand discoverable at all.
- **The panel updated live from the PUT with no reload** — the page had been
  loaded before the list existed, so the `todos` event and its slice reducer are
  what put those three rows on screen. That is the same path an agent write takes.
- **Done reads as done**: `☑` plus a strikethrough in muted text, `2 of 3 undone`
  on the collapsed bar.
- **Edit mode hands over the whole list** — checkbox, text field, `✕` per row,
  `+ item`, and Save/Cancel. Leaving it is the commit; there is no per-keystroke
  traffic.
- **The queued nudge is visible as a queued chip**, reading *"[todo] The user
  edited the todo list — 2 of 3 items still undone…"* — the count, not the
  payload — and the session stayed `idle`: editing a list did **not** spend a
  model call on the user's behalf.
- **The user's edit is marked in the transcript** (*you edited the todo list*)
  where it happened. An agent write gets no such marker, because its `todo_write`
  tool block is already there and marking it twice would make striking six items
  look like twelve events.

**What the browser changed.** `start a list` originally opened an empty editor
with a `+ item` button — a button whose only job was to undo the emptiness. It
now opens with one row, focused, cursor in it (`x31-start.png` is after that fix).

Not exercised visually: an agent write landing **while the editor is open**,
which draws the ⚠ *"the agent changed the list while you were editing"* note —
it needs a live model to produce, and the condition behind it is a pure
comparison covered at Tier-0. Also unseen: a list long enough to hit the panel's
`30vh` scroll cap.

---

## D-77 — notes, rewording, and being told what changed · 2026-09-03 · ✅ looked good (one fix while looking)

**Screenshots:** [`visual/d77-todo-panel-notes.png`](visual/d77-todo-panel-notes.png)
(the panel: a struck item with its outcome hung under it) ·
[`visual/d77-todo-edit-notes.png`](visual/d77-todo-edit-notes.png) (edit mode:
the note field, and the ✎ that offers one to the rows without)

Posed with `peek up` plus a new fake-driver seed — `todo:` reads the list,
`todo: {json}` writes it verbatim — so the *agent's* half of the surface can be
driven offline for the first time. Sequence: read (empty), add four, then one
call that rewords one item, notes another and strikes it. The person's half was
driven through the same `PUT /session/:id/todos` the panel calls.

Confirmed with my own eyes:

- **The tool result marks what the call touched and hangs the note under its
  item**, aligned to the text column:

  ```
  Todo list (3 of 4 items still undone) — → marks what this call changed:
  → [x] td_92b039547031  read the harness
                         ↳ done — commit 6173b82
  → [ ] td_06b37c7745a9  regenerate the fixtures (~5 calls)
    [ ] td_48fa80097e7f  wire the renderer
  ```
  The untouched rows are still there, unmarked — the whole list, which is what
  makes the next write safe (D-77c).
- **The reword landed in place**: `(~2 calls)` → `(~5 calls)` on the same id,
  which is the stale-wording complaint that opened the report.
- **The panel draws the note quietly and never strikes it through.** The item
  above it is struck; the outcome under it stays readable, which is the point of
  recording it.
- **The person's save that says nothing about notes keeps them.** A `PUT` with
  the note field absent — one reword, one strike, one add, one deletion —
  returned the item with `note: "done — commit 6173b82"` intact (D-77f).
- **The queued notice says what changed**, not just how many are left:

  ```
  [todo] The user edited the todo list — 2 of 4 items still undone.
    ~ td_48fa80097e7f  wire the renderer + the panel (was: wire the renderer)
    x td_f59bd832a854  update ROADMAP
    + td_688c0acd11fb  check the favicon slice
    - td_06b37c7745a9  regenerate the fixtures (~5 calls)
  Call todo_read for the full list.
  ```
- **The barrier still re-arms after that edit** — the next blind `todo_write`
  came back `Refused: the todo list has changed since you last read it`, with the
  current list (notes and all) attached. The two mechanisms back each other up,
  which is what the field report said it valued.

**What the browser changed.** In edit mode the note started as a second
full-width input under the text — it read as a *second item*, not as a note. It
now sits behind the same `↳` the view mode and the tool result use, at the muted
size. The screenshot above is after that fix.

Not exercised visually: a note long enough to wrap, and the 12-line cap on the
edit notice (Tier-0 covers the cap; posing it by hand means pasting twenty rows
into the editor).


## P8e — the images arrive, and the drops say why · 2026-09-03 · ✅ looked good (one fix while looking)

**Screenshots:** [`visual/p8e-images.png`](visual/p8e-images.png) (both inputs
rendered: a 30 KB screenshot from `read_file`, and a picture an MCP server sent)
· [`visual/p8e-dropped.png`](visual/p8e-dropped.png) (the two refusals, expanded)

This is the peek the **whole phase exists for**: `peek.mjs shot` writes the
screenshots *I* look at while building JLCode, and until P8a its own agent got a
page of U+FFFD instead. Posed with `peek up --mcp <settings>` pointing at
`test/fixtures/mcp-test-server.mjs`, whose new `screenshot` tool returns a real
`image` content block; the peek config now carries `acceptsImages: true`, because
the peek's model id is deliberately unlisted so the catalog says `unknown` and
P8b collapses that to text-only — without it every image surface is unpeekable.

Confirmed with my own eyes:

- **`read: screenshot.png`** — the transcript block shows the picture itself,
  capped at 320×220 with `screenshot.png` under it, and the fake model's reply
  says `I can see the image: screenshot.png` — i.e. the flush really did put an
  `image_url` part in the user message after the tool result (P8b), driven
  through the built `dist`, not a fixture.
- **`mcp: shots__screenshot {}`** — the input that was being discarded renders
  the same way, captioned `shots/screenshot image 1`, which is the *same* label
  the wire's text part uses. The picture and the sentence about it cannot drift.
- **The images show while the block is collapsed.** A picture is the result, not
  noise behind a caret; the caret still hides the text half.
- **A drop is never silent.** `{"kind":"lying"}` (a text body labelled
  `image/png`) reads `[image claimed as image/png, 16 B — dropped: the bytes are
  text, not one of image/png, …]`, and `{"kind":"big"}` reads `[image image/png,
  6.0 MB — dropped: over the 5.0 MB an image may be to go to the model]` — with
  the server's own `here is a big shot` line still above it.

**What the browser changed while looking.** The first shot rendered the MCP
server's 24×16 PNG blown up to 320px: `.tool-image` is a flex *column*, so its
default `align-items: stretch` was resizing the `<img>` to the block's width. A
tiny icon has to look tiny — that is information about what the model was handed.
`align-items: flex-start` fixes it; the screenshot above is after that fix.

Not exercised visually: many images in one turn (the flush groups them, Tier-0
covers the wire shape), and a conversation reloaded from history — the URL a cold
`GET /conversation/:id` advertises is asserted to be byte-identical in Tier-1
instead.
