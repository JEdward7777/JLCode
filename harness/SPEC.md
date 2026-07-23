# JLCode — Functional Specification

Status: **living draft** (initial spec captured 2026-07-22). This is the source
of truth for *what* JLCode does. The *how* lives in
[`ARCHITECTURE.md`](ARCHITECTURE.md); the *why* lives in
[`DECISIONS.md`](DECISIONS.md).

---

## 1. Purpose & motivation

JLCode is a self-owned coding agent, built to replace KiloCode for Joshua's use.
Reasons for building rather than continuing on KiloCode:

- **Control of direction** — KiloCode is heading somewhere Joshua doesn't want to follow.
- **Per-client key isolation** — different clients' OpenRouter keys, cleanly separated.
- **Maintainability** — KiloCode is bit-rotting. Model-calling rules keep changing
  (e.g. Anthropic now forbids stripping redacted thinking for Fable). A small,
  bootstrapped codebase is cheaper to keep current than someone else's accumulated layers.

**Design north star:** keep it *simple to maintain*. Prefer a small core with
clear seams over feature breadth.

## 2. Goals (v1)

- A working agentic loop over **OpenRouter** using the **OpenAI tool-calling protocol**.
- **Named model configurations** bundling an OpenRouter key + model + settings, with
  per-client separation, filter-search selection, and clone-from-existing.
- **Folder-aware** selection: the last-used config and the conversation-history filter
  are keyed off the working directory the tool is launched from.
- **Three operating modes** — Ask, Plan, Code — with **no auto-switching**.
- **Command-approval policies** — Manual, Auto-safe (allowlist), Full-auto, Read-only.
- **Native file tools** with a workspace sandbox/fence.
- **Local shell execution** gated by mode + approval policy.
- **Persist + resume** conversations, filtered by working directory.
- An **HTTP interface** (browser, full markdown) over a **transport-agnostic core**.
- A **diagnostic error log** (stack traces) separate from conversation history.
- The model can **stop and ask the user a question** mid-task.

## 3. Non-goals (v1) — deferred, see ROADMAP

