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

Built, tested (**194 Tier-0/1 tests green**, + 2 live Fable tests that replay free from the committed
cache), and committed through **P6c — Phases 0–6 done, Milestone M4 reached**:

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
compaction releases it. **264 Tier-0/1 green** (+2 replayed Fable). **Next: P7c** — live
validation against the real `file_utils` server. Rendered surfaces get a real-browser peek per
slice, logged in `VISUAL-LOG.md` (through P7b).

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

### P7c — Live validation against `file_utils`
- Drive the real `uvx` server end-to-end: anchor-based read/edit through the fence and the gate.

## Hardening / known issues (discovered defects — separate from the phase plan)

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

## Later (post-v1; see DECISIONS "Deferred" X-01…X-09)
**conversation labels — auto-titled + hand-editable (X-09)** ·
Notifications (external push, P-02) · MCP client (KiloCode `mcp_settings` format) ·
agent-directed minimize/expand (X-08) · **agent orchestration / sub-threads (§27, D-35)** ·
**workspace isolation via git worktrees (§27, D-36)** · remote control / fleet view (§18) ·
browser-driven app testing · VS Code webview · response-caching product feature (§21) ·
file viewer & upload/download chrome.

---

## Milestones
- **M1 — "Talk to a client":** Phases 0–2 (selected config → real conversation, headless).
- **M2 — "Does real work":** Phase 3 (sandboxed tools under mode/approval).
- **M3 — "Real product":** Phases 4–5 (persistent, forkable, in the browser).
- **M4 — "Fable-proof at scale":** Phase 6 (compaction, O-02 resolved). ✅ **done (2026-07-24)** —
  P6a trigger detection + P6b safe-harbor engine + P6c trigger-mode UX / cross-model path / live
  Fable validation.
