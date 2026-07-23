# JLCode — Architecture

> ✅ **Reviewed & agreed** (2026-07-22) — the load-bearing choices here were worked
> through with Joshua and are logged in [`DECISIONS.md`](DECISIONS.md) (D-13…D-22).
> One item is intentionally deferred to build time: **O-02** (compaction specifics +
> the Fable×compaction boundary), which is empirical rather than answerable on paper.

Status: **agreed** (2026-07-22). Describes how the spec ([`SPEC.md`](SPEC.md)) is
realized. Changes from here should update [`DECISIONS.md`](DECISIONS.md) deliberately.

---

## 1. Runtime & stack

- **Node.js + TypeScript.** Chosen for the eventual VS Code plugin path (extensions
  are Node/TS), strong ecosystem + MCP SDK, and type-safe tool schemas.
- **OpenRouter** via the OpenAI-compatible API using a **thin custom fetch client (D-21)** —
  we own the exact request/response JSON so the opaque `reasoning_details` round-trips verbatim
  (D-14). Tool calling uses the OpenAI function-calling protocol.
- HTTP layer kept **thin** over the core, on **Hono (D-20)** — TS-first, clean SSE, and portable
  to the Cloudflare edge for the future proxy (§18).
- **Packaging (D-22):** published as `jlcode` with a `bin` entry so `npx jlcode` runs without a
  global install (the JS analogue of `file_utils`' `uvx`).
- **Transport = SSE (down) + POST (up) — AGREED (D-18).** Server streams events to the
  browser over SSE (reconnect/resume via Last-Event-ID); the browser sends discrete actions
  as POSTs. This is the concrete wiring of the event bus (§2) for the HTTP frontend.

## 2. Layering (transport-agnostic core)

```
┌────────────────────────────────────────────────────────────┐
│ Frontends            HTTP server (v1)   [curses, VS Code — later] │
├────────────────────────────────────────────────────────────┤
│ Event bus            structured events in/out (no UI assumptions)  │
├────────────────────────────────────────────────────────────┤
│ Core                 agent loop · mode+approval gate · compaction  │
│                      · conversation state · ask-user                │
├────────────────────────────────────────────────────────────┤
│ Providers/services   OpenRouter client · tool registry             │
│                      · config store · conversation store · logger   │
├────────────────────────────────────────────────────────────┤
│ Tools                native file tools (sandboxed) · shell          │
│                      · ask_followup · [MCP client — later]          │
└────────────────────────────────────────────────────────────┘
```

The **core never imports a frontend**. Frontends subscribe to the event bus and send
user input/approvals back through it. This is the seam that makes curses / VS Code
webview additive.

## 3. Agent loop

1. Assemble request: system prompt (+ config addendum) + (possibly compacted) history + tool schemas.
2. Call OpenRouter (streaming). Emit token/reasoning/tool-call events.
3. On tool calls: for each, run through the **capability + approval gate** (§5), execute,
   emit results, append tool results to history.
4. Repeat until the model yields a final answer or calls `ask_followup`.
5. Persist after each turn (§7).

Reasoning/thinking blocks are captured and **replayed back to the provider on the next
turn** per the model's rules (never stripping redacted reasoning where forbidden, e.g. Fable).

## 4. Modes & approval — enforcement matrix

Effective permission = **mode capability ∩ approval policy**. Enforced in one gate the
loop calls before any side-effecting tool runs.

- **Mode** decides *is this tool even allowed?* (Ask/Plan/Code per SPEC §5).
- **Approval policy** decides *does it need confirmation / is it blocked?* (SPEC §6).
- Example: Plan + Full-auto still cannot run `npm test` (mode forbids); it *can*
  auto-run `git commit` of the plan. Code + Manual runs anything but prompts each time.
  Any mode + Read-only executes nothing.

Plan mode's git allowlist is a small fixed set (`git add`, `git commit`, and read-only
`git status`/`git diff`/`git log`), not the general Auto-safe allowlist.

## 5. Tools

- **Native file tools:** `read_file`, `write_file`, `create_file`, `delete_file`,
  `rename`, `list_dir`, `glob`, `grep`. All paths pass through the **sandbox** (§6).
- **Shell:** `run_command`, local execution, gated by §4.
- **ask_user (D-18):** pauses the loop and emits an awaiting-input event. Two shapes — a
  prose question waits on the text box; a structured call (questions, options, multiSelect,
  optional free-text) renders buttons/fields. Resumes when the POSTed answer returns as the
  tool result. Approvals reuse this awaiting-input machinery with an approve/deny/edit form.
- **MCP client (later):** generic; the sandbox validates path-bearing arguments
  *before* forwarding, so `file_utils` and others stay fenced even though they don't
  self-enforce.

Tool schemas are defined once in TypeScript and rendered to the OpenAI function format.

## 6. Sandbox / workspace fence

