# JLCode — Roadmap

Status: **building.** Architecture settled ([`DECISIONS.md`](DECISIONS.md) D-01…D-38, no open
items). Phases **0–3 done** (Milestones M1 "talk to a client" + M2 "does real work" complete).
**Next: Phase 4 — persistence + resume + fork/rewind (M3).**

Principle: **bottom-up, runnable early.** Each phase leaves something that works and is
testable at the free tiers ([`TESTING.md`](TESTING.md) Tiers 0–1).

## Current status — resume here

Built, tested (69 Tier-0/1 tests green), and committed through `b70532f`:

- **P0** scaffold (npx `jlcode` bin, config/data dirs, rotating diagnostic logger, CI).
- **P1** config store + folder-aware model selection (`config list/which/use/clone/add/set/remove`;
  keys via stdin or `JLCODE_ADD_KEY`; `config.json` chmod 600).
- **P2** OpenRouter client (streaming, verbatim reasoning, request-keyed cache *primitive*
  `src/llm/cache.ts`) + conversation tree/wire + Session/SessionManager + `chat` REPL. Truncation
  (D-30) + circuit breaker (D-32).
- **P3a** sandbox + native tools (read/write/delete/list/glob/grep + run_command) + tool loop.
- **P3b** mode∩approval gate + pause→approve/deny/**edit** + `ask_user`; **soft fence** (D-19):
  out-of-fence access prompts allow-once / remember-root (persisted `folderRoots`) / deny.
- **P4 (in progress):** `AppendLog` (D-37 — single serialized async queue per file, no locks) +
  `ConversationStore` (append-only JSONL per conversation, injectable dir) + Session emits `entry`
  events + resume from a loaded conversation. **Wired into the dev server:** `/chat` resumes via
  `conversationId`, `GET /conversations?dir=` history, `GET /conversation/:id` from disk; store
  flushed on `/shutdown`; `/chat`, `/approve`, `/answer` **flush before responding**
  (read-your-writes). **Live-validated cross-process restart-resume** (two server processes,
  shared data dir, isolated from real history). **Still to do in P4:** fork/rewind navigation; the
  separate debug journal.
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
continue at the next unchecked phase below.

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

## Phase 4 — Persistence, resume, fork/rewind
**Goal:** conversations survive and branch.
- Conversation store: flat JSON per conversation + `index.json`; **debug journal** (D-13, D-15).
- Persist + resume; history filtered by working dir with show-all (D-09).
- Fork (sibling branch) / rewind (move `activeLeaf`) navigation (D-10, D-17).
- **Done when:** restart resumes a conversation; you can fork/rewind and navigate branches.

## Phase 5 — HTTP frontend
**Goal:** the real product — a browser you talk to.
- Hono server; **SSE down / POST up** event bus (D-18); configurable port.
- Chat view: markdown + **Mermaid** + inline images (D-11-era §11); approval UI with **edit**;
  `ask_user` buttons/multi-question forms; mode/approval controls; branch arrows; **TTS button**.
- **Cost & control (D-33, D-34):** live **whole-tree spend** in a corner + settable **cap**;
  **queued message** (applies between turns); **background-task list with per-task kill**;
  **global stop button**.
- **Concurrent sessions (D-36):** the "bag of agents" UI — hold/switch multiple live sessions in
  the same folder, each with its own status/spend/controls (shared-folder, worktrees deferred).
- **Auth** (P-01): localhost-by-default bind, hashed password, one-time setup token, session cookie.
- **Done when:** you drive JLCode from a browser with full markdown, approvals, forking, login,
  live spend + cap, queued messages, and stop/kill controls.

## Phase 6 — Compaction
**Goal:** long conversations stay in-window and Fable-safe.
- Token accounting from model metadata; trigger modes (auto / manual / suggest / cancelable /
  hard-forced) (D-27).
- Checkpoint-overlay compaction; **full-summarize safe-harbor (the v1 regime, D-38)**; anchored
  evolving summary + **bookend quoting**; **cache-reuse fast path** (same-model) + cross-model
  fallback (D-28, D-29).
- LLM-as-judge test helper; tests that normal replay round-trips reasoning (D-14) and a
  safe-harbor compaction produces a Fable-valid request.
- **Done when:** conversations compact automatically/optionally without breaking Fable.
- *(Fast-follow, post-v1: partial-keep-lite #2 for higher recent-context fidelity — D-38.)*

## Later (post-v1; see DECISIONS "Deferred" X-01…X-08)
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
- **M4 — "Fable-proof at scale":** Phase 6 (compaction, O-02 resolved).
