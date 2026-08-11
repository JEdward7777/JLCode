# JLCode — Roadmap

Status: **building.** Architecture settled ([`DECISIONS.md`](DECISIONS.md) D-01…D-44e, no open
items). Phases **0–6 done** (M1 "talk to a client" + M2 "does real work" + M3 "real product" + **M4
"Fable-proof at scale"** all complete; the HTTP browser frontend P5a…P5f and the compaction slices
P6a…P6c all shipped). **Phase 6 — compaction (M4) — is DONE:** headless trigger detection (P6a) +
the safe-harbor engine (P6b) + trigger-mode UX, the cross-model summary path, and the live Fable
validation (P6c). Stack: **React + Vite** (D-39); serving/auth is a **CLI serve-mode surface**
(D-40). **Milestone M4 reached (O-02 resolved by design, D-38). Next: post-v1 backlog** (see
"Later" + the H-01 hardening item).

Principle: **bottom-up, runnable early.** Each phase leaves something that works and is
testable at the free tiers ([`TESTING.md`](TESTING.md) Tiers 0–1).

## Current status — resume here

> **When you update this block, check [`../README.md`](../README.md) too.** The README is the
> public face of the repo and deliberately carries **no status of its own** — it points here — but
> a phase that changes *how a user runs or drives JLCode* (new command, new flag, a different
> front end) does belong in the README. Keep the two from drifting; that is what stale-status rot
> looks like.

