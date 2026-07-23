# JLCode — Roadmap

Status: **proposed build sequence, pending Joshua's approval** (2026-07-22). The
architecture is settled ([`DECISIONS.md`](DECISIONS.md) D-01…D-29; only O-02 deferred). This
lays out *the order we build in*. It's a proposal — adjust freely before we start coding.

Principle: **bottom-up, runnable early.** Each phase leaves something that works and is
testable at the free tiers ([`TESTING.md`](TESTING.md) Tiers 0–1).

---

## Phase 0 — Scaffold & foundations
**Goal:** an installable, testable empty shell.
- TypeScript project; **Vitest**; **Hono** dep; `package.json` with a `bin` so `npx jlcode`
  runs (D-22). Minimal-dep discipline, no native binaries (D-25).
- Config/data dir resolution: `JLCODE_CONFIG_DIR` / `JLCODE_DATA_DIR`, XDG defaults (D-13).
- Diagnostics logger + rotating log location (D-11).
- Tier-0 test setup.
- **Done when:** `npx jlcode` runs, prints version, resolves its dirs; CI runs Tier 0.

## Phase 1 — Config & model selection
**Goal:** pick a client/model to work under.
- `config.json` schema: model configs (name, key, model id, **reasoning effort**, sampling,
  system-prompt addendum, default mode+approval, compaction settings) (D-05, D-27).
- Folder→config binding keyed off cwd (D-06); filter-search picker + clone-from-existing.
- **Done when:** launch → auto-selects last config for this dir (or filter/clone to pick);
  selection persists per directory. Tier-0 tested.

## Phase 2 — OpenRouter client + walking skeleton
**Goal:** actually talk to a model end-to-end (headless).
- Thin fetch client (D-21): tool-calling protocol, streaming, **verbatim `reasoning_details`
  round-trip** (D-14), **prompt-cache breakpoints** (D-26).
- **Request-keyed LLM cache** (D-24) so tests are free after first record.
- Conversation tree in memory (append-only parent-pointer, `activeLeaf`) + wire assembly
  (D-15, D-17). A minimal CLI loop: send a message, stream a reply.
- **Done when:** you can hold a real conversation from the terminal; reasoning round-trips;
  Tier-1 cached tests cover the loop.

## Phase 3 — Tools, sandbox, modes & approval
**Goal:** the agent can do gated work.
- Sandbox path fence + out-of-fence approve/allow-remember/deny (D-19).
- Native file tools (read/write/create/delete/list/glob/grep) (D-03); shell tool (D-04).
- Structured **`ask_user`** tool (D-18).
- Mode capability gate (Ask/Plan/Code) ∩ approval policies; **editable-before-approval** (D-07,
  D-08, D-16).
- **Done when:** the agent edits files & runs commands under the fence, respecting mode +
  approval, with inline command editing. Tier-0/1 tested.

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
- **Auth** (P-01): localhost-by-default bind, hashed password, one-time setup token, session cookie.
- **Done when:** you drive JLCode from a browser with full markdown, approvals, forking, login.

## Phase 6 — Compaction
**Goal:** long conversations stay in-window and Fable-safe.
- Token accounting from model metadata; trigger modes (auto / manual / suggest / cancelable /
  hard-forced) (D-27).
- Checkpoint-overlay compaction; anchored evolving summary + **bookend quoting**; **cache-reuse
  fast path** (same-model) + cross-model fallback (D-28, D-29).
- **Full-summarize safe-harbor**, Fable-conservative default; **perfect-or-gone** replay rule.
- LLM-as-judge test helper; **Tier-3 Fable boundary test** (resolves O-02).
- **Done when:** conversations compact automatically/optionally without breaking Fable; the
  reasoning-survives-compaction test passes cached and live.

## Later (post-v1; see DECISIONS "Deferred" X-01…X-08)
Notifications (external push, P-02) · MCP client (KiloCode `mcp_settings` format) ·
agent-directed minimize/expand (X-08) · remote control / fleet view (§18) · browser-driven
app testing · VS Code webview · response-caching product feature (§21) · file viewer &
upload/download chrome.

---

## Milestones
- **M1 — "Talk to a client":** Phases 0–2 (selected config → real conversation, headless).
- **M2 — "Does real work":** Phase 3 (sandboxed tools under mode/approval).
- **M3 — "Real product":** Phases 4–5 (persistent, forkable, in the browser).
- **M4 — "Fable-proof at scale":** Phase 6 (compaction, O-02 resolved).