- MCP client support (native file access covers v1; MCP comes later, reusing
  KiloCode's `mcp_settings.json` snippet format so configs port over verbatim).
- LLM-judged "auto" approval mode (a separate model call that decides if a command is safe).
- A terminal (curses) frontend — the core is built transport-agnostic so it can be
  added, but only the HTTP frontend ships in v1.
- Packaging as a VS Code plugin (HTTP-first keeps this path open via a webview).
- Custom user-defined modes beyond Ask/Plan/Code.
- **Remote control / fleet view** (see §18) — not built now, but must not be designed out.

## 4. Model configurations

A **model configuration** is a named bundle a user selects to work under. Example
display name: `Client A — Opus`.

Each configuration carries:

| Field | Notes |
|-------|-------|
| Display name | e.g. `Client A — Opus`; what the picker shows and filters on. |
| OpenRouter API key | The per-client secret. Stored in the OS-level config store, never in the project. |
| Model id | The OpenRouter model slug. |
| Reasoning / thinking controls | Reasoning effort / thinking budget, **plus correct round-trip handling of reasoning blocks** across turns — including preserving redacted / Fable reasoning as OpenRouter now requires. |
| Sampling params | temperature, top_p, max_tokens. |
| Default mode + approval policy | The mode (Ask/Plan/Code) and approval policy this config starts in. |
| System-prompt addendum | Text **appended** to the base system prompt (not a full override), e.g. "use `python3` instead of `python`". |
| Compaction settings (§15) | **Compaction model** (default = the working model; overridable to a cheaper one, with the compactor-fit guard); **auto** on/off; **headroom buffer** (default ~20K tokens); **keep-recent tokens** (default ~8K verbatim); **trigger modes**. Budget is derived from the model's `context_length` (from OpenRouter metadata). |

Configuration UX:

- **Filter-search** the config list by typing (KiloCode-style): type `Opus` to narrow,
  then confirm the right client.
- **Clone** an existing configuration when creating a new one.
- Configurations live in the **OS-level config store** (§7), locatable from any launch
  directory; they are **never** written into the project folder.

## 5. Operating modes

Three fixed modes define *what the agent is allowed to do* (capability). The user
switches modes explicitly — **the agent never auto-switches.**

| Mode | Read / list / grep | Write files | Shell commands |
|------|:--:|--|--|
| **Ask** | ✅ | ❌ | ❌ (read-only) |
| **Plan** | ✅ | ✅ **`.md` files only** (the plan) | ❌ except a fixed **git allowlist**: `git add`, `git commit` (to commit plan docs) + read-only `git status` / `git diff` / `git log` |
| **Code** | ✅ | ✅ any | ✅ any (subject to approval policy) |

Modes compose with approval policies (§6): effective permission is the
**intersection** of what the mode allows and what the approval policy allows.

## 6. Approval policies

Orthogonal to modes; governs *whether an allowed side-effecting action needs
confirmation before it runs*.

| Policy | Behavior |
|--------|----------|
| **Manual** | Every shell command (and file write) pauses for explicit approval. |
| **Auto-safe (allowlist)** | Commands matching a user-curated allowlist run automatically; anything else prompts. |
| **Full-auto** | Everything the mode allows runs without prompting. Still logged. |
| **Read-only** | Hard safety override: no writes or commands execute at all, regardless of mode. |

**Editable before approval (agreed, D-16).** When a command (or file write) is waiting on a
Manual/allowlist approval, the user can **edit it before approving** — e.g. fix a forgotten
`python` → `python3`. Fable-safe representation: the **assistant turn stays verbatim** (never
rewritten, per D-14); the **edited command is what executes**; and the **tool result** records
that the user edited it and what actually ran, so the agent learns of the correction through the
result channel. The **debug journal** (§14) keeps both the original and edited command. This
is a KiloCode gap Joshua specifically wants closed.

Deferred (ROADMAP): an **LLM-judged auto** policy that calls a model (possibly a
cheaper/different one) to decide whether a command is safe.

## 7. Configuration & state store (OS-level)

A single JSON structure in an OS-level location, findable no matter where JLCode
is launched (override via `JLCODE_CONFIG_DIR`; default XDG — see ARCHITECTURE).
It holds:

- All **model configurations** (including keys).
- **Per-directory bindings**: which config was last used in each working directory
  (auto-selected on next launch there; still overridable).
- The **command allowlist** for Auto-safe.
- Global preferences.

Nothing project-specific is written into the project folder.

## 8. Conversations: persistence & history

- Conversations **persist to disk and can be resumed** after a restart (history +
  mode/approval/config state).
- The history list is **filtered to the current working directory** by default (so
  projects don't pollute each other), with a **"show all"** escape hatch (useful when
  a project moves or something goes weird).
- **Fork / rewind (agreed, D-15):** a conversation is a **ChatGPT-style node tree** with an
  **active-path pointer**. Going back to an earlier node and continuing creates a **sibling
  branch**; **rewind** just moves the active pointer up. Old branches are **retained and
  navigable** (e.g. `‹ 2/3 ›` arrows at a branch point). Use case: a side conversation you
  then rewind past to keep it out of context, while the branch stays available above.
- **UI affordance:** a **pencil** on a message you wrote. Editing it *is* a fork — the edited
  message appends as a sibling branch off the same parent, the original stays as the other
  sibling. "Edit my message" and "fork" are the same operation.

## 9. File access

- **Native file tools** are the v1 primary: read, write, create, delete, rename,
  list, glob, grep — all behind a **single workspace sandbox/fence** (agreed, D-19):
  hard fence (read + write) to the launch dir + pre-declared allowed roots; symlink-safe,
  `..` blocked. **Out-of-fence access prompts** you to *allow once / allow + remember this
  root for this workspace / deny* — delivering per-client isolation without dead-ends.
- The `../file_utils` MCP server is a **specialist** (anchor-based surgical edits of
  large / mojibake-prone files) and lacks listing/glob/grep/whole-file-read/create-delete
  and any sandbox. It is **not** the v1 file layer. When MCP lands (ROADMAP), it plugs
  in as a power tool; the sandbox is enforced by validating path arguments **before**
  forwarding to any MCP server.

## 10. Shell execution

- Runs **locally inside JLCode** (not pushed into the shared `file_utils` server, which
  is happy without it).
- Gated by mode (§5) and approval policy (§6).

## 11. Interface

- **v1: HTTP** — launch a server on a configurable port; connect a browser for full
  markdown rendering, diffs, and approval controls.
- Built on a **transport-agnostic core**: the agent loop emits/consumes structured
  events; frontends subscribe. This keeps a future curses frontend and a VS Code
  webview as additive work, not rewrites.
- Port is **configurable** (env/flag) so Docker containers don't conflict.
- **Transport (agreed, D-18):** SSE for server→browser streaming (events, tokens,
  awaiting-input), POST for browser→server actions (send, approve/deny/edit, answer, switch).
- **Rich rendering:** the chat view renders **markdown**, including **Mermaid diagrams**
  and inline images (§16). *(Near-term.)*
- **Text-to-speech button** to read the agent's output aloud. *(Nice-to-have.)*
- **Chat view vs. workbench chrome (forward constraint):** the **chat view** is a
  self-contained component. Auxiliary tools that wrap around it — a **file viewer** and
  **file upload/download** to/from the machine viewing the page (§future) — are a separate
  outer layer. This split matters because in a **VS Code host those wrappers are redundant**
  (the IDE already provides file viewing and transfer), so the chat view must stand alone and
  not assume the surrounding chrome exists. Design the chat component to be embeddable bare.

Future frontend work (not now): a **file viewer**, and **upload/download of files** to/from
the remote system viewing the page (needed for the web/remote case; redundant inside VS Code).

## 12. Secrets

- OpenRouter keys live **only** in the OS-level config store, with restrictive file
  permissions. Never in the repo. `.gitignore` also blocks stray `.env` files.

## 13. Ask-the-user

- The model can **pause and ask the user a question** via a dedicated tool, then
  continue once answered. This pause is the canonical **"awaiting input"** state (reused
  by approvals §6, notifications §19, and the future fleet view §18).
- **Question UX (agreed, D-18):** a **prose** question waits on a free-text box; a structured
  **`ask_user` tool** delivers **suggested-answer buttons** and/or **multiple questions at once**
  with options and/or text fields (same shape as this project's own structured-question tool).
  The agent chooses the shape; the frontend renders it; a plain-text frontend falls back to text.

## 14. Diagnostics & logging

- A **rotating diagnostic log** captures errors and **full stack traces**, written to
  the OS-level log dir — kept **separate** from conversation history so failures are
  cheap to investigate after the fact.
- **Debug journal (agreed, D-15):** a separate append-only record capturing *everything* per
  turn — raw OpenRouter request/response, reasoning text, tool I/O, token counts, timings,
  mode/approval changes. It is deliberately verbose and is **not** replayed to any model, so
  it can capture detail the API-safe transcript (§8) must not. This is the "Halp!! something
  broke" record to investigate after the fact.

## 15. Context compaction

As conversations grow, context must be compacted to stay within the window without losing
the thread — and **without offending Fable** (the failure KiloCode's older/v5 path hit).
Grounded partly on a study of the latest KiloCode's `session/compaction.ts` (D-27, D-28).

### Overlay model (agreed, D-15)

Lossless **checkpoint overlay**: a checkpoint node holds a summary of everything up to it;
the context sent to the model becomes `system + summary + items after the checkpoint`. The
full node tree is preserved on disk — like a fresh conversation carrying a summary of the
"previous conversation."

### Trigger

- Budget derived from the model's `context_length` (OpenRouter metadata). Compact when the
  estimated request (system + messages + tools) exceeds `window − max(reservedOutput, buffer)`,
  **buffer default ≈ 20K tokens** (KiloCode's value; configurable).
- **Compactor-fit guard:** the budget must also fit the **compaction model's** window (minus
  summary output). If the summarizer is smaller than the working model, trigger earlier so the
  history still fits the summarizer. Bail/degrade gracefully if it can't fit.
- **Trigger modes (agreed):** **auto** at budget · **manual** on-demand · **suggest when near**
  · **auto-but-cancelable** (fires as an approval you can deny to keep going — the default when
  automatic compaction is off) · **hard limit / forced** (at a ceiling you cannot proceed
  without compacting or taking another action).

### What is kept vs summarized

- Keep the **system prompt** (always sent, never summarized) and the **most recent
  ~8K tokens** of conversation **verbatim** (`keep-recent`, configurable). Summarize the
  older middle. Never cut across an in-progress tool cycle.
- **Anchored, evolving structured summary (D-28):** a fixed Markdown template (Goal /
  Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context /
  Relevant Files), capped (~4K tokens). On later compactions **update** the prior summary
  (preserve still-true, drop stale, merge new) rather than re-summarizing from scratch.
- Tool outputs are **truncated** (~2K chars) when serialized into the *summary input*.

### Fable-safety rules (the whole point)

- **Kept-verbatim recent turns are replayed from their original stored entries** — the opaque
  `reasoning_details` (incl. the **signature / encrypted / redacted** payload) intact and
  unmodified (D-14). Never reconstruct a replayed assistant turn from serialized text; the
  provider validates the signature and any edit invalidates it.
- The flattened text used as **summary input** may render reasoning as plain text — that copy
  is *input to the summarizer only* and is **never replayed**.
- Summarized older turns are **dropped from replay** (replaced by the summary), so their
  reasoning is never sent — no signature to offend.
- The summary node lands on a **clean turn boundary**, so it never splits a thinking→tool_use
  pairing among the kept turns. Preserve tool-call/result pairing.
- Verified by a targeted test that reasoning survives a compaction (TESTING.md, Tier 1 cached +
  Tier 3 live Fable).

### Related

- **Agent-directed minimize/expand (planned, X-08):** tools to collapse specific chunks the
  agent no longer needs (e.g. a file read) after noting what matters, expandable later. Same
  non-destructive overlay; targets non-reasoning items first.
- **Transparency:** compaction/minimize events are shown in the UI and recorded; the
  pre-compaction tree stays in persisted history (§8) — nothing is truly lost.
- **Remaining open (O-02):** only the *empirical* verification of Fable's exact boundary; the
  strategy above is otherwise decided.

## 16. Images / multimodal

- **Agent → user (display):** the agent can send images for the user to see; the frontend
  renders them inline. Carried as an image event on the transport-agnostic bus (§11), so it
  works for HTTP now and any future frontend. *(Near-term desirable; priority TBD.)*
- **Image → model (vision):** the agent can feed images to a vision-capable model. Mechanism
  (background, not a locked design): OpenRouter uses the OpenAI vision format — an image is an
  `image_url` content part, which may be a `data:` URI (base64). Typical flow: **screenshot to
  disk → read → base64 → attach as an image part.** *(Future.)*
- **Forward constraint:** all image/screenshot file paths must go through the same sandbox /
  path resolver (§9, ARCH §6) so paths are not mangled and stay fenced. Screenshots/artifacts
  likely live in a defined scratch/artifacts location, not scattered.

## 17. Future direction: browser-driven app testing

**Not now.** Eventually the agent should be able to drive a real browser to test
partially-built apps (navigate, screenshot, feed the screenshot back to the model per §16a).
Note: **jsdom is a DOM without a rendering engine** and cannot screenshot; the real tools are
**Playwright/Puppeteer** (headless Chromium). Much of this can be driven from the command line,
so it may not need to be a first-class agent tool — possibly just shell commands. Decide later.

## 18. Future direction: remote control / fleet view (forward constraint)

**Not implemented now.** Recorded so we don't build in a way that makes it hard later.

Eventually Joshua wants to oversee many running JLCode instances remotely — likely a
separate project or subfolder running a **proxy** (e.g. on Cloudflare) that shows **all
instances and which ones are awaiting user input**, and lets him interact remotely.

Forward constraints this implies (respect them; don't build them yet):

- The core already emits structured events over a transport-agnostic bus (§11) — keep it
  that way so a remote proxy is "just another frontend/subscriber," not a rewrite.
- An instance should have a **stable identity** and an observable **status**, especially an
  explicit **"awaiting input"** state (from the ask-user pause, §13, and approval prompts, §6).
- Avoid hard-wiring the UI to a single local browser session; assume input/approvals may
  arrive from elsewhere.

## 19. Attention notifications (push)

When the agent **needs a question answered or an approval** (§6, §13) — especially while
long tasks run and Joshua is connected from a phone — he wants to be **notified that
something needs attention**. Preference: **avoid PWA / heavy machinery.**

Background (factual, not a locked design):

- **True background web push** (phone locked / browser closed) needs a Service Worker +
  Web Push (VAPID); on **iOS** it *only* works if the site is installed as a **PWA**. This is
  the "fancy" path Joshua wants to avoid.
- **Low-fancy path (leading candidate):** the server fires an HTTP notification to an
  **external push service** (ntfy.sh / Pushover / Telegram bot); the phone's existing app
  alerts. No PWA, works with the phone locked, and rides on the same **"awaiting input"**
  signal already exposed for §18. **This is the preferred direction; mechanism still open.**
- **Foreground-only** Notifications API (no service worker) works only while the tab is open —
  unreliable when backgrounded; noted but not preferred.

The notification **trigger** is the existing "awaiting input" state (ask-user pause §13,
approval prompt §6), so this reuses machinery we're already committed to.

## 20. Authentication (protect the open port)

The HTTP frontend must be **password-protected** so an open/published port isn't an open
door to the agent. Requirement: no unauthenticated access when the port is reachable.

Recommended approach (Joshua asked; **pending his final pick**):

- **Bind to `127.0.0.1` by default;** binding externally (`0.0.0.0`) is an explicit opt-in.
  This is the first line of defense — the password is the second.
- **Store a password *hash*, not the password.** Login only needs verification (unlike the
  OpenRouter keys, which stay recoverable to replay to the API), so hash it (argon2id/bcrypt)
  and keep the **hash** in the OS-level config store with restrictive perms. Never in the repo.
- **Bootstrap without an unauthenticated window:** on first run with no password set, generate
  a **one-time setup token printed to the server console/log** (the Jupyter/code-server
  pattern); use it once to set the real password in the UI. Avoids the "open, no password yet"
  gap that a set-it-later-in-the-UI flow would leave.
- After login, issue an **httpOnly signed session cookie** (signing secret in the config store
  or regenerated per run).
- **Remote = TLS.** A password over plaintext HTTP is sniffable; remote access should ride the
  §18 proxy (TLS-terminating) or an SSH tunnel, never raw HTTP to `0.0.0.0`.

The simpler "log in with no password first, set it later in the UI" option is acceptable **only**
if the server always stays on localhost; it leaves an exposed window otherwise.

## 21. Response caching as a product feature (candidate — evaluate)

The **request-keyed LLM cache** built for testing (see [`TESTING.md`](TESTING.md)) could double
as a **runtime feature** to cut cost on repeated identical calls. **Not committed** — must be
evaluated against provider rules first: a cached replay must still honor reasoning-replay
(D-14, never drop/reconstruct required reasoning) and provider terms of service. Anthropic's
**own prompt caching** is the sanctioned mechanism for cheap input reuse (the safe lane);
reusing whole responses is the lane needing care — especially for Fable. Distinct from §22.

## 22. Provider-side prompt caching (cost)

The OpenRouter client **supports provider-side prompt caching** (agreed, D-26) — placing
`cache_control` cache breakpoints so repeated input prefixes (system prompt + tools + prior
turns) are billed at the provider's cheaper cached rate. A major cost lever on long
conversations. The **append-only transcript** keeps the prefix byte-stable so caches hit;
compaction/fork are the natural invalidation points. This is the **provider input-token
cache** — distinct from the **local response cache** (§21, D-24) and the test cache (TESTING.md).

---

## Open questions

Tracked in [`DECISIONS.md`](DECISIONS.md) under "Open". Nothing blocking v1 scaffolding.
Testing strategy is agreed and documented in [`TESTING.md`](TESTING.md) (only the O-02
compaction/Fable tuning is deferred to build time).
