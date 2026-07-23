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
| O-01 | Streaming transport browser↔server: SSE vs WebSocket |
| O-02 | Compaction strategy specifics (summary prompt, what's pinned, token accounting) |
| O-03 | Reasoning-block capture/replay mechanism across turns (the Fable/redacted problem) |
| O-04 | Store layout: one store or two (config vs data), on-disk format, env override names |
| O-05 | Sandbox model: default fence to launch dir, symlink handling, how to widen |
| O-06 | Conversation record schema (what a persisted conversation contains; supports fork/rewind) |
| O-07 | HTTP framework choice (cosmetic) |
| O-08 | OpenRouter access: OpenAI SDK vs raw fetch (cosmetic) |
| O-09 | CLI / package name (`jlcode`?) (cosmetic) |
