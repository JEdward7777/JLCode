# JLCode — Architecture

> ⚠️ **UNREVIEWED PROPOSAL — not agreed.** Everything below was drafted by Claude
> as a *starting point for discussion*, not decided with Joshua. Each choice here
> is an open question to work through together. Do not treat as settled.

Status: **proposal, pending review** (2026-07-22). Describes a *candidate* for how
the spec ([`SPEC.md`](SPEC.md)) could be realized. Material choices move to
[`DECISIONS.md`](DECISIONS.md) only once agreed.

---

## 1. Runtime & stack

- **Node.js + TypeScript.** Chosen for the eventual VS Code plugin path (extensions
  are Node/TS), strong OpenAI/OpenRouter + MCP SDKs, and type-safe tool schemas.
- **OpenRouter** via the OpenAI-compatible API (OpenAI Node SDK pointed at the
  OpenRouter base URL). Tool calling uses the OpenAI function-calling protocol.
- HTTP layer kept **thin** over the core; exact framework TBD (lightweight, e.g.
  Fastify/Hono-class). Token streaming to the browser via SSE (revisit WebSocket if
  bidirectional needs grow). — *tentative, see DECISIONS D-09.*

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
- **ask_followup:** pauses the loop, emits an ask-user event, resumes on the answer.
- **MCP client (later):** generic; the sandbox validates path-bearing arguments
  *before* forwarding, so `file_utils` and others stay fenced even though they don't
  self-enforce.

Tool schemas are defined once in TypeScript and rendered to the OpenAI function format.

## 6. Sandbox / workspace fence

- A single resolver maps every tool-supplied path to an absolute real path and rejects
  anything outside the active workspace root (the launch directory by default; explicitly
  wideable). Resolves symlinks; blocks `..` escapes. One enforcement point for native
  tools and (later) MCP forwarding.

## 7. Persistence & stores

Two OS-level locations, both overridable by env, both outside the project:

- **Config store** — `${JLCODE_CONFIG_DIR:-$XDG_CONFIG_HOME/jlcode (\~/.config/jlcode)}`.
  Holds `config.json`: model configurations (incl. keys, chmod 600-style perms),
  per-directory last-used bindings, the Auto-safe allowlist, global prefs.
- **Data store** — `${JLCODE_DATA_DIR:-$XDG_DATA_HOME/jlcode (\~/.local/share/jlcode)}`.
  Holds conversations (one record per conversation; indexed by working directory for the
  history filter) and the **diagnostic log** (rotating, stack traces).

Windows/macOS: use the platform config/data dirs; `JLCODE_CONFIG_DIR` / `JLCODE_DATA_DIR`
override everywhere (Docker sets these explicitly).

### Conversation record (sketch)

```jsonc
{
  "id": "…",
  "workingDir": "/work/clientA",     // drives the history filter
  "configName": "Client A — Opus",
  "mode": "code",
  "approvalPolicy": "auto-safe",
  "messages": [ /* full transcript, incl. reasoning blocks + tool calls/results */ ],
  "summary": "…",                     // running compaction summary (§8)
  "createdAt": "…", "updatedAt": "…"
}
```

## 8. Compaction

- Token accounting per config (budget = fraction of the model's context window).
- On threshold: fold older turns into `summary`, keep recent turns verbatim, keep
  tool-call/result pairs intact, honor provider reasoning rules (don't strip redacted
  reasoning where forbidden).
- The **persisted transcript keeps the pre-compaction messages** even when the live
  request uses the summary — history is lossless; only the sent context is compacted.
- Compaction events are emitted to the frontend and recorded.

## 9. Diagnostics

- Central logger writes structured errors + **full stack traces** to the rotating
  diagnostic log in the data store, independent of conversation transcripts. Log level
  configurable.

## 10. Config selection flow

1. On launch, read config store; look up the current working directory in the
   per-directory bindings → preselect that config.
2. Present the **filter-searchable** picker (type to narrow; confirm client + model).
   New config can **clone** an existing one.
3. On selection, update the working-directory binding.

---

## Naming

- Working name **JLCode**; CLI/package name tentatively `jlcode`. (DECISIONS D-10.)
