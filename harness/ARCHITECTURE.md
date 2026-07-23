# JLCode — Architecture

> ✅ **Reviewed & agreed** — the load-bearing choices here were worked through with
> Joshua and are logged in [`DECISIONS.md`](DECISIONS.md) (D-13…D-38). **No open
> architecture questions remain** (O-02 resolved by design → D-38: v1 compaction uses
> the full-summarize safe-harbor; the Fable-risky regime is retired).

Status: **agreed**. Describes how the spec ([`SPEC.md`](SPEC.md)) is realized.
Changes from here should update [`DECISIONS.md`](DECISIONS.md) deliberately.

---

## 1. Runtime & stack

- **Node.js + TypeScript.** Chosen for the eventual VS Code plugin path (extensions
  are Node/TS), strong ecosystem + MCP SDK, and type-safe tool schemas.
- **OpenRouter** via the OpenAI-compatible API using a **thin custom fetch client (D-21)** —
  we own the exact request/response JSON so the opaque `reasoning_details` round-trips verbatim
  (D-14). Tool calling uses the OpenAI function-calling protocol. The client also supports
  **provider-side prompt caching (D-26)**: it places `cache_control` breakpoints (after the
  stable system+tools block and at a rolling history point) and surfaces reported cache usage.
  The append-only transcript keeps the cached prefix byte-stable, so caches hit; compaction/fork
  are the natural invalidation points. *(This is the provider input-token cache — distinct from
  the local content-addressed response cache, D-24.)*
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
  - `conversations/` — one **append-only JSONL log per conversation** (D-37) + `index.json`
    (working-dir → convo ids for the history filter). Plus a per-conversation **debug journal**.
  - `logs/` — the rotating app-global **diagnostic log** (§9).

Windows/macOS: use the platform config/data dirs; `JLCODE_CONFIG_DIR` / `JLCODE_DATA_DIR`
override everywhere (Docker sets these explicitly). SQLite is the noted upgrade path if
multi-instance concurrency or search ever demand it.

**Testability (D-23):** the conversation/journal store takes an **injectable data dir** (never a
hardcoded global), so tests point it at a temp dir and then inspect what landed — no polluting
real history. An **ephemeral / no-persist mode** skips writing entirely for runs that shouldn't
record. (This is how test runs "relocate the logs" and self-evaluate the result.)

### Persistence: event stream → projections (D-37)

Each session has **one ordered event stream** (the same events the bus §11 carries). The
**canonical transcript** and the **debug journal** are two **projections** of it, both written
through a shared **`AppendLog`** primitive: append-only **JSONL**, `fsync` on *finalized* units
(a completed turn / tool result — not per token), torn-tail tolerant on read (a crash-truncated
last line fails to parse and is dropped). The transcript log is **folded** into the tree below on
load.

**Coherence = one in-process serialization point per file, not OS file locks (D-37, D-36).**
`AppendLog` is a **singleton per file path** (via a small registry) with a **single serialized
async append queue**: every `append(record)` awaits the previous write (then the fsync policy),
so records can never interleave — even when **multiple agent loops append to the same file**.
Because Node is single-threaded, this is the only synchronization needed; there are no advisory
locks. `append()` resolves when *that* record is durably written, so callers can await coherent
persistence. Per-conversation files usually have one appender, but nothing *requires* it — a
shared file (the app-global **diagnostic log** today; an orchestration parent's file later, §27)
stays coherent purely through its shared `AppendLog`. This is the anti-entropy invariant realized.

### Conversation record — append-only parent-pointer tree (D-15, D-17)

Conceptually one record per conversation, materialized as the append-only JSONL log above and
folded on load. **Tree structure comes solely from `parent` pointers, never from file/append
order** — so concurrently-appended, *interleaved* branches re-read correctly and never merge;
fold is index-then-link (order-independent). Ids are **generated random (not content-hashed)**,
so two nodes with identical text stay distinct (the opposite of git's dedupe). **These generated
ids never go on the wire** — only role/content/tool_calls/`tool_call_id`/reasoning reach the model
(and the cache key, D-24); the only wire ids are provider-issued `tool_call_id`s (fixed once
recorded). So ids stay free to be random without breaking zero-cost test replay. *(Guard: never
put a generated id into a wire message.)* `entries` is **append-only**; each entry has a stable
generated `id` and a
`parent` id. A *branch* is the chain you get tracing `parent` from a leaf upward; `activeLeaf`
restores the viewed branch on resume. Fork = append a sibling off a parent (the pencil-edit of a
user message does exactly this); rewind = append an `activeLeaf` change. The JSON below is the
*folded* view; on disk it is the sequence of appended records.

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
- **Reasoning × compaction (D-38):** v1 uses the **full-summarize safe-harbor** — no signed
  thinking crosses a compaction, so it's Fable-safe by construction. Keeping recent entries
  verbatim (partial-keep-lite) is the deferred fidelity fast-follow. The perfect-or-gone rules
  apply to *normal* replay (D-14).
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
