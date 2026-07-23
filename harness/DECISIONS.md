# JLCode — Decision Log

Records decisions and their rationale. **Agreed** = decided with Joshua.
**Proposed** = Claude's suggestion, awaiting Joshua. **Open** = not yet resolved.
Spec references point at [`SPEC.md`](SPEC.md).

---

## Agreed

| # | Decision | Why | Ref |
|---|----------|-----|-----|
| D-01 | Runtime: **Node.js + TypeScript** | Path to a future VS Code plugin; strong OpenRouter/OpenAI + MCP SDKs; type-safe tool schemas | SPEC §2 |
| D-02 | Primary interface v1: **HTTP** (browser + markdown), built over a **transport-agnostic core** (curses seam kept, not built) | Docker port concerns, future remote + VS Code webview fold-in; Joshua chose "http for now" with the abstraction seam | SPEC §11 |
| D-03 | File access: **native tools + workspace sandbox** as v1 primary; `file_utils` MCP **deferred**, pluggable later | `file_utils` is a surgical-edit specialist — no list/glob/grep/whole-read/create-delete and no sandbox | SPEC §9 |
| D-04 | Shell execution runs **locally in the agent**, gated by mode + approval | Keep it out of the shared `file_utils` server, which is happy without it | SPEC §10 |
| D-05 | **Named model configurations** in an OS-level store: per-client key + model + reasoning/thinking controls + sampling params + default mode/approval + **system-prompt addendum**; filter-search + clone | Per-client key isolation; KiloCode-style selection; central maintainability | SPEC §4 |
| D-06 | **Folder-aware**: last-used config and history filter keyed off the working directory; settings never written into the project folder | Client A's key/model auto-picks per project without polluting the repo | SPEC §7, §8 |
| D-07 | **Three modes, no auto-switch**: Ask (read-only), Plan (`.md` writes + fixed git-commit allowlist), Code (all) | Explicit control; Plan can commit its plan without general shell access | SPEC §5 |
| D-08 | **Approval policies**: Manual, Auto-safe (allowlist), Full-auto, Read-only. Compose with modes as an intersection | Flexible safety per context | SPEC §6 |
| D-09 | **Persist + resume** conversations; history **filtered by working directory** with a show-all escape hatch | Projects don't pollute each other; recover when a project moves | SPEC §8 |
| D-10 | **Fork preferred, rewind fallback** for going back to an earlier point | Fork keeps the original; rewind is the simpler fallback if branching is hard | SPEC §8 |
| D-11 | **Rotating diagnostic log** (stack traces), separate from conversation history | Cheap post-mortem when things go sideways | SPEC §14 |
| D-12 | **Compaction is required**; honor provider reasoning rules (don't strip redacted/Fable reasoning) | Stay in-window without losing the thread or breaking Fable | SPEC §15 |
| D-13 | **Two stores** — config (`~/.config/jlcode`, `JLCODE_CONFIG_DIR`) vs data (`~/.local/share/jlcode`, `JLCODE_DATA_DIR`), XDG defaults, env-overridable. **Config** = single hand-editable `config.json` (model configs w/ keys, folder bindings, allowlist). **Data** = `conversations/` + `logs/`. **Conversations = flat JSON files, one per conversation, + `index.json` (working-dir → convo ids)**. *(Fork/rewind mechanism superseded by D-15: the file holds a node tree, not a linear array.)* | Config is small/secret/precious (tight perms, easy backup); data is bulky/churny; flat JSON is simple, inspectable, dependency-free. SQLite noted as the upgrade path if multi-instance concurrency or search demand it | was O-04 |
| D-14 | **Reasoning/thinking = verbatim & opaque.** Attach the provider's raw `reasoning_details` to the assistant turn as opaque data, never interpreted, always replayed unchanged. UI surfaces the human-readable reasoning text separately | Provider rules keep changing (Fable requires replaying redacted/encrypted blocks); never parsing it means rule churn never touches our code. This is the failure mode motivating the rebuild | was O-03; SPEC §4, §15 |
| D-15 | **Conversation model:** (a) **two structures** — a *canonical wire-format-superset transcript* (API-safe, verbatim reasoning, drives replay + UI + fork) and a *separate append-only debug journal* (raw request/response, reasoning text, tool I/O, tokens, timings, errors — the "Halp!" record); (b) the transcript is a **ChatGPT-style node tree with an active-path pointer** — fork = sibling branch, rewind = move pointer up, old branches retained/navigable; (c) **compaction = lossless overlay** — a checkpoint node holds a summary of everything up to it; sent context = `summary + items after checkpoint`; full tree preserved | Keeps the replayed thing API-safe while still capturing everything needed to debug; matches Joshua's fork/side-conversation UX; honors SPEC §15's lossless promise | was O-06; SPEC §8, §14, §15 |
| D-16 | **Editable-before-approval.** A pending command/write can be edited before the user approves it. The **assistant turn stays verbatim** (D-14); the **edited** version executes; the **tool result** records the edit + what actually ran; the debug journal keeps both | Closes a KiloCode gap (fix `python`→`python3` inline) without mutating the assistant message, so reasoning replay stays Fable-safe; agent still learns the correction via the result | SPEC §6 |
| D-19 | **Sandbox = hard fence (read + write) to the launch dir + pre-declared allowed-roots.** Paths resolved to realpath (symlinks followed), `..` blocked, resolved path must sit inside an allowed root. **Out-of-fence read/write triggers an approval prompt** (awaiting-input machinery) offering: **allow once / allow + persist as a new authorized root for this launch dir / deny**. Persisted roots live in the config store's per-directory state (alongside the folder→config binding, D-06/D-13); the prompt proposes the accessed path's containing directory as the root, adjustable before saving. One enforcement point for native tools and (later) MCP forwarding | Delivers per-client isolation (Client A can't read/write Client B) while staying practical; approve-and-remember mirrors the folder-keyed config model so widening is deliberate and auditable | was O-05; SPEC §9 |
| D-18 | **Transport = SSE (down) + POST (up).** Server streams events (tokens, reasoning, tool events, awaiting-input) over SSE with reconnect/resume (Last-Event-ID); browser sends discrete actions (send, approve/deny/edit, answer, switch branch, change mode) as POSTs. **Ask-user = both:** a prose question waits on the text box; a dedicated **`ask_user` tool** with a structured form spec (questions, options, multiSelect, optional free-text) renders buttons/fields and returns via the tool result. Approvals reuse the same awaiting-input machinery (with an approve/deny/edit form) | Matches the traffic shape (stream down, occasional actions up); SSE is proxy/Cloudflare-friendly for the future remote case with less plumbing than WS; the tool gives the button UX Joshua wanted while keeping simple questions natural | was O-01; SPEC §11, §13 |
| D-17 | **Conversation-tree schema = append-only parent-pointer log.** Entries only append at the bottom; each has a stable **generated id** and a **`parent` id** (may skip intervening entries → that's a branch). A branch = trace `parent` from a leaf upward. A persisted **`activeLeaf`** restores the viewed branch on resume; appends set it. Sibling arrows = entries sharing a `parent`. A **compaction entry** has `replayCut` + summary: wire-assembly climbs from `activeLeaf`, injects the summary and stops when it hits one. **Pencil-edit of a user message = a fork** (appends a sibling off the same parent) | Append-only is crash-safe and trivial to write; fork/rewind/compaction collapse into one mechanic; generated ids survive future pruning/migration | Joshua's design; SPEC §8, §15 |
| D-20 | HTTP framework = **Hono** | Tiny, TS-first, clean SSE; runs on Node now and Cloudflare edge — aligns with the future proxy (§18) | was O-07 |
| D-21 | OpenRouter access = **thin custom fetch client** (not the OpenAI SDK) | We own the exact wire JSON, guaranteeing `reasoning_details` round-trips verbatim (D-14) and letting us adapt when OpenRouter adds fields; no SDK reshaping | was O-08 |
| D-22 | CLI/package name = **`jlcode`**, **npx-compatible** (published package with a `bin` entry; `npx jlcode` runs without a global install, mirroring `file_utils`' `uvx`) | Short and unambiguous; zero-install run matches Joshua's workflow | was O-09 |

## Deferred (non-goals for v1; keep possible)

| # | Item | Note | Ref |
|---|------|------|-----|
| X-01 | MCP client | Reuse KiloCode's `mcp_settings.json` snippet format so configs port over verbatim | SPEC §3, §9 |
| X-02 | LLM-judged "auto" approval | A model call decides if a command is safe | SPEC §6 |
| X-03 | Curses frontend | Core built transport-agnostic so it's additive | SPEC §3, §11 |
| X-04 | VS Code plugin (webview) | HTTP-first + embeddable bare chat view keep this open | SPEC §3, §11 |
| X-05 | Remote control / fleet view proxy | Needs stable instance identity + "awaiting input" status | SPEC §18 |
| X-06 | Browser-driven app testing | Playwright/Puppeteer (not jsdom); maybe just CLI | SPEC §17 |
| X-07 | File viewer + upload/download chrome | Redundant inside VS Code; wraps the standalone chat view | SPEC §11 |
| X-08 | Agent-directed minimize/expand (collapsible context items) | Non-destructive, same overlay principle as compaction; ship after the core loop is proven | SPEC §15 |

## Proposed (Claude's recommendation, pending Joshua)

| # | Topic | Recommendation | Ref |
|---|-------|----------------|-----|
| P-01 | Auth | Localhost-by-default bind + **hashed** password in config store + one-time printed setup token + httpOnly session cookie + TLS for remote | SPEC §20 |
| P-02 | Attention notifications | **External push service** (ntfy/Pushover/Telegram), no PWA, triggered by the "awaiting input" state | SPEC §19 |

## Open (architecture — to work through together)

Everything in [`ARCHITECTURE.md`](ARCHITECTURE.md) is an **unreviewed proposal**. The
load-bearing open decisions:

| # | Question |
|---|----------|
| O-02 | Compaction specifics: summary prompt, keep-recent-verbatim cutoff, token accounting, **and the Fable×compaction boundary experiment** (proposed safe default in D-15/§15: keep recent turns' reasoning verbatim, summarize only older completed turns). **Intentionally deferred** to build time — empirical, not answerable on paper; not a blocker |

*Resolved: O-04 → D-13; O-03 → D-14; O-06 → D-15; O-01 → D-18; O-05 → D-19; O-07 → D-20; O-08 → D-21; O-09 → D-22.*
*Remaining open: only O-02 (deferred to build time).*