> **Resume block — 2026-08-11 (second pass).** Phases 0–7 are done, and **X-31 — the agent's
> shared todo list — is built and pushed (D-74)**, which empties Joshua's observed-items list
> entirely: all five are now filed *and* fixed. **752 Tier-0/1 green, 64 files.** X-31 is state
> folded from `todo` ops on the conversation's branch (D-37's model), so it survives resume, fork,
> rewind **and compaction**; the agent addresses items by exact text or by a stable id, a miss fails
> loudly with the list attached, and writes are barred until it has read — a barrier that re-arms
> whenever the person edits, and that one look clears. The browser half is a panel between the thread
> and the composer: leaving edit mode is the commit, and it queues a nudge stating the count without
> spending a model call. Peeked in a real browser (VISUAL-LOG "X-31").
>
> **X-32 … X-35 are triaged (D-75, 2026-08-11)** — the field report Joshua relayed from Opus 5
> driving JLCode. Outcomes: **X-32 is closed no-fix** (the per-call ceiling could be stamped, but the
> *meter* cannot exist — the only channel to a generating model is a prompt already sent; D-30's
> truncation notice stays the whole answer). **X-33 is scoped down to what already exists**: the
> watchdog has always asked *the model* (`decide_kill`, out-of-band), so the work is exposing
> `watchdogMs` in config, telling the model in `run_command`'s description that the check exists —
> today it claims "there is no timeout" — and adding a per-call `timeout` for the scale 30 minutes
> cannot cover; the background/poll/tail half is split to **X-36**. **X-34 is deferred with its
> sizing done** and is an MCP question, not a native one: npm `tree-sitter-wasms` = 39 grammars /
> 51.7 MB, Python `tree-sitter-language-pack` = 371 languages / 7.7 MB over the `uvx` path P7c
> validated; Joshua leans a **separate server** over `file_utils`, to decide again later. **X-35 both
> build** — `cwd` on `run_command`, and a refused `apply_edits` naming the sibling file its anchor
> would have matched, only when that is exactly one site in exactly one other file.
> **X-33 and X-35 are built and pushed (D-76). 784 Tier-0/1 green, 65 files.** `run_command` gained
> `cwd` (a fenced path arg, so an out-of-fence directory asks first) and `timeout` (seconds; kills
> through the registry as a fourth `KillReason`, so a timed-out task reads as killed everywhere and
> the note names it as the caller's bound rather than a failure of the command). The watchdog
> interval is `commands.watchdogMinutes` (`config set <n> --command-watchdog 5|off|default`), read
> **once** in the factory and handed to both the timer and `run_command`'s description — asserted
> together in `serve-context-window.test.ts`, the file H-06 created, because a description promising
> a check the timer will not honour is worse than the original defect. `apply_edits` now names the
> sibling file a missing anchor would have matched, when that is exactly one site in exactly one
> other file of the batch; the refusal is otherwise unchanged and never redirects. No browser peek:
> the task panel lists only *running* tasks and never rendered a kill reason, so nothing new is
> drawn. Also open and unblocked: X-14, X-16, X-18, and X-34/X-36 as deferred rows. The earlier stretch (P6c → P7c) fixed, in order: H-06 (D-60), X-24 (D-61), X-27 (D-62), X-23
> (D-63), X-25 (D-64), X-26 (D-65), X-17 (D-66), the peek tool's port + click (D-67), the config
> loader's whitelist (D-68), X-15 (D-69), X-13 and H-07 (D-70), X-29/X-30 (D-71), X-28 (D-72), and
> H-08 (D-73). Upstream, `file_utils`' `uvx` crash is capped and **merged by Joshua** as PR #1.
> Standing calls to carry forward: free tiers only unless he says otherwise (**ask every time**),
> push after a green commit on `main`, prefer **rebase over merge**, and the "Later" list keeps every
> row and strikes the shipped ones.

Built, tested (**732 Tier-0/1 tests green**, + 2 live Fable tests that replay free from the committed
cache), and committed through **P6c — Phases 0–6 done, Milestone M4 reached**:

> **Cost (2026-08-04, D-58/D-59).** Two compounding defects found by reading the debug journal of a
> real **$120.84** conversation. (1) **D-26 was never implemented** — `cachedTokens` was `0` on every
> call of every conversation JLCode had ever run, so 23.9M prompt tokens billed at full price;
> breakpoints now ship, **live-verified** against `anthropic/claude-opus-5` on Amazon Bedrock
> (cold call wrote 20,314 tokens at the 1.25x premium, warm call read 20,312 at the 0.1x rate —
> **12.3x cheaper**). (2) **`grep` capped match count but not output size** — three single-line
> `.js.map` files in `node_modules` produced one 706KB (~347k-token) tool result that the
> append-only transcript then re-sent 58 times; it *was* the huge prefix. Same search on the same
> tree now returns 54.8KB. Neither defect ever errored, which is why both survived to production —
> an uncached request is a *correct* request that costs 8x more.

- **P0** scaffold (npx `jlcode` bin, config/data dirs, rotating diagnostic logger, CI).
- **P1** config store + folder-aware model selection (`config list/which/use/clone/add/set/remove`;
  keys via stdin or `JLCODE_ADD_KEY`; `config.json` chmod 600).
- **P2** OpenRouter client (streaming, verbatim reasoning, request-keyed cache `src/llm/cache.ts`
  + `CachingDriver` — proven to serve hits without calling the model) + conversation tree/wire +
  Session/SessionManager + `chat` REPL. Truncation (D-30) + circuit breaker (D-32).
- **P3a** sandbox + native tools (read/write/delete/list/glob/grep + run_command) + tool loop.
- **P3b** mode∩approval gate + pause→approve/deny/**edit** + `ask_user`; **soft fence** (D-19):
  out-of-fence access prompts allow-once / remember-root (persisted `folderRoots`) / deny.
- **P4 (in progress):** `AppendLog` (D-37 — single serialized async queue per file, no locks) +
  `ConversationStore` (append-only JSONL per conversation, injectable dir) + Session emits `entry`
  events + resume from a loaded conversation. **Wired into the dev server:** `/chat` resumes via
  `conversationId`, `GET /conversations?dir=` history, `GET /conversation/:id` from disk; store
  flushed on `/shutdown`; `/chat`, `/approve`, `/answer` **flush before responding**
  (read-your-writes). **Live-validated cross-process restart-resume** (two server processes,
  shared data dir, isolated from real history). **Fork/rewind:** `setActiveLeaf` (rewind/switch),
  `editFork` (pencil-edit = sibling branch), persisted `active-leaf` so resume restores the viewed
  branch; server `/session/:id/rewind` + `/edit`; entries expose id/parent. **Debug journal**
  (D-15): per-conversation verbose per-turn record (llm request summary/result/timing/usage +
  tool I/O + errors) via `DebugJournal`, `GET /conversation/:id/journal`. **Phase 4 done.**
- **Dev harness (beyond the phase list):** `jlcode serve` HTTP endpoint (`/chat`, `/session/:id`,
  `/approve`, `/answer`, `/config`, `/health`, `POST /shutdown`); `serve --config <name>` pins a
  config; server re-resolves config live; sandbox fenced to the launch dir. Fake echo driver via
  `JLCODE_FAKE_LLM=1`. This is how conversations/tools are driven & tested (incl. by the agent).

**Live-validated** (real gpt-4o-mini, deepseek-r1): multi-turn memory, truncation, reasoning
capture, gated tool read/write verified on disk, sandbox fence (approve→still-fenced then soft
allow/remember), `/shutdown`.

**Known carve-outs:** background-task **kill** (D-34) rides with P5; the request-keyed cache is
built but not yet wired as the live record/replay layer (Tier-1) or the runtime feature (§21);
`chat` REPL has no tools (tool flow is server-only so far); tools not wired into the live agent
outside `serve`.

To resume: `npm install && npm run build && npm test`, read this file + `DECISIONS.md`, then
continue at the next unchecked phase below. **Phase 5 (P5a…P5f) is COMPLETE** (P5a: React+Vite
client, SSE/POST bus, streaming markdown chat; P5b: browser approvals with edit-before-approve,
multi-question ask_user, live mode/approval controls, out-of-fence soft-fence prompts; P5c:
whole-tree spend + settable cap, queued message, background-task kill + 30-min watchdog, two-mode
global stop; P5d: tree-driven view with inline branch arrows + pencil edit-fork, per-turn + drawer
debug-journal viewer, real lazy-loaded Mermaid + inline images, TTS; P5e: concurrent sessions —
left rail of N live sessions, one multiplexed per-instance bus, close-to-stop; **P5f: serve
modes & auth — outward bind requires a hashed password, three provisioning modes, httpOnly signed
session cookie + one-hit setup URL, guard over every route** — all verified end-to-end in Chrome,
see [`VISUAL-LOG.md`](VISUAL-LOG.md)). **Phase 6 — compaction (M4), sliced P6a…P6c** (engine →
controls → live-validation; see the Phase 6 block below) is underway. **P6a + P6b are done.** P6a:
headless token-accounting + trigger detection — the session emits `needs-compaction` from
ground-truth usage one turn late, `budget = window − buffer` with an **injected** window (config
`contextLength` fallback), compactor-fit guard, over-window hard-wall hook (**D-44/D-44c**). **P6b:
the safe-harbor compaction engine** — `Session.compact()` folds the active branch into a
`compaction` overlay entry (`replayCut` + summary) so the wire replays only `system + summary`;
**cache-reuse same-model path** (D-29) sends the exact live prefix + an ephemeral
`tool_choice:"none"` instruction; **anchored evolving structured summary** with bookend quoting
(D-28); **auto** trigger mode compacts in-loop before the next send; the **D-44b over-window
fallback** compacts (forced, tool-output-truncated input) and retries once. Safe-harbor cuts at the
tip because the append-only tree can't keep a tail (**D-44d**). Pure pieces in
`src/session/compaction.ts`. **P6c is DONE** (D-44e): the five trigger modes are drivable in the
browser (header selector + `auto`/`manual`/`suggest`/`cancelable`/`hard`, with a real
`awaiting-compaction` pre-send pause for the blocking two); the **cross-model summary path** sends
structured messages to a cheaper compactor id (readable planning kept, signed `reasoning_details`
dropped, tool outputs truncated); and the **Fable tier ran live** — the D-14 verbatim reasoning
round-trip and the safe-harbor-compaction-accepted-by-Fable tests are recorded into the committed
cache (`test/helpers/{live,judge}.ts`) and replay free. **Phase 6 / Milestone M4 complete.** Stack
decided in D-39; serve-mode/auth in D-40. **194 Tier-0/1 tests green** (+ 2 replayed Fable tests).
**H-01 is now FIXED (D-46)** — persistence failures stop the session with a recoverable Retry
banner, and append logs retain no file descriptors. **D-25 (minimize-deps) is RETIRED by D-45:**
use the mainline library when one fits; treat surviving `D-25` citations in code comments as
historical, not a live constraint.

**Post-v1 work started: Phase 7 — the MCP client (X-01), design in D-47.** **P7a is done**
(2026-07-28): `src/mcp/` holds settings loading (KiloCode's `mcp_settings.json` shape, global +
per-workspace override), a stdio client manager over `@modelcontextprotocol/sdk` (one child per
server per instance, failures reported not fatal), and the bridge that turns each discovered MCP
tool into a native `Tool` — namespaced `<server>__<tool>`, classified conservatively unless
`readOnlyHint`, `alwaysAllow` honored as pre-approval, and args flattened to jq-style field names
for the learned `pathFields`/`notPathFields` fence lists. `jlcode mcp list|import|path` ships with
it, and `serve` starts the servers. **P7b is done** (2026-07-28): **learn-on-pause (D-48)** —
a pause that is happening anyway also settles JLCode's two guesses about an MCP call (*does this
tool write?*, *is this field a path?*), answered in the browser and persisted into the owning
`mcp_settings.json` (`writeTools`/`readTools` beside `pathFields`/`notPathFields`). It never stops
just to ask: under `full-auto` with in-fence args the call runs unattended. A mode/policy denial
resting only on the presumed write (Ask mode, `read-only`) becomes the write question instead of a
silent wall. Plus `GET /mcp` and a read-only **MCP status drawer** in the browser.

**H-02 fixed (D-49, 2026-07-28), out of band from the phase plan** — found the first time Opus 5
was driven through OpenRouter for real. OpenRouter routed turn 3 of a conversation to a different
Anthropic backend than turn 1, and the replayed `reasoning_details` were rejected
(`Invalid signature in thinking block`). Turns now record the backend that served them, and later
requests pin to it (`allow_fallbacks:false`), with the pin derived from the replayed window so
compaction releases it.

**H-03 fixed (2026-07-28)** — Ctrl-C couldn't stop `serve` while a browser tab was open (the
never-ending SSE bus kept `server.close()` waiting), and that handler also skipped the durability
flush. Both paths now share one teardown that flushes, then force-closes the sockets; a second
Ctrl-C exits immediately.

**H-04 fixed (2026-07-28)** — the real cause of the `Invalid signature in thinking block`
failures. Streamed `reasoning_details` arrive as deltas keyed by `index` (text in pieces, the
signature in a final fragment); we appended them instead of merging, so every signed thinking
block was stored as several partial ones plus an orphan signature. Found *because* D-49's journal
fields showed the provider pin working while the call still failed — which ruled out routing and
pointed at the payload.

**H-05 fixed (2026-07-31)** — forking or switching branches *while a turn was running* re-parented
the in-flight reply, and a rejected edit still moved the pointer. Fixed the agreed way: a turn now
**pins its parent at turn start** and every entry it appends chains off that pin, so branch
navigation is genuinely passive (SPEC §27) and you can read a sibling while a turn works. The
pointer follows an append only when the append continues the branch it points at (`appendEntry`,
and `load()` mirrors it); `editFork` checks busy *before* moving and routes the move through
`setActiveLeaf` so it is announced and persisted. The invariant this establishes — *a turn's
entries belong to the branch that turn started on* — is the correctness floor under **X-14**
(multiple agents live on different forks), which is now unblocked. See D-54.

**Conversations recorded before H-04 are unrecoverable** — fragmented reasoning is on disk and the
append-only log isn't rewritten. If one fails on resume with `Invalid signature`, start a new
conversation; a repair-on-read that assembles fragments at wire-build time was considered and
**not** built (offer it before assuming it's wanted).

**Also settled 2026-07-28 (D-50): config editing stays manual** — no `config set --key`, no
live-config reload into running sessions. Both gaps are real and both were deliberately declined;
don't re-propose them unprompted. Backlog additions from real use: **X-09** conversation labels,
**X-10** workspace/cwd in the page + tab title, **X-11** tool output kept visible in the
transcript, **X-16** reasoning notes default-open (the first browser-side UI preference — no
`localStorage` use exists yet, so that slice defines the mechanism X-13's toggle should share). Push discipline changed the same day — **push after every green commit** (CLAUDE.md),
because `npx github:…` is how JLCode is launched; note npx caches by *spec string*, so a push
alone doesn't reach the user.

**D-52 shipped 2026-07-28 — queued messages actually get consumed (bug fix).** Joshua reported a
queued message sitting unconsumed through a whole run; the live `cv_9bbb7bb76b12` log confirmed it —
**one** user entry after fifty entries of tool calls. `drainQueue()` was only reachable at the bottom
of `advance()`, so the "turn boundary" D-34 promised was really the *settle to idle*: during a long
autonomous run the queue waited for the agent to finish everything, which is exactly when it is
useless. Now `flushPendingUser()` (the D-51 seam) appends the queue as user entries at **each pass of
the tool loop**, before the next LLM call, flushing **all** pending messages in order. It never
splits a tool batch, and it is held back behind a stop (a stopped loop takes no further turn, so an
injected message would strand unanswered). The settle-time `drainQueue()` remains for the message
that arrives after a run's last LLM call. Peeked in Chrome (VISUAL-LOG "D-52").

**D-51 shipped 2026-07-28 — a pause is an opening to speak.** Whatever is sitting in the composer
when you click **Approve** or **Deny** rides along with the decision (`note` on `ApprovalDecision`)
and lands in the transcript as an ordinary **user** entry, so it is in the replayed window on the
*very next* call. Before this the queue was the only outlet, and a queued message applies at the
next **turn boundary** — after the whole tool loop finishes — far too late to steer the call you are
looking at. Two mechanics to preserve: the note is **held until the tool batch drains**
(`flushNote()` only runs with `pendingToolCalls` empty — a user turn wedged between two tool results
of one assistant message is malformed on the wire), and **Enter still queues** while a card is up so
"after this finishes, do X" keeps working; the placeholder names both. Approvals only — `ask_user`
already has its own free-text field. Peeked in Chrome (VISUAL-LOG "D-51").

**X-11 shipped 2026-07-28 — tool output now stays in the transcript.** A `tool` block renders
**inline, in flow** (Joshua's call): collapsed to tool name + argument gist + a size hint
(`2 lines · 40 B`), expanded to the pretty-printed args and the **full** output — the journal's
200-char preview was never a substitute for reading real output. Errors read distinctly, and a wide
line scrolls inside its own box, never the page (measured in Chrome). `entryView` gained
`toolCallId` + the assistant call `id` so a result pairs with the arguments it ran on, and **live
`entry` events now go over SSE through that same projection** — one shape whether you watched it
arrive or reloaded, and the opaque signed `reasoning` blobs (D-14) stop being pushed to every tab.

**X-10 shipped 2026-07-28 — you can tell two instances apart.** `GET /config` carries the
instance's `workingDir` (+ `homeDir` so the browser can shorten it); the rail header shows
`~/work2/…/JLCode` with the full path on hover, and the **tab title is the project folder name**
(Joshua's call — "JLCode" names the tool, not the project). `tabTitle()` already takes an optional
label first, which is where X-09 plugs in.

**X-09 shipped 2026-07-28 — threads have names.** Joshua's design for the auto title: after the
first exchange, an **ephemeral** question is tagged onto the end of the live conversation and asked
of the **active** model (`tool_choice:"none"`, small `max_tokens`) — never appended to the tree, so
nothing has to be flattened and the same prompt-cache reuse that makes same-model compaction cheap
(D-29) applies. It is **opt-in per session** (`SessionOptions.autoTitle`, on under `serve`) because
it costs one extra call, and it runs **once**: a failure leaves the thread unnamed rather than
costing a turn, and a hand-picked name pins. Titles are append-only records in the conversation log
*and* `index.jsonl` (newest wins), so `GET /conversations` labels history for free and old logs
simply stay untitled. The rail renames in place via `POST /session/:id/title`, and the tab reads
`<label> — <folder>`. The fake agent driver answers the title question offline so this is peekable
without spend.

**Found while scoping X-09 and logged as X-12: there is no browser history list.** The endpoints
have existed since Phase 4 (`GET /conversations`, `GET /conversation/:id`, resume-by-id) but no P5
slice ever built a UI over them — so "close a session, it's recoverable from history" means
recoverable by API, not by clicking. Not dropped on purpose; it fell between the phases.

**X-12 designed 2026-07-28, not yet built — start a fresh thread here.** The browser history list
now has a settled design (full note at the end of the Deferred table in
[`DECISIONS.md`](DECISIONS.md); read it before writing code). It is mostly a UI slice: the cwd
filter + show-all and the `createdAt` sort need **no** backend change, and resume-without-duplicate
already holds by construction. Three small server additions: a `{kind:"deleted", id, deleted:true}`
**masking** record folded out of `list()` (delete never unlinks — Joshua wants to be able to flip
the flag back by hand), a conversation-scoped `POST /conversation/:id/title` that routes through a
live session when one holds that id, and a `conversationId` (+ optional `leaf`) fallback in `/chat`
so a peek's first message — and a stale browser tab — materializes the session lazily instead of
404ing. A peek itself creates no session and no rail card. Auto-re-titling on drift was split out as
**X-17** and is explicitly *not* part of this slice.

**Filed 2026-07-31: X-19 — a browser affordance for model presets** (switch the selected preset for
this workspace; edit a preset's settings). Presets are CLI-only today and `GET /config` is
read-only, so changing model means leaving the page — impossible under P5f outward bind. Joshua
raised it, which is the prompting **D-50** asked for; D-50 still governs the *how* (an edit reaches
new sessions only, and must say so), and the key field stays a hand-edit. Full row in
[`DECISIONS.md`](DECISIONS.md).

**X-12a shipped 2026-07-31 — you can open an old conversation from the page.** The endpoints had
existed since Phase 4 with no UI over them; now the rail carries **HISTORY** under **LIVE** (Joshua's
placement call — one rail, two temperatures of the same concept), each section independently
scrolling and collapsible, split by a draggable divider whose position persists. Clicking a row
**peeks**: the transcript renders read-only from `GET /conversation/:id` with branch arrows that move
a *local* leaf — no `Session`, no rail card, nothing written, not even an `active-leaf` record — while
a running turn keeps streaming behind it. **Typing is the promotion**: `/chat` now takes
`conversationId` (+ optional `leaf`) and materializes the session, continuing the branch you were
looking at. That same fallback heals a **stale browser tab** across a restart, and it **attaches** to
a live session already on that conversation rather than duplicating it (the X-14 hazard). Also fixed
in here: `list()` compared `workingDir` as a raw string, so a symlinked or trailing-slash launch path
split one project into two invisible buckets — both sides are canonicalized now. Pre-H-04 logs get a
"can't be resumed, start a fresh thread" card instead of a raw provider error (`isUnresumable`).
First browser-side preference mechanism lands as `web/src/prefs.ts` — **X-16 and X-13 add keys to it,
they do not grow a second path**. Peeked in Chrome (VISUAL-LOG "X-12a"), where two layout calls were
made that mocks could not have caught: the live section holds a *cap* rather than a fixed height, and
the divider renders only when there is something to resize.

**D-53 shipped 2026-07-31 — `apply_edits`, a native anchor-based multi-edit tool.** Joshua found the
agent writing throwaway Python into `/tmp` to edit files and asked what flexibility it was giving
itself; the nine recovered scripts (2026-07-30, the discogs bridge) were the design input. The motive
was cost, not preference: **17** anchored edits to a **107 KB** `shopify_adapter.py`, which through
whole-file `write_file` is ~27K tokens *per edit*. Every script asserted `src.count(anchor) == 1`
before writing and used an explicit `count=3` where three sites were meant — **the model invented the
safety rail**, which is why the native tool takes an integer `expected_count` (default 1) rather than
a `replace_all` boolean: a file that disagrees is drift the model must see, not something to absorb.
Shape (Joshua's call — "go for the moon"): one call edits **many anchors across many files**,
`{files:[{path,edits:[{old_string,new_string,expected_count?}]}]}`, **all-or-nothing across the whole
batch** — every anchor is located before *any* file is written. Literal anchors only (a config toggle
stays a `sed` one-liner). Edits apply to an in-memory buffer in order, so a later anchor may match
what an earlier edit produced. Fenced via `classifyPaths` on the nested `files[].path` (no D-48
learning — nothing here is a guess). Two gaps closed in the same slice: **`read_file` gained
`offset`/`limit`** (it capped at 100,000 chars with no paging, so the agent was anchoring into a
107,227-char file **whose tail it had never seen**), and a new `Tool.preview()` seam renders the
pending call as a **read-only unified diff** on the approval card (`diff` dep, D-45), with the raw
JSON still the editable truth (D-16) but now collapsed by default. Planning *is* the preview, so a
batch that cannot apply shows its reason **before** you approve rather than after. On D-30: this is a
*replacing* op, and a truncated call stays unparseable JSON that `tryExecute` rejects atomically —
nothing in the new code repairs partial args. Peeked in Chrome (VISUAL-LOG "D-53"), where approving a
batch with one bad file was confirmed to write **nothing**.

**Filed 2026-08-02, FIXED 2026-08-06 — see the X-12b block in the status section above: X-12b now has
its own row in [`DECISIONS.md`](DECISIONS.md)** — it was only a
parenthetical on the X-12a row, which reads as done when only the *decision* is done. Joshua, from
real use: *"the History items do not have an X to delete them… we decided they are not actually
deleted but just marked in the index as deleted. But there isn't any way that I can see to do that
marking."* Confirmed: none of the masking is code — `IndexRow` has no `deleted` field, `list()` folds
newest-wins for `title` only, and the server has no mutating conversation-scoped route. The slice is
three parts: (1) **delete = the reversible masking flag** (index only, so there's one flag to
hand-flip), with a hover `×` on the row and a confirm that names the thread; (2) **rename from a
history row** (`POST /conversation/:id/title`, routed through a live session if one holds that id, or
the rail card goes stale); (3) **an empty session shouldn't join history at all** — `startSession`
writes the index row eagerly at construction (`server.ts:223`), so closing a thread you never typed
into leaves an untitled stub. Prefer deferring `create()` to the first entry over masking-on-close;
audit what reads the index during the live-but-silent window first.

**Landed 2026-08-04: D-55 (grep) and D-56 (serve ports)** — two small correctness slices, both from
real use. **D-55**: `grep` no longer reports an absence it did not verify — a file may be named as
`path`, a missing path is an error rather than an empty result, the 2000-file scan cap is gone (a
cap on *matches* is honest; a cap on *files* just stops the tool looking and then answers "no
matches" for files it never opened), and every uncovered case is stated in the result. Enumeration
moved off `fs.globSync` onto a `walkFiles` generator, because `**` does not descend into
dot-directories. **D-56**: `serve` walks past a busy *default* port (4517 → the block above it →
an OS-assigned port) instead of dying on an unhandled `EADDRINUSE`, while a port you asked for by
name still fails loudly; banner URLs now come from `server.address()`, not the flag.

**Filed 2026-08-04: X-20 — `glob` is still blind to dot-directories.** D-55 fixed this for `grep`
and deliberately scoped itself there, but `glob` is still `fs.globSync(pattern)`
(`src/tools/file-tools.ts`), so `**/*` cannot see `.github/`, `.env`, `.vscode/` or any other
dot-path — verified in this repo, where `**/*.yml` answers `[]` while `.github/workflows/ci.yml`
sits right there. Same defect, same silent-false-negative shape, and `walkFiles` now exists to fix
it. Open
question to settle first: `glob` also carries a 500-match cap and no `node_modules` exclusion, so
decide the cap/exclusion story for both tools at once rather than twice — D-55's answer for `grep`
(no file cap, `.git` only) means a repo-root search now reads all of `node_modules`, which is
~8s cold on this repo and scales with the tree.

**Landed 2026-08-04: D-57 — a Retry button.** From real use: an OpenRouter *out of credits* error
ended a turn with no way to resume it. A failed attempt appends nothing, so re-running the loop
rebuilds an identical prefix — which makes Retry one act (*throw away this attempt and make it
again*) with three doors: after an error, after the breaker tripped (resetting it), and against a
**running** request that has gone silent for 20s, where it aborts only the LLM stream and leaves
tasks/queue alone. Transient failures (429/408/5xx/network) are re-sent automatically with backoff
first, so the button is reserved for what a machine cannot fix; the client now throws a typed
`HttpError` to keep that split off message-regexes. `POST /session/:id/retry`; peeked in the
browser across all four surfaces (`VISUAL-LOG.md`). Carries the **re-sync seam** X-21 needs —
`GET /session/:id/state` + `resync(id)` — since retry's own failed-POST path has the same
"did that land?" problem; see the correction in the X-21 row.

**Filed 2026-08-04: X-21 — a failed approve/answer POST strands the browser out of sync with the
session.** From real use (Joshua, session `sess_f430000fc69c`): a network error while resolving an
approval, then every subsequent message bounced with *"Session is waiting for input; resolve it
before sending."* and no card on screen to resolve. The server was right and the browser was wrong.
`resolveApproval` (`web/src/App.tsx:399`) clears the card **optimistically** —
`patch: { pendingApproval: null, working: true }` — then `await apiApprove(...)`, and its `catch`
only paints `notice`; it never restores `pendingApproval`. So a POST that fails leaves the server in
`awaiting-approval` with the client believing nothing is pending: the composer re-enables, `/chat`
relays `assertCanSend`'s throw (`src/session/session.ts:828`) and the user is told to resolve
something the UI has stopped showing. Nothing re-syncs, because the failure was on the POST and the
SSE bus stayed up — no fresh `roster` frame arrives to correct the slice. Verified live: the running
npx build had `status:"awaiting-approval"` holding a `write_file` on
`FeatureFlagsDiagnostics.tsx`, its conversation log ended on an assistant entry with a tool call and
no result, and the shipped bundle (`dist/web/assets/index-*.js`) carries the same optimistic clear.
**`submitAnswer` (`App.tsx:421`) has the identical hole** for `ask_user`/`pendingAsk`. Fix on the
`catch` path: **re-fetch the settled state and `applyState` the response** rather than restoring
the local copy — the POST may have landed with only the reply lost, and resurrecting a card the
session already consumed is its own bug; the server's settled state is the only honest answer, and
`applyState` (`web/src/session-state.ts`) already folds `approvalRequest`/`question` back in, which
is why a plain page reload cures it today. **Correction (D-57, 2026-08-04): not from `GET
/session/:id`** — that route answers with the *tree* (entries + leaf) and carries no
`approvalRequest`/`question`, so folding it through `applyState` sets `pendingApproval = null`,
which is precisely the state the stranded browser is already stuck in: the fix as originally written
would look right and do nothing. A page reload cures it because the pause arrives on the SSE
`ready`/roster frame (built by `stateOf`), not from that GET. The seam now exists — **`GET
/session/:id/state` → `stateOf(session)`**, with `api.fetchSessionState` and an App-level
`resync(id)` dispatching `{t:"state"}` — landed with D-57, which needed it for its own failed-POST
path. X-21 is then the two remaining call sites (`resolveApproval`, `submitAnswer`) calling
`resync`, plus the `appr_…` addressing below, which is the substantive half. **Second defect, found by Joshua while reading this row —
`/approve` is not addressed to a request.** The route (`src/server/server.ts:681`) checks only
`session.status !== "awaiting-approval"` and then applies the decision to whatever is pending *at
arrival*; the server mints `appr_…` (`session.ts:1306`) and ships it to the browser, but the browser
never sends it back, and `/answer` is the same (no question id). So a duplicate or late-delivered
decision can land on **a different tool call than the one the user read** — and since `/approve`
runs the tool inline before responding, a network error genuinely can mean *the patch applied and
the reply was lost*. The re-fetch above keeps the user from re-approving a call that already ran,
but it cannot make the POST itself safe: **send the `appr_…` id with the decision and 409 when it
doesn't match the pending request** (same for `/answer`). That makes double-submit safe by
construction and turns "did my decision land?" into an answerable question. Don't lean on the tools
being idempotent — `apply_edits` would probably fail its anchor match on a re-run and `write_file`
overwrites the same bytes, but `run_command` is not idempotent at all, and no fix should require the
user to reason about the race (*"click Deny this time"* is not a fix). Related UI call: when the
re-fetch shows the **next** request in a batch right after a failed click, the card must read as a
new request, not as the retry of the one that just errored — otherwise the reflex click approves
something unread. Two more notes for whoever picks it up: (1) `/chat`'s message
says *"waiting for input"* for an **approval** pause too, which sends you hunting for a question
that was never asked — the three awaiting states are distinguishable and the copy should say which
one; (2) this overlaps the in-flight D-57 retry work, which is already editing `App.tsx` and
`session-state.ts` — same failure family (a request that didn't land), so land it after D-57 and
consider whether the reconnect/re-sync belongs in one place rather than per call site.

**Filed 2026-08-04: X-22 — a requested-but-not-yet-run tool call is not durable, and the log it
leaves behind cannot be replayed.** Raised by Joshua while reading X-21, asking whether the real
defect is that we have no way to represent "this has already happened but hasn't been LLM'd yet".
Close, and worth stating precisely, because one of the two boundaries is fine and the other is not.
**Fine:** *tool ran, model hasn't answered yet.* `tool` is a first-class entry type with its own
`parent` link, written as the result lands, and `buildWireMessages` (`src/conversation/wire.ts:40`)
replays it as a `role:"tool"` message — kill the process there and resume simply owes an LLM call.
**Not fine:** *model asked for a tool and it hasn't run yet.* Two gaps. (1) **The intent is
in-memory only** — `pendingToolCalls` and `pendingApproval` (`src/session/session.ts:216`) are
plain fields; nothing in `src/persist/` has ever heard of them, so a kill loses the queue of
un-run calls and keeps only the assistant entry that requested them. (2) **What survives is
unreplayable**: verified by running `buildWireMessages` over a conversation whose leaf is an
assistant entry with `toolCalls` and no matching `tool` entry — it emits `assistant(tool_calls)`
followed by the next `user` message, with nothing synthesizing the missing result, and every
provider requires each `tool_use` to be answered by a `tool_result`. Nothing repairs this on load.
A live fixture exists: `cv_9c76e3ad2172` sits in exactly this state on disk. Same *shape* as X-12's
`Invalid signature` trap — a log that reads fine and cannot be picked back up. Two directions,
probably both: **(a) repair on read** — close a dangling call at *wire-build* time with a synthetic
`tool_result` ("not run — session ended"), which makes every existing log replayable and, being a
wire-build concern, rewrites nothing (the log is append-only by design and X-12 already committed to
never rewriting it); **(b) persist the pending batch and its approval** as a durable record so
resume re-raises the approval instead of discarding the work. (a) is the floor that stops data
loss from becoming a dead thread; (b) is what actually resumes it. **Do (b) with the id** —
`appr_…`/tool-call id in the record — because that is also the structural fix for X-21: reconnect,
page reload, process restart and a duplicate POST all collapse into one idempotent operation (read
the pending record, compare ids, act at most once) instead of four separately-handled cases. X-21
is this same gap seen from the browser; it can be fixed first and cheaply, but this row is the one
that makes it impossible.

**H-06 FIXED 2026-08-06 (D-60) — every session now knows its context window.** The deferred D-44c
`/models` fetch landed as `src/llm/models.ts`: a keyless `GET /models`, cached to
`dataDir/models.json` behind a 24h TTL and refreshed at `serve` start, with `ensureKnown()`
refetching out of turn when the configured model is missing from an otherwise-fresh cache (a
newly-released model would otherwise take the fallback for a day). Lookup is **exact-match then
strip-the-variant**, because `:online` is a routing modifier OpenRouter does not list — an exact
lookup reported *no window* for `anthropic/claude-opus-5:online`, one of the two presets Joshua
actually runs. Precedence is config `contextLength` > catalog > a **labelled 128k fallback**, and it
is never undefined: guessing low costs an early summary, guessing high costs never compacting, which
was the defect. The window's **provenance travels with it** (`WindowSource`) into the serve banner,
`config which`, and the state frame, and the browser marks an assumed window as a guess while naming
the fix — a silently wrong window would be the same bug wearing a number. Verified live: both real
Opus presets banner **1,000,000 tokens (from OpenRouter)**. `createSessionFactory` was extracted to
`src/server/session-factory.ts` **because the wiring was untestable where it lived** — every
compaction test injects its own window into its own `Session`, which is exactly the level that
cannot see this bug; the new test runs against the factory `runServe` uses and was confirmed to fail
when the two window lines are removed. One deliberate deviation from the plan below: **`config add`
does not write a `contextLength`** (it would pin the window at add-time against a catalog that can
correct itself, and label a value the user never chose as theirs) — `contextLength` stays the manual
override, now reachable as `config set --context-length <n>`. Peeked in Chrome (VISUAL-LOG "H-06").
**This unblocks X-24 and X-27**, both of which were waiting on a budget existing at all.

*Original filing, 2026-08-04 — kept for the diagnosis:* **no window is known in `serve`, so
auto-compaction has never fired in real
use.** Found while filing X-27 below, and it is the missing third leg of the $120 conversation
(D-58/D-59): that thread was never going to compact. P6a made the context window **injected**
(`Session` `contextWindow`, with `config.compaction.contextLength` as the only fallback) and stated
"no window known → no trigger" — a sound call for a headless Tier-0 slice. But **nothing injects it
outside the tests**: `newSession` in `src/server/serve-command.ts:91` passes `config`, `driver`,
`tools`, `sandbox`, gate and `autoTitle`, and **neither `contextWindow` nor `compactorWindow`**; a
`grep` for `contextWindow` across `src/server/` and `src/cli*` returns nothing. So the fallback is
the whole mechanism in production, and `jlcode config add` writes `compaction: { auto: true }` with
no `contextLength` (`src/config/commands.ts:178`). Confirmed against Joshua's own
`~/.config/jlcode/config.json`: the two presets he actually works under — `MM - Opus` and
`OmegaMusic-Opus`, both `anthropic/claude-opus-5` — carry `{auto:false, triggerModes:["suggest"]}`
and **no `contextLength`**, so `budget()` never gets a window and `needs-compaction` can never be
emitted. Only `Fable — Live` has one (1,000,000), hand-set for the live tests. The consequence is
that every compaction surface built in P6a–P6c — the trigger, the suggest banner, the cancelable
pause, the whole safe-harbor engine — is **dead code in real use**, and a conversation grows until
the provider rejects it over-window (D-44b's hard-wall hook is the only path that still fires,
because it keys off the *error*, not a budget). Note this is a defect of wiring, not of design: the
fix is to give the instance a window. Order of preference — (1) the deferred **OpenRouter `/models`
fetch-and-cache** (D-44c) so the real `context_length` is known per model id, which is the answer
P6a always intended; (2) failing that, a conservative default in `serve` keyed off the model id, and
**say in the banner which window it assumed** — a silently wrong window is how this hid for a month;
(3) either way `config add` should write a `contextLength` so the fallback is populated for existing
presets too, and `jlcode config which` should show the effective window. Whoever takes this must
also add the test that would have caught it: an assertion at the **`serve` wiring level** that a
session built by `newSession` has a budget, not just a `Session` unit test that injects one.

**Filed 2026-08-07, FIXED 2026-08-07 (D-72) — see the X-28 block in the status section above:
X-28 — `ask_user` forces a choice, with no skip and no free-text escape.** Joshua, from real use,
via `observed_items_needing_filed_in_harness.txt`. The card (`AskForm`, `web/src/App.tsx:2795`)
rendered a question's `options` as buttons and gated Submit on `q.selected.length > 0`; the
free-text input was drawn only when the model set `allowFreeText`, which it essentially never did
because the flag is opt-in and the schema described it as "allow a typed answer too". So a
three-option question had exactly three expressible answers, and there was no skip, no "none of
these", and no way to say the thing the question failed to ask about. **Why this is worse than a
UI annoyance:** the tool exists to get a human's *actual intent*, and a forced pick produced a tool
result byte-identical to a considered agreement — nothing downstream could tell them apart, nothing
errored, and the model proceeded confidently on an answer the person did not mean. That is the
H-06/D-58 shape (a defect that never raises anything) applied to intent rather than to cost. The
escape had in fact existed in the type since P5b (D-41 built the multi-question form D-18
designed); it was simply the model's to withhold, which is the part that was wrong. The neighbouring
principle was already in the codebase: **D-16** keeps the raw-args box as the single editable truth
at an approval pause precisely so the human's override is expressible, and **D-48**'s learn
questions on that same card are declinable by construction ("unanswered stays fenced"). This is
that argument one surface over. Decisions taken and recorded in **D-72**: free text is
unconditional and no longer a flag; a decline is explicit, distinct from every option, and carries
an instruction not to substitute the closest one; `required` exists but can only compel *an*
answer, never a choice among the offered ones, and is enforced server-side; the multi-question form
(P5b) declines per field, so answering two of three is a normal outcome; and the approval card is
deliberately left as it is. A question the user simply never answers is unchanged — the loop stays
paused, which is correct — except that abandoning the card is no longer the only way to say no.

**Filed 2026-08-04, FIXED 2026-08-06 (D-63) — see the X-23 block in the status section above: X-23 —
`write_file` shows no preview but raw JSON, so a file write is unreadable
at the moment you're asked to approve it.** Joshua, from real use. The mechanism to fix it already
exists and `write_file` simply doesn't use it: `ToolPreview` (`src/tools/types.ts:38`, D-53) lets a
tool render something richer than its arguments at the pause, and **`apply_edits` is the only tool
that implements `preview()`** (`src/tools/edit-tools.ts:256`) — which is why an edit batch gets the
unified-diff card (`DiffPreview`, `web/src/App.tsx:2146`) with per-file +/− counts and a
"cannot apply" reason computed server-side. `write_file` (`src/tools/file-tools.ts:167`) has no
`preview`, so the approval card falls back to `primaryArgKey` — which picks `path` — and dumps
everything else into the raw-JSON box (`JSON.stringify(request.args, null, 2)`, `App.tsx:2270`).
A 300-line file therefore renders as **one JSON string with `\n` escapes**: you can see *that* it is
long, not *what* it says. The transcript has the same gap after the fact — `ToolBlock` renders args
through `prettyArgs` (`web/src/tool-view.ts`), which is `JSON.stringify(…, null, 2)` again. Shape of
the fix: `write_file.preview()` returns a `kind:"diff"` against the file **as it exists on disk**,
which is the honest framing — an overwrite of an existing file is a diff (and often a *small* diff
the raw JSON hides completely), and a new file is a diff against empty. `createTwoFilesPatch` from
`diff` is already a dependency (`edit-tools.ts:27`). Decisions to make and record: (a) **what a new
file shows** — a full-body `+` diff is honest but a 500-line all-green wall is noise; consider
falling back to a rendered body with a line/byte count above it, and cap it the way the diff card
already caps; (b) **the transcript half is a separate call** — after the write, the args are the
only record of what was written, so the same preview belongs in `ToolBlock`; decide whether the
entry stores the computed diff (durable, but the diff is against a file that has since changed) or
the transcript just pretty-prints `content` as text rather than JSON (cheap, honest, no
plumbing) — **recommend the latter**, since the post-hoc diff is a lie waiting to happen;
(c) **`delete_file` has the same silence** and is strictly more destructive — decide whether it
gets a preview (the file's size + first lines) in the same slice; (d) don't break D-16 — the
raw-JSON box stays the single **editable** truth, and the preview stays read-only, exactly as
`apply_edits` established.

**Filed 2026-08-04, FIXED 2026-08-06 (D-61) — see the status block above: X-24 — there is no
context-usage meter; you can't see how full the window is.**
Joshua, from real use: the page shows whole-tree **spend** in the corner (`SpendChip`,
`web/src/App.tsx:1479`) and nothing at all about context. The numbers exist and are already
authoritative — after each turn the session compares the just-finished response's `prompt_tokens`
against the budget (`evaluate()`/`knownPrefixTokens`, `src/session/compaction.ts:76`, D-44) — but
they surface **only at the moment it's too late to matter**: the `CompactionCard` computes
`Math.round(prefixTokens / window * 100)` (`App.tsx:1688`) and is the sole place a percentage is
ever rendered. So the user learns the window is nearly full when the loop stops on it. Wanted: the
same figure, continuously — a small bar or percentage beside the spend chip. Decisions to make and
record: (a) **it must not lie when the window is unknown** — which today is *always* in real use
(**H-06** above); a meter reading 0% because no window is configured is worse than no meter, so it
either renders an explicit "window unknown" state or the fix lands after H-06; (b) **the reading is
one turn stale by construction** (D-44 deliberately uses authoritative usage rather than counting
tokens, and there is no tokenizer) — the number jumps at turn end and does not creep during a
turn, which is fine but should be labeled so it doesn't read as broken; (c) **what the percentage is
*of*** — the budget (`window − buffer`, the line where compaction actually fires) or the raw window;
they differ by ~20K and the card already uses the raw window while the *trigger* uses the budget;
pick one, and consider showing the trigger point as a mark on the bar rather than choosing;
(d) **per session, not per instance** — with N live sessions (D-43) each has its own prefix, so it
belongs on the session slice beside `spendUsd`, not in the instance header; (e) `SessionSlice`
carries no token fields today, so this needs the number on the roster/state frame (`stateOf`) —
a small server change, not a UI-only one. Composes with **X-27**: once a threshold is configurable,
the meter is where you see it approaching.

**Filed 2026-08-04, FIXED 2026-08-07 (D-64) — see the status block above: X-25 — JLCode never tells
the model what day it is, so it writes wrong dates
into files. Joshua's call: stamp each user turn, not the system prompt.** From real use: *"JLCode
was leaving notes with the wrong date in them."* Confirmed — the system prompt is `BASE_SYSTEM` =
"You are JLCode, a helpful coding agent." plus the optional per-config `systemPromptAddendum`
(`src/session/session.ts:109`, `:298`) and **contains no date**; nothing else on the wire carries
one either (`buildWireMessages`, `src/conversation/wire.ts:16`, replays each entry's `role`/
`content` only — the `ts` every entry already carries is persistence metadata and has never been
sent). A model with a training cutoff and no clock dates a changelog entry to whenever it thinks
"now" is.

**Joshua's design call (2026-08-04), and it is the better one:** don't put a date in the base
prompt — *feed it as things go along, so the model can notice the passage of time*. A one-shot date
in the system prompt answers "what day is it" and destroys "you started this thread yesterday
morning"; a per-turn stamp answers both. He asked how KiloCode does it, since coming back the next
day it remarks on the gap. **Checked both KiloCode generations against source:**
- **Classic 5.11.0 (what Joshua runs; read out of the shipped `dist/extension.js`)** — every user
  turn gets an `<environment_details>` block appended, containing
  `# Current Time / Current time in ISO 8601 UTC format: <ISO> / User time zone: <IANA>, UTC±H:MM`
  (behind an `includeCurrentTime` setting, default on) alongside `# Current Cost`, `# Current Mode`,
  `# Recently Modified Files`, terminal output and optional `# Git Status`. Decisively, the block is
  **baked into the stored user message** — `addToApiConversationHistory({role:"user", content:[…,
  envDetails]})` — so **every historical user turn carries its own timestamp** and the model can
  diff them. That is exactly the behaviour Joshua remembers. (It strips any pre-existing
  `<environment_details>` from the content first, so a retried turn isn't stamped twice.)
- **v2 / 7.4.20 (the current rewrite, cloned to scratch)** — `injectEditorContext`
  (`packages/opencode/src/kilocode/session/prompt.ts:363`) appends the same block as a **synthetic,
  unstored part on the *last* user message only**, memoized per user-message id so "repeated loop
  iterations produce byte-identical messages (prompt caching)" — their comment. Newest-only: it
  answers "what time is it" and gives up the elapsed-time comparison classic had. A deliberate
  cache-driven trade, and worth knowing before copying the newer code.

**JLCode can have both properties for free, and more cleanly than either**, because `UserEntry`
already stores `ts` (`src/conversation/types.ts:15`) — verified in real logs: the most recent
conversation's user turns read `16:16:37`, `16:26:55`, `18:38:21`, so the gaps are already on disk,
just never rendered. So the implementation is **a rendering change in `buildWireMessages`, not a
storage change**: emit each `user` message with its own recorded `ts`. That gets (a) **retroactive**
— every existing conversation gains timestamps with no migration and no log rewrite (the log is
append-only by design, X-12/X-22); (b) **cache-safe by construction** — the stamp is frozen at
append time, so the replayed prefix stays byte-identical across turns *and* across the tool-loop
iterations inside a turn, which is the property v2 has to reimplement with a memo; and (c) the
system prompt stays clean, so D-26's breakpoint (1) over tools+system
(`src/llm/cache-breakpoints.ts:93`) keeps hitting. Note the trap being avoided: a date rendered into
the *system* message would re-render every turn and invalidate the entire cached prefix — the exact
defect D-58 just fixed at a measured 12.3x, so this is not a hypothetical.

Decisions the implementer still owns and must record: (a) **format** — recommend classic's shape
(ISO 8601 UTC + IANA zone + offset from `Intl.DateTimeFormat().resolvedOptions().timeZone`), since
UTC is unambiguous and the zone is what makes it actionable; (b) **where the text goes** — prefix
line on the user content, or a wrapping block; a wrapper (`<environment_details>`) is the extensible
choice, because this is the natural seam for the cwd/mode/cost lines KiloCode also carries, and it
lets the model tell *our* framing from the user's words; (c) **stamp only `user` turns** — assistant
and tool entries also carry `ts`, but stamping everything triples the noise and the user turns
already fix every gap worth seeing; (d) **compaction drops the stamps it folds** —
`compact()` re-emits one summary user message (`src/session/compaction.ts:184`), so decide whether
the summary carries the covered date range (recommend yes: "conversation from X to Y"), or a
compacted thread silently loses its history of time; (e) **opt-out** — KiloCode gates it with a
setting; a `compaction`-style config flag is cheap, but default it **on**, since silent wrong dates
are the failure being fixed; (f) **the very first turn of a resumed thread** is where this pays off
most — check the rendered prefix once by hand, in the journal, to confirm an overnight gap actually
reads as one; (g) this shares an injection seam with **X-15** (`AGENTS.md` — the *static* half,
which belongs in the system prompt exactly as KiloCode splits `staticEnvLines` from
`environmentDetails`); do them together or make sure the second doesn't rewrite the first's seam.

**Filed 2026-08-04, FIXED 2026-08-07 (D-65) — see the X-26 block in the status section above: X-26 —
no sound when a session needs attention.** Joshua: *"when JLCode has a
prompt it needs attention it needs to play a little blip sound."* Nothing in the client makes noise
today except TTS — `grep` for `new Audio|AudioContext|\.wav|\.mp3` across `web/src/` returns
**nothing**; the only audio path is `speechSynthesis` behind the per-message 🔊 button. Distinct from
its two neighbors and should not be folded into either: **X-13** (TTS auto-read) *speaks the reply*,
which is a much bigger, more intrusive act, and **P-02** (external push) reaches you when you are
away from the machine. This is the small one — you are at the desk with the tab in the background and
you want to know the agent stopped. The trigger is the same settled-and-waiting state all three
share: `awaiting-input`, `awaiting-approval`, `awaiting-compaction`, a cap breach, and arguably
plain `idle` (a finished answer is also "your turn"). Decisions to make and record: (a) **where the
sound comes from** — a short embedded/generated tone (a `WebAudio` oscillator blip needs no asset
and no bundling) beats shipping a `.wav`, unless a real sound is wanted; (b) **autoplay policy** —
browsers gate audio behind a user gesture exactly as they gate `speechSynthesis` (see X-13's note),
so the toggle must be a real click and the `AudioContext` created/resumed from it, not restored
silently on load; (c) **the preference belongs in `web/src/prefs.ts`** — the shared browser-side
prefs helper X-12a landed; X-13 and X-16 are already told to add keys there, and this makes three,
which is a good argument for grouping them into one small "notifications" cluster in the UI rather
than three scattered checkboxes; (d) **N sessions must not clatter** — with D-43's multiplexed bus,
several sessions can settle at once; debounce, or play once per settle-batch, and decide whether a
*background* session pings at all (recommend yes — that is the whole point, and it is the same
argument X-13(a) records); (e) **don't blip for a state the user caused** — a pause the user is
already looking at, or a settle that lands while the tab is focused and the session is the one on
screen, is noise; keying off `document.hidden` plus "not the focused session" is the cheap rule;
(f) consider whether the **tab title** gets a marker at the same time (`document.title` is already
computed by `tabTitle()`, X-10) — a badge is the silent half of this feature and costs almost
nothing once the trigger exists.

**Filed 2026-08-04, FIXED 2026-08-06 (D-62) — see the status block above: X-27 — a compaction
threshold you can actually set (KiloCode condenses at 171.5k).** Joshua: *"KiloCode condenses at 171.5k, so we should probably have a preset for
condensing at the same size. Shooting past by one turn is fine"* — the last clause is already how
JLCode works (D-44's accepted one-turn overshoot, since the trigger reads authoritative usage after
the turn). Today the threshold is **derived, not set**: `budget = window − bufferTokens`
(`src/session/compaction.ts:36`, D-44c), where `bufferTokens` defaults to ~20K. So asking for 171.5k
on a 200k model means computing `bufferTokens: 28500` by hand *and* hand-setting
`compaction.contextLength`, because **no window is known otherwise** — that is **H-06**, and this
row is blocked behind it in practice: a threshold is meaningless until a budget exists. What's
wanted on top: (a) an **absolute threshold** (`compaction.thresholdTokens: 171500`) or a
**fraction** (`compaction.thresholdFraction: 0.86`) as an alternative to expressing it as headroom
— absolute is what Joshua asked for and is legible; fractional survives a model swap. Recommend
supporting absolute and keeping `bufferTokens` as the derivation when it is absent, so nothing
existing changes meaning; state the precedence explicitly (threshold wins over buffer) and keep the
**compactor-fit guard** (D-44a `min(working, compactor)`) applying *after* it — a threshold above
what the summarizer itself can read must still tighten, or compaction fails at the moment it is
needed; (b) "preset" in Joshua's sense means **it should be reachable without hand-editing JSON** —
today `compaction` has no `config set` surface at all (`src/config/commands.ts`), and per **X-19**
the browser cannot edit preset settings either, so decide whether this ships as a `config set`
field, part of X-19's editor, or both; (c) the value pairs naturally with **X-24**'s meter — the
threshold is the mark on the bar; (d) sanity-check the value against the window and refuse a
threshold above it rather than silently never firing, which is the failure mode H-06 just
demonstrated is easy to miss.

**X-15 FIXED 2026-08-07 (D-69) — a repo's own `AGENTS.md` is now read, and the harness
auto-integrates.** Joshua asked twice (2026-07-28, again 2026-08-04 from real use); JLCode read
**nothing** from the workspace, so the harness pattern it is built around worked for Claude Code and
not for JLCode, in JLCode's own repo. The system prompt is now base → the workspace's file → the
per-config addendum, with the **addendum last on purpose**: it is the more specific of the two, so
where a project and a client disagree the client config — chosen most recently by the operator — wins.
Precedence is `AGENTS.md` → `CLAUDE.md`, **first
hit wins, never concatenated** (a repo carrying two of them is carrying the same rules twice, and
concatenating bills for both every turn), matched case-insensitively off a directory listing so one
repo behaves the same on Linux and macOS, searched in the launch dir and then **up to the repo root**
for the `repo/packages/web` case. **The load-bearing call is that it is read once**, at session
construction, and `Session` takes an already-rendered *string* rather than a directory — a session
that cannot re-read cannot regress into re-reading. A file re-read into a re-rendered system message
every turn would invalidate the whole cached prefix every turn: that is D-58's defect, measured at
**12.3x**, and the test that guards it rewrites `AGENTS.md` **mid-session** and demands the system
message not move a byte. Read-once is also the answer to **self-modification** — the agent can edit
that file with its own tools, and the injected block tells it in as many words that the edit lands in
the next session, not this one. **Nested per-directory files were deliberately left out**: content
discovered mid-session is per-turn content, and per-turn content belongs on a user turn (X-25's half
of the seam), never in the cached system message. Capped at **32 KiB**, head kept, cut on a line
boundary, with the truncation stated in the prompt *and* on the console — bytes that ride in every
request are a real cost and must not be a silent one. Visible from one function on two surfaces: the
`serve` banner and `config which` both print `project instructions: CLAUDE.md (6.4 KB)`. Opt out with
`config set <name> --project-instructions off` (`environment.projectInstructions`, default on — the
sibling key D-64 (e) left room for). **Confirmed by hand through the built artifact**, not only in
vitest: in this tree `config which` and the banner both name `CLAUDE.md`, and a session built by the
real `createSessionFactory` composes a 7,045-character system prompt whose middle is this repo's own
operating guide. **30 new Tier-0/1 tests**, including four at the **`serve` session-factory** level —
the level H-06 and D-60 both hid at, and the only level that can see a prompt production forgets to
compose. No peek: nothing rendered in the browser changed.

**732 Tier-0/1 green** (+2 replayed Fable; re-run 2026-08-11, 63 files). **H-06 is fixed (D-60)**,
**X-24 (D-61)**, **X-27 (D-62)**, **X-23 (D-63)**, **X-25 (D-64)**, **X-26 (D-65)**, **X-17 (D-66)**,
**X-15 (D-69)**, **X-13 + H-07 (D-70)**, **X-29 + X-30 (D-71)** and **X-28 (D-72)** are all fixed;
**X-12b is DONE**, `peek` grew a mouse and a movable port (D-67), and the config loader stopped
whitelisting fields it never validated (D-68).
**X-24 is fixed (D-61)**, **X-27 is fixed (D-62)**, **X-23 is fixed (D-63)**, **X-25 is fixed
(D-64)**, **X-26 is fixed (D-65)**, **X-17 is fixed (D-66)** and **X-13 + H-07 are fixed (D-70)**;
**X-12b is DONE**, and `peek` grew a mouse and a movable port (D-67).
**Next:** open — the backlog's still-open rows (X-14, X-16, X-18) and the todo tool, whose shape Joshua settled 2026-08-09. **P7c is done.** Rendered surfaces get a
real-browser peek per slice, logged in `VISUAL-LOG.md`.

**X-28 FIXED 2026-08-07 (D-72) — a question the agent asks now has a way out.** A call with N
options rendered N buttons and a Submit that stayed disabled until one was clicked, so the only
answers a person could give were the ones the model had already thought of — *"I want to tell you
something you didn't anticipate"* became *"pick the closest wrong answer"*, and the model then
proceeded on it confidently. **Free text is now on every question, unconditionally**: the
`allowFreeText` flag is gone from the tool schema, the types and the card, because a flag *letting*
the person speak is the wrong shape for a tool whose whole purpose is to hear what was not
anticipated (the same argument as D-16 one surface over — the human's override has to be
expressible, and cannot be conditional on the machine having offered). **A blank is an explicit
decline and reaches the model as one**: `AskUserAnswer` carries `chosen`/`typed`/`declined` beside
the flat answer, so the tool result distinguishes *chose "postgres"* from *picked none of the
offered options and typed: duckdb* from *declined*, where all three used to flatten into one
comma-joined string — and it says outright, once per result, that a decline means *none of these*
and the closest option must not be substituted. A blank with **no** flag reads as a decline too, so
a plain-text frontend gets the honest rendering for free. **`required` can compel an answer, never
a choice**: enforced in `Session.answer()` rather than only in the card (so a CLI sees the same
rule — a blank required question is a 400 and the pause survives it), and a typed answer always
satisfies it. The card gains a visible **Skip** beside Submit, labelled for what it would send
(`Skip this question` / `Skip the rest` / `Skip all`, and `Submit 2 of 4`), because the way out has
to be something you can see rather than an empty form you reason your way to; when `required`
withholds it, an amber line names the question rather than leaving a dead button. **The approval
card is deliberately untouched** — Deny is its refusal, the raw-args box its override (D-16), the
composer note its free text (D-51), and its D-48 learn questions are already declinable. The gating
logic moved to `web/src/ask-form.ts`, since it was a *rendering* decision with no test at all,
which is how it survived since P5b. Peeked in Chrome (VISUAL-LOG "X-28"), which also turned up a
latent hole the new refusal made reachable: the card was cleared optimistically and never restored
on error, so a rejected answer would have stranded the session in `awaiting-input` with nothing to
answer it. **26 new Tier-0 tests.**

**X-17 FIXED 2026-08-07 (D-66) — a thread is re-named as it becomes something else.** X-09 named a
thread from its opening exchange and stopped, so the threads worth finding in a list — the long ones —
kept whatever they were about in their first two minutes. The re-ask is X-09's same ephemeral question
(D-29 cache reuse, never appended to the tree); **everything decided here is *when* to spend it.** The
trigger is **geometric**: the branch must have roughly **doubled in user turns** since the current name
was chosen and grown by at least **6** turns — so a long thread pays about **log2(turns)** title calls
over its life, ≤8 across 200 turns, which a unit test asserts rather than hopes. Independently, **a
compaction is drift**: a fold is the system saying the early topic is no longer being sent, and it
arrives beside a summary call that dwarfs the title. Rejected: every-N-turns (linear cost, wrong at both
ends), a token threshold (measures how much was *said*, and reads 0 right after a fold), and a
refresh-button (nobody re-titles by hand — that is the defect). **A name a person chose is never
overwritten**, and the durable half of that was missing: `store.title()` has recorded `source` since
X-09 and nothing ever read it back, so a resumed thread would have re-titled over Joshua's own rename at
the next threshold — `load()` now folds `titleSource` onto the conversation (no source recorded reads as
`auto`). **The index needed no new write path**, which is what X-12b's row demanded: the re-title calls
the same `setTitle` the rail rename calls, emitting the `title` event the server already projects to the
log *and* the index row, so history, rail card and resume all move from one write — and **no `web/`
change was required**, since `session-state.ts` already folds that event. **A re-ask that keeps the name
writes nothing at all** (the model is shown the current name and may reply with it verbatim), so the
expected outcome on an undrifted thread is silence, not a rewrite of the same string. Opt-out per model
config: `config set <name> --auto-retitle off`, read back by `config which`. *Found in passing and
fixed:* `normalizeModelConfig` is a **whitelist**, so the new config field was silently dropped on load
and the opt-out did nothing — H-06's class exactly, caught only because the CLI test asserted the round
trip through disk. **21 new Tier-0/1 tests**, including the store round trip, the drift policy as a pure
function, the HTTP index/live-session composition, and the `serve` **session factory** (the level H-06
lived at). No peek: the slice is server-side and the only browser-visible surface is a title event the
rail has rendered since X-09.

**X-12b shipped 2026-08-06 — a past thread can now be renamed and removed.** The three parts the row
named, all of which X-12a designed and cut. (1) **Delete is a reversible masking flag**: `DELETE
/conversation/:id` appends `{kind:"deleted", id, deleted:true, ts}` to `index.jsonl` **only**, and
`list()` folds it out with the same newest-wins Map it already used for titles. Nothing is ever
unlinked — the log stays byte-for-byte on disk, `GET /conversation/:id` still answers 200, and
flipping that one line to `"deleted":false` brings the row back (verified by hand, since that is
Joshua's stated recovery path). Masking also sidesteps the trap a hard delete carried: this store and
`DebugJournal` each memoize an `AppendLog` per conversation id, so an unlink without evicting those
handles lets a queued append recreate the file. The row's hover `✕` opens an **inline confirm naming
the thread** — *"Delete 'Compaction budget math'? It leaves the list, but stays on disk"* — and is not
offered on the row currently peeked. (2) **Rename from a row**: `POST /conversation/:id/title`,
addressed by *conversation* so a thread with no session behind it can still be named; it **routes
through a live session** when one holds that id, or the rail card would show the old name until a
reload. (3) **An empty session no longer joins history at all** — `startSession` created the index row
eagerly at construction, so closing a thread you never typed into left an untitled stub with nothing
to peek at. `create()` is now deferred to the first `entry` (or `title`) event, which is shape (i),
the honest fix: an abandoned thread leaves no trace rather than a row we then hide. The audit that
choice needed holds — nothing reads the index during the live-but-silent window, since the browser
filters live conversations out of HISTORY and both the peek and `/chat`'s revival fallback read the
conversation *log*. Peeked in Chrome (VISUAL-LOG "X-12b"), where the hover/confirm states needed real
mouse events over CDP rather than a plain `peek shot`. *Caught by the change, as it should have been:*
the D-46 persistence-fault test jammed a conversation log by chmod-ing it straight after
`POST /session`, which no longer exists at that point.

**X-24 FIXED 2026-08-06 (D-61) — you can see how full the context is, all the time.** A meter beside
the spend chip: a bar reading a percentage **of the raw window**, with the compaction threshold drawn
as a **mark** on the track (X-24 asked "budget or window?" — showing both is what makes *how full* and
*when does it compact* separately legible). The number is `Session.contextTokens`, a **getter derived
from the active branch** rather than a latched field, so resume / fork / rewind / branch-switch are
right with no bookkeeping and the meter can never disagree with the trigger. It rides live on a new
**`context` event** emitted per LLM round trip — deliberately *not* off `spend`, which also fires for
the summary/title/watchdog calls whose prompt size isn't this branch's prefix — plus `contextTokens`
on the state frame for a tab joining mid-thread. **Unmeasured renders `—`, never `0%`** (a fresh or
just-compacted branch is small-but-unknown, and a confident zero is the exact shape of lie that hid
H-06); an assumed window (D-60 `fallback`) is marked `~`. Peeked in Chrome (VISUAL-LOG "X-24").
*Found in passing and fixed:* **`web/` was never typechecked** — `npm run build` runs `tsc` on the
server tsconfig then hands the browser client to Vite/esbuild, which strips types without checking
them, so H-06 had left two live type errors in `session-state.ts` that nothing reported.
`tsc -p web/tsconfig.json` is now in both `build` and `typecheck`.

**X-23 FIXED 2026-08-06 (D-63) — a write is now readable at the moment you're asked to approve
it.** `write_file` had no `preview()`, so the card fell back to `primaryArgKey` (which picks `path`)
and dumped `content` into the raw-JSON box: a 300-line file rendered as one string of `\n` escapes.
The framing is now **what the write does to the file**, which splits three ways. An **overwrite is a
diff against what is on disk** — the same `DiffPreview` card `apply_edits` gets, and usually a
*small* diff the JSON buried; a **new file shows its body** with a `NEW FILE` badge and a
`17 lines · 338 B` header rather than a full-body `+` wall (X-23 (a): against empty, every line is
"added", so green marks nothing); and **`delete_file`, which had the same silence and is strictly
more destructive, now shows size + head** (X-23 (c)), capped at 40 lines against a create's 400 —
what you need there is to recognize *which* file is going. `ToolPreview` became the union
`DiffPreview | FilePreview` for it, and `sites` is optional now that a tool without anchors uses the
diff shape. **The transcript half stores no diff** (X-23 (b), taking the row's own recommendation):
`ToolBlock` pretty-prints `content` as text, because it is read long after the fact and a diff
against a file that has since changed is a lie waiting to happen, while the content is what was
actually sent. **D-16 is untouched** (X-23 (d)) — both new cards are read-only and the raw-JSON box
is still the one editable truth. Two things fell out of building it: an **identical** write is
labelled *"identical — this changes nothing"* instead of showing `+0 −0` over an empty box, and a
preview is **never computed out of fence**, since reading the target before the user allows it is
what the fence is for. Peeked in Chrome (VISUAL-LOG "X-23"), where the sharpest case appeared by
accident: two files that look identical in the composer differing only by a **trailing newline** —
`+1 −1` on the card, invisible in the raw JSON. **19 new Tier-0/1 tests.**

**Peeks are now a tool, not a recipe** (Joshua's call, 2026-08-06): `harness/peek/peek.mjs`
(`up` / `chat` / `new` / `shot` / `state` / `down`) does the isolated-config + fake-driver + CDP
screenshot dance that every slice used to rebuild from prose. `--ctx`/`--buffer`/`--trigger` pose the
compaction surfaces; `--crop topbar` makes chip-sized detail legible. It launches Chrome on port
**9411** with a throwaway profile and **refuses to attach to a browser it didn't start** — the first
version reused anything on 9222, which would have meant driving Joshua's real profile, with his
cookies and tabs, on a port collision. See VISUAL-LOG's method section.

**X-27 FIXED 2026-08-06 (D-62) — you can now say "condense at 171.5k" and be obeyed.**
`compaction.thresholdTokens` states the threshold **absolutely**; `bufferTokens` stays the
derivation when it is absent, so no existing config changes meaning. Precedence is stated once, in
`computeBudget`: **absolute wins over the buffer, and D-44a's compactor-fit guard still applies
after both** — a threshold the summarizer itself cannot read has to tighten, or compaction fails at
the moment it is needed. Reachable without hand-editing JSON, per Joshua's "preset":
`config set <name> --compaction-threshold 171500` (`none` clears it), and readable back from
`config which` and the `serve` banner, both of which now print *where compaction fires and why*
beside the window D-60 added. **A threshold that is not below the window is refused, twice over:**
`config set` errors at the moment you type it when the window is *known* (and warns, but accepts,
against an assumed one — refusing on a guess would block a value that is probably right), and the
budget itself ignores an unfittable stored value, falling back to the derivation and reporting the
refused number so every surface can say so. The **meter needed no new wiring**: D-61 already draws
the threshold as a mark from `contextThreshold` on the state frame, and the new test asserts that
frame carries 171,500 — verified end-to-end rather than rebuilt, so no peek was needed for this
slice. Tested at four levels, deliberately including the **`serve` session factory** — the level
D-60's month-long bug lived at, which a `Session` test injecting its own budget cannot see.

**X-25 FIXED 2026-08-07 (D-64) — the model is now told when each turn was sent.** The bug was
Joshua's: *"JLCode was leaving notes with the wrong date in them."* Nothing on the wire carried a
date, so a model with a training cutoff dated a changelog entry to whenever it thought "now" was.
Each **user** turn is now replayed as the user's words followed by an `<environment_details>` block
— `# Current Time`, the ISO 8601 UTC instant, and `User time zone: <IANA>, UTC±HH:MM` — and
nothing was added to the log to do it: the `ts` every entry has always carried is simply **rendered**
now, in `buildWireMessages`. That is what makes it **retroactive** (every existing conversation gains
its timestamps, no migration, no rewrite of an append-only log) and **cache-safe by construction**
(the stamp froze when the entry was appended, so turn N's prefix stays a byte-identical prefix of
turn N+1's — asserted, including across a `compact()`). The **system prompt is deliberately still
date-free**: a date there would re-render every turn and invalidate the whole cached prefix, which is
the defect D-58 fixed at a measured 12.3x. A **compaction summary carries the span it replaces**
(`# Summarized History … from <ISO> to <ISO>`, root of the branch → the cut), or a compacted thread
would silently lose its history of time. Off is one flag — `config set <name> --turn-timestamps off`,
`environment.turnTimestamps`, **default on**, read back by `config which`. **Checked by hand** as the
row asked (f): a thread seeded at 2026-08-05 09:12 CDT and resumed at 2026-08-06 22:35 CDT through
the fake driver on port 7920 renders two stamps a night apart in the replayed prefix, and its
compacted variant renders the span line. **X-15 was left alone** (g) but its seam is now shaped:
per-turn detail is an `EnvSection` on the user turn; the static `AGENTS.md` half belongs in the
system prompt. *Two things fell out of building it:* all four of `Session`'s replay builders now go
through **one** `wire()`, because same-model compaction resends the exact live prefix for the cache
(D-29) and a one-byte difference would have turned that off silently; and **a wall-clock stamp and a
recorded-replay fixture cannot coexist** — the stamp changes the request-cache key (D-24) every run,
so the committed Fable tests replay with `turnTimestamps: false`, and the offline fake drivers strip
the block before reading the user's words (or `write: a.txt | hi` would write the timestamp into the
file). **26 new Tier-0/1 tests.** No peek: nothing rendered changed in the browser.

**X-13 FIXED 2026-08-08 (D-70) — the reply reads itself, and the TTS that used to jam no longer can.**
TTS was per-message and manual, so hearing a reply meant noticing it first. The session **you are
looking at** now reads its reply aloud the moment the turn comes back — and *only* that session:
speech is serial and unattributable, so **the two notifications divide the sessions between them**,
a background one gets X-26's blip and the one in front of you gets read out. That disposes of X-13's
queue question (one voice, nothing to queue) and of the worst failure mode it could have had (four
panes talking at once). **A pause reads why it stopped** — the question and its options, the tool an
approval is about and *never* the file body it would write, the compaction pause, the cap, a stalled
write — in X-26's attention precedence. A failed turn reads its notice, which is why `noticeKind`
now names the event that raised it: the notice *text* cannot tell "the provider refused" from "you
pressed Stop, and know it", and only one of those is worth saying aloud. `tts.autoRead` joins
`notify.blip` in the NOTIFICATIONS cluster, **default off** — the one place this parts company with
its neighbour, because a chirp nobody asked for is a notification and a voice reading a page of
prose at someone who did not know the feature existed is a fright. Typing stops it mid-sentence;
so does answering, switching session, or turning it off. Nothing empty is read, the reply is taken
from the branch actually on screen (`pathToLeaf` — a sibling's reply is H-05's hazard in audio), and
a session whose tree has just loaded is primed in silence. **No server change** — the settled states
already ride the state frame — and the trigger keys on **content, not a counter**, which is the one
place it is simpler than X-26: an entry id changes whether or not React batched the render, so
`settleSeq` was not needed. Peeked in Chrome (VISUAL-LOG "X-13"), where the browser taught two
things: the arming gesture is **sticky**, so one ordinary click buys an utterance fired from a timer
fourteen seconds later (which is the only reason auto-read can work — it never fires from a click);
and auto-read was lighting a **stop button nobody could see**, because `.msg-tools` is `opacity: 0`
until you hover the turn. One CSS rule now keeps the controls of a message that is *being read*
visible. **41 new Tier-0 tests**, and it shipped with H-07 below, which is the same object.

**H-07 FIXED 2026-08-08 (D-70) — "TTS jamming intermittently" was a five-out-of-five reproducible
latch.** Filed off Joshua's unfiled list and fixed in the same slice as X-13, because auto-read
would have turned an occasional stuck button into a feature that stops working. See the hardening
section below for the reproduction and the fix.

**X-26 FIXED 2026-08-07 (D-65) — a session that stops while you are looking elsewhere now says so.**
Nothing in the client made a sound except TTS, so "the agent handed the turn back" was only ever
discoverable by looking at it. It now plays a **two-note chirp** (880 → 1318.5 Hz, ~70ms each,
generated by a `WebAudio` oscillator — no asset to encode, commit, bundle and fetch) and prefixes the
tab title with **`●`**. The trigger is any wire event that hands the turn back — `assistant-end`, the
four `awaiting-*` pauses, `cap-reached`, `error`, `halted` — and *not* `stopped`, since you pressed
that. **It only makes a sound when you are not already watching it**: audible when the tab is hidden
**or** the settling session is not the focused one, so the pause you clicked *Compact now* to get,
on screen, is silent. **N sessions cannot clatter**: a 1.5s leading-edge debounce plays one note per
settle-batch (two sessions pausing at once was posed in the browser and produced exactly one chirp).
The preference is a single `notify.blip` key in `web/src/prefs.ts` (X-12a's helper), default **on**,
rendered as a **NOTIFICATIONS cluster at the foot of the rail** that X-13 and X-16 are meant to join
rather than each growing a checkbox somewhere else. The **tab marker is not gated on it** — it is
free, silent, and the only signal left for a tab you have not looked at in an hour. **No server
change:** the settled states already ride the state frame. Two things the browser taught that the
mocks could not (VISUAL-LOG "X-26"): audio is gated behind a real user gesture, so the
`AudioContext` is built **only** inside the toggle's click or the session's first ordinary click and
`blip()` is a no-op until then; and a **backgrounded tab batches so hard that the whole turn arrived
as one DOM mutation**, which killed the original design of diffing the state before and after a
render — the edge is now a monotonic `settleSeq` counter on the slice, which survives any amount of
batching, with the level comparison kept as a second edge for a session that settled while the SSE
bus was disconnected. **23 new Tier-0 tests.**

**The config whitelist is gone — D-68, 2026-08-07.** `normalizeModelConfig` rebuilt a `ModelConfig`
field by field, so a setting added to the type but not to that list was written by `config set`, read
back as `undefined`, and silently lost. It bit **twice in one day**: X-17's `autoRetitle` and X-25's
`environment` were each born broken, and each was caught only because its CLI test asserted a round
trip *through disk*. The loader now spreads the stored record and overrides only what it actually
coerces; the five fields it used to list with a bare `as` cast are gone, since naming them validated
nothing and only created the obligation to remember. Joshua's call on seeing the second instance.
A field nobody has invented yet (`futureSetting`) is asserted to survive load and a save→load round
trip, standing in for the next one.

**The agent's todo list is built — X-31, D-74, 2026-08-11.** Two tools (`todo_read` / `todo_write`)
and a browser panel over one piece of state: a list **folded from `todo` operations on the
conversation's own branch**, which is D-37's model and is what makes resume, fork and rewind correct
without any bookkeeping — and what makes the list **survive compaction**, since the ops sit above the
replay cut but are still on the branch. That last property is the feature's whole point: the list is
the memory a summary is most likely to blur. The agent addresses items by exact text or by the id
echoed on every read (content survives re-ordering, ids survive re-wording); a miss is refused with
the current list attached rather than striking a neighbour; and a write is refused until the agent
has read — a barrier that **re-arms whenever the person edits**, cannot hang anything, and is cleared
by the refusal itself. The person's half is a panel pinned between the thread and the composer:
leaving edit mode is the commit, an unchanged commit is a no-op, and a real one queues a message
stating **the count, not the payload** — without opening a turn, because editing your own list must
not spend a model call. Peeked in a real browser (VISUAL-LOG "X-31"), which cost *start a list* its
pointless extra click. **20 new Tier-0 tests.**

**`observed_items_needing_filed_in_harness.txt` is fully filed as of 2026-08-11 — nothing left on it.**
All five of Joshua's observed defects are now harness rows, and four are fixed: `ask_user`'s missing
escape as **X-28 (D-72)**, the chip and the scroll theft as **X-29 / X-30 (D-71)**, the intermittent
TTS jam as **H-07 (D-70)**. The fifth, **the agent's todo list, X-31**, is now built too
— Joshua's question round on 2026-08-09 answered every open call (shared list, a read-barrier
instead of a lock, content-addressed operations, pull-with-a-count delivery) and **D-74 shipped it
2026-08-11 as designed**, with the barrier made slightly stricter than the row's wording: it re-arms
on any change the agent did not make, not only on never-having-read. **The list is empty; nothing is
left on it.**


---

## Phase 0 — Scaffold & foundations ✅ done (2026-07-23)
**Goal:** an installable, testable empty shell.
- TypeScript project; **Vitest**; **Hono** dep; `package.json` with a `bin` so `npx jlcode`
  runs (D-22). Minimal-dep discipline, no native binaries (D-25).
- Config/data dir resolution: `JLCODE_CONFIG_DIR` / `JLCODE_DATA_DIR`, XDG defaults (D-13).
- Diagnostics logger + rotating log location (D-11).
- Tier-0 test setup.
- **Done when:** `npx jlcode` runs, prints version, resolves its dirs; CI runs Tier 0.

## Phase 1 — Config & model selection ✅ done (2026-07-23)
**Goal:** pick a client/model to work under.
- `config.json` schema: model configs (name, key, model id, **reasoning effort**, sampling,
  system-prompt addendum, default mode+approval, compaction settings) (D-05, D-27).
- Folder→config binding keyed off cwd (D-06); filter-search picker + clone-from-existing.
- **Done when:** launch → auto-selects last config for this dir (or filter/clone to pick);
  selection persists per directory. Tier-0 tested.

## Phase 2 — OpenRouter client + walking skeleton ✅ done (2026-07-23)
**Goal:** actually talk to a model end-to-end (headless).
- Thin fetch client (D-21): tool-calling protocol, streaming, **verbatim `reasoning_details`
  round-trip** (D-14), **prompt-cache breakpoints** (D-26).
- **Request-keyed LLM cache** (D-24) so tests are free after first record.
- Conversation tree in memory (append-only parent-pointer, `activeLeaf`) + wire assembly
  (D-15, D-17). A minimal CLI loop: send a message, stream a reply.
- **Session as a first-class object under a `SessionManager` (D-36)** — even at N=1, no
  "global current session" assumptions, so concurrency stays additive (the anti-entropy invariant).
- **Truncation handling (D-30):** detect `finish_reason: length`; re-express truncated
  reasoning as plain-text input so the model continues (no silent loss/loop). **Streaming
  partial recovery of tool-call args** (D-31): retain raw `arguments`, streaming value
  extraction + repair fallback.
- **Circuit breaker (D-32):** consecutive-failure counter → hard-stop + escalate.
- **Done when:** you can hold a real conversation from the terminal; reasoning round-trips;
  a truncated turn is detected and recoverable; repeated failures halt cleanly; Tier-1 tests cover it.

## Phase 3 — Tools, sandbox, modes & approval ✅ done (2026-07-23)
**Goal:** the agent can do gated work.
*(3a sandbox + tools + tool loop; 3b mode∩approval gate + pause/approve/deny/edit
+ ask_user, wired into the server. Background-task kill affordance (D-34) rides
with the P5 frontend.)*
- Sandbox path fence + out-of-fence approve/allow-remember/deny (D-19).
- Native file tools (read/write/create/delete/list/glob/grep) (D-03); shell tool (D-04).
- Structured **`ask_user`** tool (D-18).
- Mode capability gate (Ask/Plan/Code) ∩ approval policies; **editable-before-approval** (D-07,
  D-08, D-16).
- **Truncation-safe tool exec (D-30):** never apply a partial tool call; atomic writes; the
  additive-vs-replacing split (additive keeps + "continue"; replacing rejects); visible signals.
- **Background-task model (D-34):** long-running shell commands tracked with status + killable
  (UI affordance lands in P5). Per-turn **spend accounting** groundwork (D-33).
- **Done when:** the agent edits files & runs commands under the fence, respecting mode +
  approval, with inline command editing; a truncated write never deletes a tail; long tasks are
  trackable/killable. Tier-0/1 tested.

## Phase 4 — Persistence, resume, fork/rewind ✅ done (2026-07-23)
**Goal:** conversations survive and branch.
- Conversation store: flat JSON per conversation + `index.json`; **debug journal** (D-13, D-15).
- Persist + resume; history filtered by working dir with show-all (D-09).
- Fork (sibling branch) / rewind (move `activeLeaf`) navigation (D-10, D-17).
- **Done when:** restart resumes a conversation; you can fork/rewind and navigate branches.

## Phase 5 — HTTP frontend (React + Vite, D-39)
**Goal:** the real product — a browser you talk to. Sliced into six independently-shippable
vertical cuts (P5a…P5f), each green at the free tiers before the next. Stack is **React + Vite**
(D-39): the build toolchain is a devDependency that emits **pre-built static assets**, so the
`npx jlcode` runtime stays native-free (honors D-25's intent).

### P5a — Client toolchain + transport skeleton ✅ done (2026-07-23)
- React + Vite wired (`web/` → `dist/web`, `tsc && vite build`); React/marked/DOMPurify are
  **build-time devDeps** bundled into shipped static assets, runtime stays native-free (D-39).
- **SSE down / POST up** bus: `POST /session` (create), `GET /session/:id/events` (SSE; first
  `ready` frame = listener attached), `POST /chat` streams deltas then returns settled state. The
  `node-adapter` now **streams `ReadableStream` bodies** so SSE flushes live. Static handler serves
  `dist/web` with SPA fallback + traversal guard; API routes win. **`/shutdown` kept as the
  curl-only kill path** (no UI button).
- **Bind seam (D-40):** `--host` selects bind scope (localhost default, no auth; non-loopback warns
  until P5f). Configurable `--port`.
- Bare React chat view over Session/SessionManager: create/deep-link (`?session=`) → SSE → stream
  tokens → **sanitized markdown** (marked→DOMPurify) + reasoning disclosure. Whimsical working
  words (percolating…).
- Fixed a persistence race: `ConversationStore.create` now issues header+index appends before
  awaiting, so a fire-and-forget create can't outlive `flush`/`close` (was a teardown flake).
- **Verified:** 8 new Tier-0 tests (SSE streaming, session-create, static serving/SPA/traversal);
  **looked at it in Chrome** — see [`VISUAL-LOG.md`](VISUAL-LOG.md) (P5a). **Done.**

### P5b — Interactive gating in the browser ✅ done (2026-07-23)
- **Approval card with edit-before-approve** (D-16): a **hybrid editor** — a prominent field for
  the primary arg (command / path) + a collapsible raw-JSON box (Joshua's call). Capability badge,
  Approve/Deny; the edited args run, the assistant turn stays verbatim.
- **`ask_user` single + multi-question forms** (D-18): the tool contract now advertises a
  `questions[]` form (header / options / **multiSelect** / **allowFreeText**) *and* the
  single-question convenience; the session normalizes both, and the browser renders option pills +
  free-text with one Submit. Answers post back as `{text}` or `{answers:[…]}`.
- **Live mode (Ask/Plan/Code) + approval-policy controls** (D-07/D-08): header segmented control +
  dropdown → `POST /session/:id/mode`; the session **re-gates live** (new `buildGate` seam) and the
  change is **persisted as the config default** (Joshua's call), via a `persistDefaults` dep.
- **Soft-fence out-of-fence prompts** (D-19): allow-once / remember-root / deny, with the suggested
  root shown; edits to the path are re-checked server-side.
- **Offline driver for the gated flows:** `fakeAgentDriver()` turns message prefixes
  (`write:`/`run:`/`ask:`/`form:`) into real tool calls, so `JLCODE_FAKE_LLM=1` exercises approvals
  + ask_user end-to-end with no key/spend (used by the browser peek).
- **Verified:** 5 new Tier-0 tests (multi-question parse + labeled-answer formatting, live mode
  switch re-gates + emits, `/session/:id/mode` validation + persist, `/answer` with `answers[]`);
  **looked at it in Chrome** — approval card, ask form, soft-fence prompt, and a full
  type→Approve→file-on-disk round trip — see [`VISUAL-LOG.md`](VISUAL-LOG.md) (P5b). **Done.**

### P5c — Cost & interruption control (D-33, D-34) ✅ done (2026-07-23)
- Live **whole-tree spend** in a screen corner + settable **cap**; **queued message**
  (turn-boundary, editable/cancelable); **background-task list with per-task kill** (the D-34 kill
  carve-out); **global stop**.
- **Spend (D-33):** cost per model call prefers OpenRouter's authoritative `cost`
  (`usage:{include:true}` → `Usage.costUsd`), falls back to optional per-config `pricing` ($/Mtok,
  cache-aware) for the fake driver/offline. Session tracks whole-tree `spendUsd` (recomputed from
  stored usage on resume, grown per turn incl. the watchdog's out-of-band call), emitted as a
  `spend` event. Settable cap: at/over it the loop **declines the next LLM call, kills nothing**
  (Joshua's call), emits `cap-reached`; raising via `POST /session/:id/cap` resumes.
- **Interruption (D-34):** global stop `POST /session/:id/stop {scope}` — **hard** aborts the
  in-flight LLM (AbortSignal threaded through the driver → fetch), kills all tasks, clears the
  queue; **soft** (a dropdown beside the button) lets running commands finish but takes no further
  turn. **Background tasks:** `run_command` lost its 30s timeout (Joshua's call), spawns in its own
  **process group** (Kill takes the whole tree), and registers in a `TaskRegistry` — listed +
  individually killable (`POST /session/:id/task/:taskId/kill`); the tool result names how it ended
  so a kill reads differently from a clean exit. **Watchdog:** after 30 min (injectable), an
  out-of-band model call sees the task's output-so-far + elapsed and decides kill/keep via a
  `decide_kill` tool — a "no" re-arms and is never appended; a "yes" kills, surfaced only via the
  tool result (so the model knows it killed it), counts toward spend, never touches the tree.
  **Queued message:** typed mid-turn, applied FIFO at turn boundaries (`enqueue` / `setQueue`);
  `send()` now refuses a busy session so the queue is the only mid-turn path.
- **Also fixed:** config-store loader dropped the new `pricing` field (round-trip restored). Fake
  driver now emits token usage so offline spend accounting is exercisable.
- **Verified:** 21 new Tier-0/1 tests (computeCost precedence/fallback/cache-discount; spend accrual
  + cap breach/raise/resume + resume-recompute; hard-abort discards turn; hard clears queue; soft
  finishes command then halts; task list + kill; watchdog yes-kills out-of-band w/o touching the
  tree; watchdog no re-arms; queue FIFO drain; enqueue-while-idle; server cap/stop/queue/task
  endpoints). **Looked at it in Chrome** — spend chip + cap popover, cap-reached banner, task list +
  Kill, queued chip + Queue composer, soft-stop menu — see [`VISUAL-LOG.md`](VISUAL-LOG.md) (P5c).
  **Done.**
- **Done when:** spend + cap are visible and enforced; background tasks are killable; stop halts
  the loop and every task. ✅

### P5d — Branching, journal & rich rendering ✅ done (2026-07-23)
- **Tree-driven chat view:** the browser now renders the **active branch** (`pathToLeaf`) from the
  live entry stream + `GET /session/:id`, with a streaming overlay for the in-flight turn.
- **Branch nav (D-10/D-17):** inline **‹i/n› sibling arrows** switch the active leaf (rewind), a
  **pencil** edit-forks a user message — over the existing `/rewind` + `/edit` endpoints (D-42c).
- **Debug-journal viewer (D-15):** a **per-turn ⓘ expander** on each assistant reply *and* a
  **whole-conversation drawer**, enabled by tagging each `DebugRecord` with the producing turn's
  **`entryId`**; `GET /session/:id` now also returns `conversationId` for the fetch (D-42d).
- **Rich rendering (§11):** real **Mermaid** (the actual library, **lazy-loaded** as a separate
  Vite chunk — D-42a/b relaxes D-25 for build-time frontend deps), **inline images** through
  DOMPurify (http/https/data), and a **TTS** read-aloud button via `speechSynthesis` (D-42e/f).
- **Offline peek driver:** a `demo` prefix in `fakeAgentDriver` returns a rich-markdown reply
  (heading/list/inline PNG data-URI/mermaid) so rendering is eyeballable with no key/spend.
- **Verified:** 6 new Tier-0 tests (journal `entryId` linkage; `/session/:id` `conversationId`;
  client tree helpers — path/siblings/leaf/cycle-safety). **Looked at it in Chrome** — mermaid +
  inline image + markdown, branch arrows ‹1/2› + pencil, per-turn ⓘ journal, and the journal
  drawer — see [`VISUAL-LOG.md`](VISUAL-LOG.md) (P5d). **Done.**
- **Done when:** you navigate branches, inspect a turn's journal, see diagrams/images, hear
  replies. ✅

### P5e — Concurrent sessions — the "bag of agents" (D-36) ✅ done (2026-07-24)
- **Multi-session UI (D-43):** a **left rail** of N live session cards (model, status dot, live
  spend, mode); click to focus, **✕ to close**. Each session keeps its own status/spend/controls;
  the focused pane carries the full header controls + thread + composer. (Shared-folder; worktree
  isolation stays deferred.)
- **Multiplexed per-instance bus (D-43):** the `SessionManager` is now the instance fan-in — a new
  `GET /events` streams every session's events tagged with `sessionId`, plus `roster` /
  `session-added` / `session-removed` lifecycle frames (`manager.subscribe()` seam). One connection
  per instance — the shape the future fleet aggregator (§18) subscribes to. The per-session
  `/session/:id/events` stays for deep-link/embed. The browser folds the bus into an independent
  **slice per session** via a pure reducer (`web/src/session-state.ts`), so a background session's
  spend/status/streaming stay live while another is focused.
- **Close = stop + drop (D-43):** `POST /session/:id/close` hard-stops the session (abort LLM, kill
  tasks, clear queue) and removes it from the bag so it no longer appears/auto-opens; the
  conversation stays on disk (recoverable from history).
- **Verified:** 13 new Tier-0 tests (manager fan-in add/removed/tagged-events + idempotent add;
  `/events` roster + tagged fan-in + late `session-added`; `/session/:id/close` removal +
  `session-removed` + 404s; client slice reducer — descriptor adoption, streaming overlay, tree
  growth/dedupe, spend/cap/tasks, awaiting states, purity). **Looked at it in Chrome** — three live
  sessions in the rail with distinct badges (idle / needs approval / working…), focus-switch swaps
  the pane while the siblings' badges stay live, close ✕ on each — see
  [`VISUAL-LOG.md`](VISUAL-LOG.md) (P5e). **Done.**
- **Done when:** multiple live sessions coexist and are independently drivable in the browser. ✅

### P5f — Serve modes & auth (D-40, was P-01) ✅ done (2026-07-24)
- **Bind scope = the existing `--host` seam** (Joshua's call): a loopback bind serves **auth-free**;
  a **non-loopback (outward) bind requires auth**, replacing P5a's warning with real enforcement.
- **Password provisioning, three ways** on `serve`: **`--password <pw>`** (discouraged),
  **`--password-prompt`** (read via `readSecret`, off argv), **`--generate-password`** (make one +
  print it). If none is given but a password is already stored, it's reused. The password is kept
  **hashed** (`node:crypto` **scrypt**, salted — no native dep, D-25) in the config store's new
  server-wide **`auth`** block.
- **One-hit setup URL is always printed** (Joshua's call — even when the user chose the password):
  a launch-scoped, single-use token embedded in `/?token=…`; first load exchanges it for the cookie
  (303 → clean path) so it never lingers in history.
- **httpOnly signed session cookie** — a stateless `{exp}` payload HMAC-signed with a **persisted**
  `cookieSecret` (Joshua's call), so sessions **survive a server restart**. `SameSite=Strict`,
  `HttpOnly`, no `Secure` (an outward bind may be plain HTTP behind Joshua's TLS proxy).
- **The guard wraps every route** (installed before them): the login POST + one-hit exchange are the
  only unauthenticated paths; a browser navigation without a cookie gets the **login page** (a
  self-contained HTML card that POSTs `/auth/login`), everything else gets **401**.
- **Verified:** 8 new Tier-0 tests (`test/auth.test.ts`: scrypt hash verify + wrong-password reject;
  cookie sign/verify + tamper/expiry/wrong-key reject; cookie-header parse + typeable password;
  guard 401s the API + serves login HTML to browsers; login accepts the right password then the
  cookie unlocks the API; one-hit token is single-use; **no auth dep = open** localhost path; plus a
  config-store `auth` round-trip that drops a partial block). **Looked at it in Chrome** — the login
  page, the one-hit-URL login into the live authenticated app (SSE + API on the cookie), and a
  server-side probe (authed 200 / no-cookie 401 / bad-password 401) — see
  [`VISUAL-LOG.md`](VISUAL-LOG.md) (P5f). **Done.**
- **Done when:** localhost serves auth-free for dev; outward serving requires auth via any of the
  three provisioning modes; nothing sensitive is served unauthenticated when bound outward. ✅

## Phase 6 — Compaction (M4)
**Goal:** long conversations stay in-window and Fable-safe. Sliced into three cuts along the
**engine → controls → live-validation** seam (not P5's six UI surfaces — P6 is one cohesive
headless engine with a thin control layer, so fewer, coarser slices). Each green at the free
tiers before the next; the one paid/live-tier spend is isolated in P6c.

### P6a — Token accounting + trigger detection (headless, Tier-0) ✅ done (2026-07-24)
- **Trigger on authoritative usage, one turn late (D-44):** after each turn the session reads the
  just-finished response's `prompt_tokens` + `completion_tokens` (D-33 already surfaces these) — the
  next request's known prefix — and compares it to the budget, emitting a **`needs-compaction`**
  event (+ latching `session.needsCompaction`) when it's exceeded. Detection only: the loop still
  proceeds (the accepted one-turn overshoot). **No tokenizer / no from-scratch counting.**
- **Budget = `window − buffer`** (D-44c folds D-27's `reservedOutput` into the ~20K buffer). The
  **window is injected** (`Session` `contextWindow` option; tests dial it low to force the
  threshold) with a `compaction.contextLength` config fallback; no window known → no trigger. Live
  OpenRouter `/models` fetch deferred to a later slice (D-44c).
- **Compactor-fit guard (D-44a):** a smaller configured summarizer tightens the threshold
  (`min(working, compactor)`), injected via `compactorWindow`.
- **Trigger-mode plumbing** as resolved state (`activeTriggerMode`: auto / else first configured /
  else auto-but-cancelable default) rides on the signal; compaction itself is still a stub (P6b).
  **Over-window hard-wall hook (D-44b):** `oneAssistantTurn` catches an over-window rejection
  (`isOverWindowError`) and emits a **forced** `needs-compaction` without counting a failure —
  P6b fills the compact-and-retry.
- Pure math + recognizers live in `src/session/compaction.ts` (Tier-0, no model call).
- **Verified:** 17 new Tier-0 tests (`test/compaction.test.ts`: budget/threshold + floor,
  known-prefix, strict-above trigger, compactor-fit tighten/no-op, active mode, over-window regex;
  Session: announces one turn late, quiet under budget, no-window-no-trigger, config override,
  auto mode, compactor-fit earlier trigger, forced over-window without halt). **166 Tier-0/1 green.**
- **Done when:** the session knows *when* to compact from ground-truth usage; deterministic,
  free to test; no model call. ✅

### P6b — Safe-harbor compaction engine (the core, Tier-1) ✅ done (2026-07-24)
- **Checkpoint-overlay entry (D-15/D-17):** `Session.compact()` folds the active branch into a
  `compaction` overlay entry (`replayCut` + summary); `buildWireMessages` (already P6a-ready) resets
  at it, so the next request replays only `system + summary`. **Safe-harbor cuts at the tip**
  (D-44d): the append-only parent-pointer tree can't insert a summary mid-chain and keep a tail
  without re-parenting, which is exactly *why* v1 summarizes everything and keeps nothing — so the
  cut is always the current leaf and always a whole-cycle boundary.
- **Safe-harbor v1 (D-38):** summarize *everything* prior (zero thinking replayed) — Fable-safe by
  construction. **Cache-reuse same-model path (D-29):** the exact live wire prefix + an **ephemeral**
  instruction (`tool_choice:"none"`, `max_tokens`≈4K, never written to the tree); the provider serves
  the prefix from prompt cache. `tool_choice` added to `ChatRequest` (the client already spreads
  `...req`, so no client change).
- **Anchored evolving structured summary (D-28):** `buildCompactionInstruction` names the fixed
  template (Goal / Constraints / Progress / Key Decisions / Next Steps / Critical Context / Relevant
  Files) and asks for **bookend quoting** (original request + latest turn near-verbatim). On a later
  compaction the prior summary is already in the replayed prefix, and the instruction tells the model
  to fold it in — the **evolving** summary. The just-sent user message is folded into the summary
  (preserved by the bookend quote), not answered live (D-44d(b)).
- **Auto-in-loop (D-44d(a)):** the resolved `auto` trigger mode compacts before the next send once
  ground-truth usage latches `needsCompaction`; the other four modes route through the UI (P6c).
- **Fills the D-44b over-window fallback:** `assistantTurnWithCompaction` catches the over-window
  rejection → compacts (forced, tool outputs truncated in the summary input so it fits) → retries the
  turn once; still-too-big settles idle (unrecoverable by same-model compaction — the flattened
  cross-model path is P6c). Pure pieces (instruction, truncation) in `src/session/compaction.ts`.
- **Verified:** 10 new Tier-1 tests (`test/compaction-engine.test.ts`: instruction sections/order +
  bookend + evolving fold-in line; tool-output truncation keeps tail/marker & doesn't mutate/​cap
  user text; `compact()` overlay entry + cache-reuse request shape (exact prefix + ephemeral
  `tool_choice:none` instruction) + reset wire + ephemeral-not-persisted; nothing-to-compact no-op;
  auto compacts-then-continues with the reset wire; non-auto stays put; evolving replays the prior
  summary; forced compact-and-retry recovers + `forced:true`; double-over-window gives up idle).
  **176 Tier-0/1 green.** Headless engine — no new UI surface (trigger-mode UI is P6c), so no
  browser peek this slice.
- **Done when:** a real conversation crosses the budget, compacts, and continues coherently
  against the cached driver. ✅

### P6c — Trigger-mode UX + cross-model path + Fable validation ✅ done (2026-07-24)
- **Browser controls for the five trigger modes** (D-27, D-44e): a header selector (persisted like
  mode/approval) + `auto` (silent) · `manual` (anytime **compact** button) · `suggest`
  (non-blocking banner + **Compact now**) · `cancelable` (a real pre-send pause — **Compact / Skip
  once**) · `hard` (pre-send pause, **Compact only**). The blocking modes use a new
  `awaiting-compaction` status that mirrors `awaiting-approval`: once ground-truth usage latches
  `needsCompaction`, the next `send()` holds the turn for a decision (`POST /session/:id/compact
  {skip?}` resolves it; `POST /session/:id/trigger-mode` switches mode). Skip accepts the one-turn
  overshoot (D-44); hard can't skip.
- **Cross-model summary path (D-29, refined per Joshua in D-44e):** a cheaper compactor gets the
  ordinary structured `ChatMessage[]` via the same OpenRouter driver (just a different `req.model`)
  — **readable `reasoningText` kept** (the planning), the **signed `reasoning_details` dropped**
  (the one non-portable field), tool outputs truncated (~2K). No plain-text flatten; no cache reuse
  (different model). `buildCrossModelSummaryInput` is pure (Tier-0).
- **LLM-as-judge helper + the Fable-valid-request test (Tier 3, ran live):** (a) normal replay
  round-trips `reasoning_details` **verbatim** and Fable accepts it (D-14); (b) a safe-harbor
  `compact()` produces a **Fable-accepted, coherent** request (D-28/D-38). Recorded against
  `anthropic/claude-fable-5`, judged by `anthropic/claude-haiku-4.5`, into the committed
  request-keyed cache (replays free — verified 292ms, no key). Helpers in `test/helpers/{live,judge}.ts`.
- **Verified:** +19 Tier-0/1 tests (`compaction-p6c`: cross-model shaping/request, cancelable/hard/
  skip pause, suggest/manual no-gate, manual compact-now, trigger-mode switch; `server-p6c`: state
  exposure, switch+persist+validate, HTTP pause→resolve/skip; `web-session-state`: the compaction
  events fold) + 2 live Fable tests (replayed free). **Looked at it in Chrome** — the header
  trigger-mode selector, the cancelable pause card (token detail, Compact/Skip, composer blocks),
  and the non-blocking suggest banner — see [`VISUAL-LOG.md`](VISUAL-LOG.md) (P6c). **194 Tier-0/1
  green.**
- **Done when:** conversations compact automatically/optionally, drivable in the browser, without
  breaking Fable. Milestone M4 (O-02 resolved by design, D-38). ✅

- *(Fast-follow, post-v1: partial-keep-lite #2 for higher recent-context fidelity — D-38.)*

## Phase 7 — MCP client (X-01), post-v1

**Goal:** JLCode consumes MCP servers configured in KiloCode's `mcp_settings.json` format —
starting with [`../file_utils`](../../file_utils) — with every call still passing the same
mode∩approval gate and workspace fence as a native tool. Design calls in **D-47**.

### P7a — Config, stdio client & tool bridge (headless, Tier-0/1) ✅ done (2026-07-28)
- **Config (D-47a):** `mcp_settings.json` in the config store + optional per-workspace
  `.jlcode/mcp_settings.json` (same server name → workspace entry replaces global);
  `jlcode mcp import` copies KiloCode's file over; `jlcode mcp list` shows servers/status.
- **Client (D-47c):** `@modelcontextprotocol/sdk` stdio transport, one child per enabled server;
  connect → `tools/list` → bridge. A server that fails to start or times out is **reported, not
  fatal** — the session runs with the tools it has.
- **Bridge (D-47b/d):** each MCP tool becomes a `Tool` (`<server>__<tool>`, schema forwarded
  verbatim), classified conservatively unless `readOnlyHint`; args flattened to jq-style dot paths
  for the learned path-field lists (unknown slashy field ⇒ treated as a path until P7b can ask).
- **Lifecycle (D-47e):** one child per server per **instance**, started in `serve` before the
  listen and closed on shutdown; every session gets the same bridged tools. Flagged: a server with
  per-session memory (file_utils' `project_root`) then shares it across sessions.
- **Verified:** +28 tests (`mcp-config` Tier-0: merge/override, bad entries incl. a `url` remote,
  torn JSON, `env` as name-list or object, write-back preserving the rest of the file, and the
  whole flatten/classify/remember path — `edits[].file` asked once for N elements; `mcp-client`
  Tier-1 against a **real spawned stdio server**: discovery, conservative-vs-`readOnlyHint`
  classing, calls, tool errors, a dead server that doesn't take the others down, `alwaysAllow`
  pre-approval that still can't beat Ask mode or `read-only`, learned fields landing in the owning
  file; `mcp-session` Tier-1: an MCP write through the approval pause, an out-of-fence MCP path
  caught **even under full-auto**, a prose-classified slashy arg passing free, an unclassified one
  fenced fail-closed). **237 Tier-0/1 green.** Also driven for real: `jlcode mcp import` off
  Joshua's actual KiloCode `mcp_settings.json`, then `mcp list --probe` → **`file_utils`
  connected over `uvx`, all 6 tools discovered and namespaced**.
- **Done when:** a real stdio MCP server (spawned in-test) is discovered, listed, and callable
  through the gate, headless. ✅

### P7b — Session/UI integration: learn-on-pause + the MCP status surface ✅ done (2026-07-28)
- **Learn-on-pause (D-48).** The pause carries the questions JLCode's own guesses raise — *does
  `<tool>` write anything?* (D-47b) and *is `<field>` a file path?* (D-47d) — answered in the
  browser beside approve/deny and persisted into the owning `mcp_settings.json`. Answers are facts
  about the tool, not consent: kept on a deny, and applied **before** the fence is re-evaluated, so
  a field just called prose widens nothing (the card drops the fence block live).
- **Never a pause just to ask** (Joshua's rule): if the policy would let the call through
  unattended, the answer wouldn't change the outcome, so nothing is asked.
- **A denial resting on a guess becomes a question.** Ask mode / `read-only` blocking a
  *presumed*-writing tool now raises the write question instead of a silent wall — answering
  read-only reclassifies it and the call proceeds; "it writes" denies it permanently.
- **Status surface:** `GET /mcp` + a read-only browser drawer (server state/scope/error, each
  tool's live gate class with a **presumed** marker and `alwaysAllow`, the learned lists, and both
  settings-file paths); `jlcode mcp list --probe` shows the same classes.
- **Verified:** +12 tests (Tier-0 `classifyTool`/`rememberTool`; Tier-1 against the real spawned
  stdio server — the fence pause carrying the unclassified field, a prose answer sticking to disk
  and the next identical call running free, a path answer still fencing but not re-asking, the
  manual-approval write question relaxing the tool, Ask mode's block becoming a question that
  unblocks, full-auto in-fence staying silent, `readOnlyHint` never asked about; server-route tests
  for `/mcp` and the `learned` wire shape). **249 Tier-0/1 green.**
- **Peeked in Chrome** — the card, its live reaction, and the drawer, against the real fixture MCP
  server; see [`VISUAL-LOG.md`](VISUAL-LOG.md). The fake driver gained an `mcp: <tool> <json>`
  prefix so bridged calls can be driven offline.

### P7c — Live validation against `file_utils` ✅ done (2026-08-11)
- Drive the real `uvx` server end-to-end: anchor-based read/edit through the fence and the gate. ✅
- **Ran against the real server**, `uvx`-installed console script, fake LLM driver (no model spend —
  the *server* is what was under test, not the model). Confirmed, in this order:
  **discovery** (`mcp list --probe` → `connected file_utils (global) 6 tools`, namespaced
  `file_utils__*`); an **anchor-based read** of a 400-line file returning exactly the 21-line span
  between `ANCHOR-START`/`ANCHOR-END`; an **anchor-based edit** through the approval pause
  (`replaced_lines: 21 → new_lines: 1`, verified on disk); an **out-of-fence path** producing a
  D-19 soft-fence pause that names the offending *field* and suggests a root
  (`outOfFence: {paths:["/etc/hostname"], fields:["path"], suggestedRoot:"/etc"}`); the same
  **under `full-auto`, where it still pauses** — an in-fence read under the same policy runs
  without one, so the fence is not something an approval policy can switch off; and **deny**,
  which returns `denied by user: <reason>` to the model and reads nothing.
- **Two defects fell out of it — H-08 below (a real fence bypass) and the `readOnlyHint` gap.**
- **Also fixed, upstream:** `file_utils` itself crashed on every launch of its documented
  `uvx --from git+…` path — `mcp>=1.0.0` with no upper bound resolved mcp 2.0.0, which removed the
  low-level decorator API the server is written against, so it died on *import* with
  `AttributeError: 'Server' object has no attribute 'list_tools'` before any protocol traffic, and
  the host restarted it forever. Its `uv.lock` pins 1.27.2, so `uv run` and its 98 tests passed
  throughout — the lock is not read by a *tool* install. Capped at `<2`, PR'd to `JEL-LL/file_utils` and **merged by Joshua 2026-08-11** (PR #1, `0deb84f`). **P7c could not have run at all
  until this was found**, which is the argument for live validation in one sentence.

## Hardening / known issues (discovered defects — separate from the phase plan)

- **H-08 — a poisoned `project_root` on a shared MCP server bypasses the workspace fence entirely.**
  Found 2026-08-11 by P7c, driving the real `file_utils` server; **FIXED 2026-08-11 (D-73)** —
  an escaping path on a bridged tool is now *remember-this-root or deny*, never allow-once, and a
  plain approve is refused with the reason rather than silently treated as remember. Re-run live:
  the old answer is refused, and the follow-up call fails at the server with
  `Relative path 'hostname' requires a project_root`, because the root never lands. +3 Tier-0 tests
  built from the single-session repro. Peeked in Chrome (VISUAL-LOG "H-08"), which needed a new
  `peek --mcp <file>` — the MCP surfaces had never been peekable, since children spawn before the
  listen. **The two options below were not taken, and why is worth keeping:**
  - **Symptom, reproduced end to end.** A session read `/etc/hostname` with **no pause at all**,
    `status: idle`, under any approval policy — and **it takes only one session**: setting an
    escaping `project_root` (which *does* pause) and then asking for a bare `hostname` in the very
    next call of the same session is the whole exploit. That fact is what re-ranks the fixes below.
  - **Scope, corrected by Joshua 2026-08-11 — a JLCode instance is project-local.**
    `session-factory.ts:66` builds every session's sandbox from `[deps.cwd, ...folderRoots[cwd]]`,
    the instance's launch directory, so **all sessions in one instance already share one root**
    (`/chat`'s `dir` only filters history). So the cross-session half of this is a *wrong file in
    the same project*, not a cross-project leak, and the first draft of this row over-weighted it.
    The escalation is the serious half, it escapes the project outright, and it does not need a
    second session.
  - **Two correct-alone mechanisms compounding**, which is why neither side caught it:
    1. **D-47e, flagged at the time and now demonstrated:** one MCP child per **instance**, shared
       by every session. `file_utils` remembers `project_root` in per-process memory (its SPEC
       §"session-level state" says each process is "unique to one agent/session" — an assumption
       JLCode quietly breaks). So session A setting a root silently re-points session B.
    2. **The bridge classifies a *slashy* argument as a path** (D-47b, "unknown slashy field ⇒
       treated as a path"). A bare `hostname` has no slash, so it is not a path, so the fence never
       evaluates it. The fence sees the **argument**; the server resolves the **root**.
  - **The chain:** A calls with `project_root: "/etc"` → the fence *does* pause on A (`/etc` is
    slashy and escapes) → allow-once → `/etc` is now the remembered root for the whole instance →
    B asks for `"hostname"` → not slashy, not a path, no pause → the server resolves it against
    `/etc` and returns the file. **Allow-once granted for one call in one session became a
    standing grant for every session, on a path nobody ever saw.**
  - **Milder version, no approval needed at all:** with A's legitimate `project_root` set to a
    subdirectory, B's relative `inner.txt` silently resolved to *A's* copy rather than B's —
    confirmed. So this is a correctness bug before it is a security bug.
  - **Fix options, re-ranked once the single-session repro landed:**
    (b) **Treat server-side root state as fence state — this is the fix.** An escaping root is
        **never allow-once**: deny or remember-root only, so a widened fence is a thing the user
        chose and can see, rather than a silent standing grant. Optionally, once a session has set a
        root on a server, stop trusting the slashy heuristic for that server and treat unclassified
        strings as paths (fail-closed), with D-48's learn-on-pause absorbing the noise — that is
        option (c) scoped to servers where a root is actually in play, instead of everywhere.
    (a) **One MCP child per session** — *does not fix the above*, since the exploit fits in one
        session. It fixes the milder correctness bug (B's relative path resolving against A's root)
        and it is what `file_utils`' own SPEC assumes. Worth doing on its own merits, and it becomes
        **required** the moment sessions stop sharing a root — i.e. D-36 (worktree isolation) and
        X-14 (sessions on different forks), which is precisely the crack D-47e named. Spawn lazily
        on a session's first call so a session that never touches MCP pays nothing, keeping what
        D-47e actually cared about.
    (c) Fail-closed on *every* unclassified argument everywhere: safest, noisiest, and (b)'s scoped
        version gets most of it for far less friction.
  - **Not a `file_utils` defect.** Its SPEC is explicit that containment is the host's job and that
    each process belongs to one agent. JLCode is the party that broke that assumption.

- **`readOnlyHint` gap (minor, found by P7c 2026-08-11).** All six `file_utils` tools bridge as
  `[command, presumed]`, including `read_file_range`, which is genuinely read-only — the server
  advertises no `readOnlyHint`, and D-47b classifies conservatively when it is absent. Correct
  behaviour, mildly annoying result: every anchor *read* needs an approval in manual mode. Two
  independent fixes and they compose: teach it once through D-48's learn-on-pause, and/or add
  `readOnlyHint: true` to that tool upstream (a second small PR to `JEL-LL/file_utils`).

- **H-07 — the browser's TTS jams: an utterance that fails leaves the UI stuck "speaking" forever.**
  On Joshua's unfiled observed-items list as one line ("TTS jamming intermittently") from
  2026-08-06; **reproduced and FIXED 2026-08-08 (D-70)**, shipped with X-13 because auto-read makes
  an intermittent jam constant.
  - **Symptom.** The per-message 🔊 turns to ◼ and stays there with nothing being read. Clicking the
    same message again clears it, which is why it read as a shrug rather than a bug — and why it
    looked intermittent: it depends on which terminal event the engine happened to pick.
  - **Cause.** `toggleSpeak` (`web/src/App.tsx`) registered `u.onend` and **no `onerror`**. Chrome
    fires `error` **instead of** `end` on every failure path, and those paths are ordinary, not
    exotic: `interrupted` whenever one reply replaces another, `synthesis-failed` on a cold engine,
    `not-allowed` with no user gesture. Any of them left `speakingId` latched, and the single
    `speakingId` invariant is what the whole feature rests on.
  - **Observed** (real Chrome, VISUAL-LOG "X-13"). Twenty replies each replacing the last:
    **19 ended `error: "interrupted"` with no `end` event**, and one was accepted by `speak()` and
    **never started at all** (~5% dropped outright — the "intermittent" in one number). The
    deterministic case is simpler: click 🔊 once on a cold engine and wait — **five fresh browsers,
    five permanently latched buttons**, every one `error: "synthesis-failed"` with `speakingId`
    still set fifteen seconds later.
  - **The fix — one owner, and every exit accounted for.** `web/src/tts.ts` owns `speechSynthesis`
    for the whole client; the 🔊 button and auto-read are both callers, so the UI's idea of
    "speaking" and the engine's cannot drift. Every terminal event is handled; our own cancels are
    told apart by a **generation counter** rather than an error code (the replaced utterance's
    `interrupted` arrives *after* the replacement is registered); `speak()` **never shares a task
    with `cancel()`**; and two watchdogs — no `start` within 4s, no `end` within a generous estimate
    — reset the channel even when the engine says nothing at all. Re-measured in the same rig:
    **0/5 latched**, cleared at 61ms by the `onerror` handler, with neither watchdog needed. That
    ordering matters: the fix addresses the cause, and the watchdogs are the backstop.
  - **Deliberately not done: chunking.** It is the usual hedge against Chrome's ~15s cutoff on long
    utterances, which **could not be reproduced here** (an 1,800-character utterance ran past 40s
    with no cutoff). Chunking would pay a certain ~300ms gap at every sentence boundary — the
    measured `start` latency, once per chunk — against a bug this container cannot demonstrate. A
    periodic `resume()`, free on a healthy engine, hedges it instead. **If Joshua ever hears a reply
    cut off at about fifteen seconds, chunking is the fallback and `tts.ts` is where it goes.**
  - **Coverage.** `test/web-tts.test.ts` — the fake engine is built to the *measured* behaviour
    (error instead of end, asynchronous `start`, a `speaking` flag that lies), so each test is a
    state the old shape could enter and never leave.

- **H-05 — a fork or branch-switch *during a running turn* re-parents the in-flight reply; the
  pointer moves even when the edit is rejected.** Found 2026-07-28 by inspection + a scratch
  repro, after Joshua asked what happens if you edit a message while the model is working.
  **FIXED 2026-07-31** — see the fix section at the end of this entry for what shipped.
  - **Symptom.** Pencil-edit an earlier message mid-stream: the browser shows
    *"Session is busy; queue the message instead."* and then the model's reply **disappears** from
    the transcript. After a reload the transcript can show a single orphaned assistant message
    where the conversation used to be.
  - **Cause — two independent holes.**
    (a) `Session.editFork` (`src/session/session.ts:686`) moves `activeLeaf` to the edited entry's
    parent **before** calling `send()`, and `send()`'s busy guard (`:766`) throws *after* the move.
    The route catches the throw and returns 400 (`src/server/server.ts:576`), but nothing rolls the
    pointer back. (b) `POST /session/:id/rewind` → `setActiveLeaf` (`:676`) has **no** busy guard at
    all, so the branch arrows move the pointer under a running loop — and that path *feels* passive,
    which is what makes it the likelier way to trip this. The UI disables neither affordance while
    working (`web/src/App.tsx:1262`, `:1301`). Either way the running loop appends its
    assistant/tool entries via `pushEntry`'s **default** parent — whatever `activeLeaf` happens to
    be when the stream finishes (`:1070`, `:1117` → `conversation/tree.ts:27`).
  - **Observed** (scratch repro against `dist/` with a driver parked mid-stream). Editing the
    *first* user message left `activeLeaf = null`, so the reply attached to the **root** as a second
    top-level branch and the replayed path became one lone assistant message with the entire
    conversation off-path. The arrow case recorded a reply generated from branch **B** as a child of
    branch **A**, yielding a path with two assistant turns back to back and the prompting user
    message stranded on the other branch. The session then settles to `idle` and keeps building on
    the corrupted branch.
  - **Why it looks like data loss.** `editFork` mutates the field directly instead of going through
    `setActiveLeaf`, so **no `active-leaf` event is emitted**. The client's reducer only advances its
    leaf when `entry.parent === s.activeLeaf` (`web/src/session-state.ts:139`), so the reply is
    folded into `entries` but never rendered while the streaming overlay retires. On disk the
    entries carry the wrong `parent`, and `load()` rebuilds `activeLeaf` from the last entry record
    (`persist/conversation-store.ts:162`) — so a reload faithfully restores the damaged shape.
    Nothing is actually lost (append-only), and the orphan renders as a sibling so ‹1/2› navigates
    back; you just have to know that's what happened.
  - **Not affected.** The in-flight call is never aborted (only `stop("hard")` touches
    `abortController`), and there is never more than one turn in flight — one loop, one leaf per
    session, and `send()` does refuse while running.
  - **The fix — Joshua's call: pin the turn's parent at turn start** (D-54). `send()` records the
    active leaf in `Session.turnLeaf` before the first append; `pushEntry` defaults to that pin and
    advances it, so the turn's entries chain off each other regardless of later pointer moves. The
    pin outlives an approval / ask_user / compaction pause and a spend-cap block — all of which
    resume the *same* turn — and is released when the loop settles (an `advance()` wrapper owns
    that). It is also the leaf every wire build for the turn walks (`buildRequest`, `compact`,
    the watchdog, auto-title), so a mid-turn switch can't re-shape the request in flight.
    Alongside it: `appendEntry` moves `activeLeaf` only when the append continues the branch it
    points at (`load()` mirrors the rule, tolerating pre-fix logs whose edit-fork moved the pointer
    silently); `editFork` checks busy **before** mutating and routes the move through
    `setActiveLeaf`, which now accepts `null` for a fork of the first message. The guard-only
    variant (reject mid-turn navigation) was considered and is explicitly *not* what shipped.
  - **UI.** The affordances stay enabled — the point is to *allow* reading another branch mid-turn.
    One change was needed: `assistant-start` now carries the pinned `parent`, and the browser draws
    the streaming overlay only while the branch in view is the one the turn belongs to. Without it
    the live text trailed the reader onto whatever sibling they switched to.
  - **Coverage.** `test/fork-rewind.test.ts` gained the parked-driver shape from the repro (park the
    stream, act, release, assert the parent): the arrow case, the rejected-edit case, the pin
    surviving an ask_user pause (asserting the *replayed* branch too), and the persistence replay.
    Plus store-level tests for both replay rules and a reducer test for the overlay's branch.
  - **Why it mattered beyond the bug: X-14.** Joshua wants **multiple agents running on different
    forks at the same time**. Pinning the turn's parent is the correctness floor under that — the
    invariant "a turn's entries belong to the branch that turn started on" is exactly what has to
    hold once more than one live session can touch one conversation tree. **X-14 is unblocked**;
    its remaining questions (tree copy vs shared instance, rail/UI, spend roll-up) are untouched.

- **H-04 — streamed `reasoning_details` were appended, not merged; every signed thinking block
  was stored malformed.** Found 2026-07-28 (the *second* `Invalid signature` report, after H-02's
  provider pin was already working); **FIXED 2026-07-28.**
  - **Cause.** OpenRouter streams `reasoning_details` as **deltas keyed by `index`**: the text
    arrives in pieces and the `signature` lands in a final fragment carrying no text.
    `accumulate()` did `reasoningDetails.push(...ev.value)` — appending fragments. One real turn
    was stored as four blocks, all `index: 0`: `text:"I"`, `text:" should just confirm…"`,
    `text:" being asked."`, and a fourth holding only a 380-char `signature`. Replaying that
    sends four partial thinking blocks plus an orphan signature covering content that was never
    reassembled, so the provider rejects it.
  - **Why the H-02 pin didn't save it.** The journal (added by D-49) showed the pin *working* —
    call 1 Bedrock, call 2 pinned to Bedrock and honored — and call 3 still failing. Same
    provider, same block, accepted then rejected. That ruled routing out and pointed at the
    payload. **Both defects were real and independent**: H-02 is a genuine cross-provider hazard,
    H-04 was corrupting the blocks regardless of where they were sent.
  - **Fix.** `ReasoningAssembler` in `src/llm/stream.ts` folds fragments by `index` —
    content fields (`text`/`data`/`summary`) concatenate, envelope fields
    (`type`/`format`/`signature`/`id`) take the latest. Details with **no** `index` keep the old
    one-entry-each behaviour (other providers don't fragment), and non-object details pass
    through untouched. Still opaque per D-14: reassembling a stream the way the protocol defines
    is not interpreting it.
  - **Verified.** +6 Tier-0 tests using the fragment shapes taken verbatim from the failing
    conversation — merge-into-one-signed-block, distinct indices stay separate in first-seen
    order, encrypted `data` concatenation, un-indexed passthrough, opaque non-objects, and
    fragments delivered as one whole-array delta. Both replayed Fable tests (the D-14 verbatim
    round-trip) still pass. **275 Tier-0/1 green.**
  - **Known limitation:** conversations recorded *before* this fix still hold fragmented
    reasoning on disk and will keep failing on resume — the log is append-only and is not
    rewritten. Start a new conversation.

- **H-03 — Ctrl-C didn't stop `serve` while a browser tab was open; and it skipped the flush.**
  Found 2026-07-28 (Joshua: *"control c doesn't kill the server, it just appends ^C"*);
  **FIXED 2026-07-28.**
  - **Cause.** The SIGINT handler was `() => server.close(() => resolve(0))`. `server.close()`
    stops *new* connections and then waits for in-flight ones — and the multiplexed SSE bus
    (§11, D-43) is a request that never ends, so the callback never fired. The `^C` on screen
    was ordinary terminal echo; the signal arrived and was handled, the handler just never
    finished. Joshua confirmed the mechanism independently: closing the tab let Ctrl-C work.
  - **Second, quieter defect.** That handler bypassed the durability flush `POST /shutdown`
    ran via `closeServer` — so on the occasions Ctrl-C *did* exit (no tab open), queued
    conversation/journal records could be dropped and MCP children left unreaped.
  - **Fix.** One teardown for both paths in `src/server/shutdown.ts`: flush the store, journal
    and MCP children, then `server.close()` **followed by `closeAllConnections()`** to drop the
    held-open SSE streams so close can complete. Idempotent, so a repeated signal can't start
    two teardowns; a **second Ctrl-C exits immediately** without waiting for the flush, so a
    stalled write (D-46) can never produce a process the user can't kill from their terminal.
    Banner updated to say so.
  - **Verified.** +5 Tier-0 tests over a stub server that reproduces the hold-open behaviour
    (flush-before-close ordering, completion despite a held connection, shutdown still
    completing when the flush throws, idempotency, and tolerance of a server without
    `closeAllConnections`). Plus an out-of-band real-process repro: `serve` + a live SSE
    stream + `SIGINT` hung before the fix and exits after it, and the same for
    `POST /shutdown`. **269 Tier-0/1 green.**

- **H-02 — OpenRouter re-routes mid-conversation; replayed reasoning signatures then fail.**
  Found 2026-07-28 in real use (Opus 5 via OpenRouter); **FIXED 2026-07-28 (D-49).**
  - **Symptom.** Two turns succeed, the third dies with
    `400 … messages.1.content.5: Invalid signature in thinking block`, naming
    `Claude Platform on AWS` with `Amazon Bedrock` in `previous_errors`. Message *1* is the
    **first** assistant turn — a block signed two turns earlier.
  - **Cause.** `ChatRequest` carried no `provider` field, so OpenRouter chose a backend per call.
    Anthropic `thinking` blocks carry a signature only the minting deployment can verify, and
    D-14 replays `reasoning_details` verbatim — correctly. The bug was never the replay; it was
    that the replay *target* moved. Nothing recorded which backend served a turn, so the switch
    was invisible until it failed.
  - **Fix.** The reported backend is captured from the stream (`chunk.provider`), stored on the
    `AssistantEntry`, and folded back out of the replayed window by `pinnedProvider()`; later
    requests send `provider:{order:[pin],allow_fallbacks:false}`. Derived, not stored as state —
    so old logs don't pin, forks follow their own branch, and a compaction `replayCut` releases
    the pin (no signatures survive a summary). The journal now records `provider`/`pinnedTo`, so
    a re-route is visible at the turn it happens instead of two turns later.
  - **Verified.** +15 Tier-0 tests — `pinnedProvider` fold (first-turn-wins, no-provider logs,
    release-at-cut, re-pin after cut, per-branch on a fork), stream capture/accumulate,
    cache-hit round-trip (a hit would otherwise drop the pin), and session end-to-end
    (no pin on call 1, binding pin on 2+, unmoved by a later turn reporting elsewhere).
    **264 Tier-0/1 green.** Live-checked against OpenRouter that chunks carry `provider`, that
    `order` takes the reported display name verbatim, and that an unroutable pin 404s rather
    than silently falling back.
  - **Known cost:** a pinned conversation gives up OpenRouter's failover. Deliberate — a
    failover would reject the history anyway (D-49).

- **H-01 — `AppendLog` write failures are silent; open fds are unbounded.** Found 2026-07-24;
  **FIXED 2026-07-24 (D-46).** Both weaknesses in `src/persist/append-log.ts` are closed:
  - **Silent dropped writes → a blocking, recoverable pause.** `append()` no longer swallows
    write errors, and `flush()` no longer awaits a *swallowed* tail (it now **rejects** while a
    write is stalled, so read-your-writes can't report success after a failure). A failed record
    stays at the **head** of the queue with later appends stalled behind it — draining past a
    failure was the real corruption risk (record N+1 landing with a `parent` that never wrote →
    dangling tree on load). The store raises a fault, `server.ts` stops discarding the promise,
    and the session enters **`awaiting-persistence`**, reusing the hard-stop unwind so a running
    turn settles at its existing safe points. The browser shows a blocking banner with **Retry**
    (fix the disk → the queued records land in order) plus an explicit, confirm-gated discard.
  - **Unbounded open descriptors → none retained.** Each record now opens/writes/fsyncs/closes
    under `await using` (`Symbol.asyncDispose`), so no fd outlives its write. Measured: the extra
    open/close is within run-to-run noise of the ~140ms fsync that dominates. Verified the test
    discriminates — the old shape leaks +60 fds across 60 conversation logs, the new one +0.
  - **Not at risk (unchanged):** interleaved/garbled JSONL (one serialized queue per file);
    a crash-torn *last* line is still dropped by the tolerant loader parse.
  - **Verified:** +13 Tier-0 tests — `append-log` fault/stall/retry/discard/fd-growth (failure
    injected for real via a read-only dir → EACCES, not an fs mock), `persistence-fault`
    store→session→HTTP round trip incl. refusing new work while stopped and a coherent tree
    after recovery, and the `web-session-state` fold. **206 Tier-0/1 green.**
  - *Note: the separate `test/append-log.test.ts` **flake** was root-caused earlier to fsync
    latency and fixed with a realistic timeout — unrelated to the defects above.*

## Later (post-v1; see DECISIONS "Deferred" X-01…X-18)

> **Convention (Joshua's call, 2026-08-09): nothing leaves this list.** A row that
> ships is struck and tagged with the decision that closed it, so the list still
> answers *what's left* at a glance while staying the index of everything ever
> deferred — including the ones already done, which is where a year-from-now
> question starts. The filed-and-fixed entries above carry the reasoning.

**Still open:**
**copy an assistant reply's markdown to the clipboard (X-18)** ·
**multiple live sessions on different forks of one conversation (X-14)** ·
**reasoning notes default-open, a browser-side UI preference (X-16)** ·
agent-facing background commands — start/poll/tail/kill (X-36) ·
symbol navigation over MCP, route sized, home undecided (X-34) ·
Notifications (external push, P-02) ·
agent-directed minimize/expand (X-08) · **agent orchestration / sub-threads (§27, D-35)** ·
**workspace isolation via git worktrees (§27, D-36)** · remote control / fleet view (§18) ·
browser-driven app testing · VS Code webview · response-caching product feature (§21) ·
file viewer & upload/download chrome.

**Shipped since:**
~~a `write_file` preview instead of raw JSON (X-23)~~ ✅ D-63 ·
~~a context-usage meter beside the spend chip (X-24)~~ ✅ D-61 ·
~~per-user-turn timestamps so the model knows the date (X-25)~~ ✅ D-64 ·
~~a blip when a session needs attention (X-26)~~ ✅ D-65 ·
~~a settable compaction threshold, e.g. 171.5k (X-27)~~ ✅ D-62 ·
~~TTS auto-read when the agent hands the turn back (X-13)~~ ✅ D-70 ·
~~auto-read the workspace's `AGENTS.md` into the system prompt (X-15)~~ ✅ D-69 ·
~~auto-re-title a thread as it drifts (X-17)~~ ✅ D-66 ·
~~the agent's shared todo list (X-31)~~ ✅ D-74 ·
~~a visible, configurable command watchdog + a per-call `timeout` (X-33)~~ ✅ D-76 ·
~~`run_command` `cwd` + an `apply_edits` refusal that names the sibling file (X-35)~~ ✅ D-76.

**Closed without a fix:**
~~the model seeing its own output budget (X-32)~~ — no fix (D-75): the ceiling could be stamped, but
a live meter cannot exist, since the only channel to a generating model is a prompt already sent.

---

## Milestones
- **M1 — "Talk to a client":** Phases 0–2 (selected config → real conversation, headless).
- **M2 — "Does real work":** Phase 3 (sandboxed tools under mode/approval).
- **M3 — "Real product":** Phases 4–5 (persistent, forkable, in the browser).
- **M4 — "Fable-proof at scale":** Phase 6 (compaction, O-02 resolved). ✅ **done (2026-07-24)** —
  P6a trigger detection + P6b safe-harbor engine + P6c trigger-mode UX / cross-model path / live
  Fable validation.