**AGREED (D-19).** A single resolver maps every tool-supplied path to its real absolute path
(symlinks followed), blocks `..` escapes, and requires the resolved path to sit inside an
**allowed root**. Allowed roots = the **launch directory** (default) + any pre-declared roots
(per-directory persisted state / model config / launch flag).

- **Out-of-fence access → approval prompt** (reuses the awaiting-input machinery, §5), offering
  **allow once / allow + persist as a new authorized root for this launch dir / deny**. The
  prompt proposes the accessed path's containing directory as the root, adjustable before saving;
  persisted roots are stored per-directory in the config store (alongside the folder→config
  binding, §7).
- One enforcement point for native tools and (later) MCP forwarding — the path is validated
  before it reaches any tool or is forwarded to any MCP server.

## 7. Persistence & stores — **AGREED (D-13, D-15, D-17)**

Two OS-level locations, both overridable by env, both outside the project:

- **Config store** — `${JLCODE_CONFIG_DIR:-$XDG_CONFIG_HOME/jlcode (\~/.config/jlcode)}`.
  A single hand-editable `config.json`: model configurations (incl. keys, restrictive perms),
  per-directory last-used bindings, the Auto-safe allowlist, global prefs.
- **Data store** — `${JLCODE_DATA_DIR:-$XDG_DATA_HOME/jlcode (\~/.local/share/jlcode)}`:
  - `conversations/` — one **flat JSON file per conversation** + `index.json` (working-dir → convo ids for the history filter).
  - `logs/` — the rotating **diagnostic log** and the append-only **debug journal** (§9).

Windows/macOS: use the platform config/data dirs; `JLCODE_CONFIG_DIR` / `JLCODE_DATA_DIR`
override everywhere (Docker sets these explicitly). SQLite is the noted upgrade path if
multi-instance concurrency or search ever demand it.

### Conversation record — append-only parent-pointer tree (D-15, D-17)

One file per conversation. `entries` is **append-only**; each entry has a stable generated
`id` and a `parent` id. A *branch* is the chain you get tracing `parent` from a leaf upward;
`activeLeaf` restores the viewed branch on resume. Fork = append a sibling off a parent
(the pencil-edit of a user message does exactly this); rewind = move `activeLeaf` up.

```jsonc
{
  "id": "cv_…",
  "workingDir": "/work/clientA",       // drives the history filter
  "configName": "Client A — Opus",
  "activeLeaf": "e_57",                 // tip of the branch currently in view
  "createdAt": "…", "updatedAt": "…",
  "entries": [                          // append-only; never rewritten in place
    { "id": "e_00", "parent": null,  "role": "user", "content": "Do X" },
    { "id": "e_01", "parent": "e_00","role": "assistant", "content": "…",
      "toolCalls": [ … ], "reasoning": { /* opaque reasoning_details, verbatim (D-14) */ },
      "mode": "code", "tokens": 1234 },
    { "id": "e_02", "parent": "e_01","role": "tool", "toolCallId": "…",
      "content": "…", "edited": { "ran": "python3 foo.py", "was": "python foo.py" } }, // D-16
    { "id": "e_57", "parent": "e_50","kind": "compaction",
      "replayCut": true, "summary": "…covers e_00..e_50…" }                            // D-15
  ]
}
```

Wire assembly: start at `activeLeaf`, climb `parent` links; on a `replayCut` compaction
entry inject its `summary` and stop; map the collected path → OpenAI messages, replaying
each assistant entry's `reasoning` verbatim. The **debug journal** is written in parallel and
never read back into a request.

## 8. Compaction — **AGREED (D-15)**

- Token accounting per config (budget = fraction of the model's context window).
- On threshold: append a **checkpoint (`replayCut`) entry** whose `summary` covers everything
  up to it. Sent context = `summary + entries after the checkpoint`; the full tree is retained.
- **Reasoning × compaction (O-02, open):** proposed safe default — keep recent assistant
  entries verbatim with reasoning (never compact across an in-progress tool cycle); only older
  completed entries fall above the cut and are summarized. To be verified against Fable empirically.
- Agent-directed minimize/expand (X-08) reuses the same non-destructive overlay, later.
- Compaction/minimize events are emitted to the frontend and recorded.

## 9. Diagnostics — **AGREED (D-11, D-15)**

- **Diagnostic log:** central logger writes structured errors + **full stack traces** to a
  rotating log in `logs/`, independent of conversation transcripts. Log level configurable.
- **Debug journal:** append-only, per-turn raw record (OpenRouter request/response, reasoning
  text, tool I/O, tokens, timings, mode/approval changes, command edits). Verbose by design and
  never replayed to a model — the "Halp!! something broke" artifact.

## 10. Config selection flow

1. On launch, read config store; look up the current working directory in the
   per-directory bindings → preselect that config.
2. Present the **filter-searchable** picker (type to narrow; confirm client + model).
   New config can **clone** an existing one.
3. On selection, update the working-directory binding.

---

## Naming

- Working name **JLCode**; CLI/package name **`jlcode`**, npx-compatible (D-22).
