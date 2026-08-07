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
| Reasoning **effort** | First-class setting per config — e.g. `low` / `medium` / `high` or a model's adaptive level — passed through to OpenRouter. Different clients/models want different effort↔cost trade-offs. |
| Thinking round-trip | **Correct verbatim round-trip of reasoning blocks** across turns (D-14) — including preserving redacted / Fable reasoning as OpenRouter requires. (Distinct from the effort *setting* above.) |
| Sampling params | temperature, top_p, max_tokens. |
| Default mode + approval policy | The mode (Ask/Plan/Code) and approval policy this config starts in. |
| System-prompt addendum | Text **appended** to the base system prompt (not a full override), e.g. "use `python3` instead of `python`". |
| Per-turn environment details (X-25) | `environment.turnTimestamps` — whether each **user turn** is rendered with the time it was sent. **Default on**; off means the model is never told what day it is. |
| Compaction settings (§15) | **Compaction model** (default = the working model; overridable to a cheaper one, with the compactor-fit guard); **auto** on/off; an **absolute threshold** in tokens (`thresholdTokens`, X-27 — e.g. condense at 171,500) *or*, absent one, a **headroom buffer** (default ~20K tokens) the threshold is derived from; **keep-recent tokens** (default ~8K verbatim); **trigger modes**. The window comes from the model's `context_length` (from OpenRouter metadata, D-60). |

**Project-scoped instructions (planned, X-15).** The addendum above is per *config* (per client).
A **workspace** cannot yet ship instructions of its own: nothing reads `AGENTS.md` (or
`CLAUDE.md`/`.clinerules`) from the launch directory, so a repo's harness does not auto-integrate.
When added it appends to the base prompt ahead of the per-config addendum, is read **once at
session start** (the system prompt is the stable prompt-cache prefix, §22/D-26 — re-reading it per
turn would churn the cache), and is size-capped and visible. See X-15 for the open choices.

**Per-turn environment details (X-25, D-64).** The other half of the same seam, and it goes the
other way: what varies *per turn* is rendered onto the **user turn**, never into the system prompt.
Today that is the time — each user message is replayed as the user's words followed by an
`<environment_details>` block giving the ISO 8601 UTC instant it was sent plus the user's IANA zone
and offset. It is rendered from the `ts` each entry has always stored, so every existing
conversation gains it with no migration, and the stamp is frozen at append time, so the replayed
prefix stays byte-identical turn to turn and the cached prefix (§22/D-26) survives. A date in the
system message would invalidate that prefix every turn — the defect D-58 fixed at a measured 12.3x.
A compaction summary carries the span it replaces, so a compacted thread keeps its history of time.

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

**Readable before approval (agreed, D-53/D-63).** A pause is only a safeguard if you can tell what
you are agreeing to, so a tool may render itself better than its arguments do: `apply_edits` and an
**overwriting** `write_file` show a read-only unified diff against the files as they are on disk, a
**new** file shows its body with a line/byte count, and `delete_file` shows the size and head of
what it would destroy. Previews are computed server-side from the *pending* call, so a batch that
cannot apply says so on the card instead of after approval, and nothing out of fence is read to
build one. The preview never becomes a second editor — the raw-args box stays the single editable
truth (D-16).

**Output stays visible (planned, X-11).** Approving a command must not be the last time you see
it. The **tool result stays in the transcript** as its own item — the full output, not a preview —
so you can check what the model is reasoning about instead of taking its summary on faith. Today
the approval card carries the *args* and disappears on approve, and the transcript renders only
user and assistant entries, so `ToolEntry.content` is persisted and never shown; the debug journal
(§14) keeps a 200-char preview, which is a journal concern and no substitute for reading output.

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
- **The active pointer belongs to the reader (D-54).** A running turn is pinned to the branch it
  started on and appends there whatever the pointer does, so **branch navigation is free while a
  turn works** — step to a sibling, read it, come back, and the answer is waiting where it was
  being written. The pointer follows an append only when the append continues the branch it points
  at; the next message you send continues the branch you are *looking at*. Editing a message is a
  write, so it is refused mid-turn (queue the message instead) — but the refusal leaves the
  pointer alone.
- **Workspace identity in the UI (planned, X-10):** the browser shows **which working directory
  this instance serves**, and the **tab title** carries it too — with several projects open, the
  tabs are otherwise indistinguishable. The dir is already recorded (`IndexRow.workingDir`); it
  just isn't sent to or shown by the client. The workspace is per *instance*; the label in X-09
  is per *conversation*, and the tab likely wants both.
- **Conversation labels (planned, X-09):** a conversation carries a **human-readable label**,
  **auto-derived** from its opening exchange and **hand-editable** at any time. Today the index
  row is `id` + `workingDir` + `createdAt` only, so the history list and the session rail can't
  tell two threads apart. Open questions live with X-09: whether an auto-title refreshes as a
  thread drifts, whether a manual rename pins it, and what a fork inherits.

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
- **Whimsical "percolating" messages (nice-to-have):** while the agent works, cycle a random
  playful status line (à la `Reticulating splines…`) to raise a smile. Ship a list of ~20 and
  let it grow. Starter set:
  `Reticulating splines…` · `Consulting the rubber duck…` · `Bribing the compiler…` ·
  `Shaving the yak…` · `Negotiating with the borrow checker…` · `Herding semicolons…` ·
  `Warming up the flux capacitor…` · `Untangling the dependency graph…` · `Summoning stack frames…` ·
  `Convincing the linter…` · `Feeding the hamsters…` · `Aligning tabs and spaces (choose wisely)…` ·
  `Rolling for initiative…` · `Dusting off the parentheses…` · `Rerouting the tubes…` ·
  `Percolating…` · `Compiling excuses…` · `Asking the elder gophers…` · `Buffering the buffer…` ·
  `Teaching the model humility…` · `Locating the missing semicolon…`
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

### Regimes — v1 uses safe-harbor only (D-38)

Three regimes of increasing fidelity and complexity. They are the toolbox — if a case comes
up, we have options — but v1 commits to just the first:

1. **Safe-harbor (full summarize) — the v1 regime.** Summarize *everything* prior into the
   blob (zero thinking replayed) + bookend quoting. Simplest, **provably Fable-safe by
   construction**, lowest recent-context fidelity.
2. **Partial-keep-lite — planned fast-follow.** Summarize the old middle but keep recent
   **messages + tool results verbatim**, with recent **thinking re-expressed as text**
   (re-express, don't replay). Recovers most fidelity, **still provably Fable-safe** because no
   signed thinking block is ever carried across a compaction.
3. **Partial-keep-full — retired.** Keep recent turns verbatim *including signed thinking*
   across the boundary. This was the only Fable-risky case (the old **O-02**). Since #2 gives
   most of the benefit safely, #3 is **not pursued**, and O-02 is **resolved by design** (moot),
   not by experiment.

Everything below describes the general machinery; the keep-recent-verbatim parts belong to
regimes #2/#3 (fast-follow), while v1 exercises the safe-harbor path.

### Trigger

- Budget derived from the model's `context_length` (OpenRouter metadata). Compact when the
  estimated request (system + messages + tools) exceeds `window − max(reservedOutput, buffer)`,
  **buffer default ≈ 20K tokens** (KiloCode's value; configurable).
- **Or state the threshold outright (X-27, D-62):** `compaction.thresholdTokens` (e.g. 171,500) is
  used as the threshold directly and **wins over the buffer derivation**, which remains the rule
  when it is absent. A threshold that is not strictly below the window is **refused** — at
  `config set` time when the window is known, and ignored in favour of the derivation at runtime —
  since it could otherwise only fire on a request the provider has already rejected.
- **Compactor-fit guard:** the budget must also fit the **compaction model's** window (minus
  summary output). If the summarizer is smaller than the working model, trigger earlier so the
  history still fits the summarizer. Bail/degrade gracefully if it can't fit.
- **Trigger modes (agreed):** **auto** at budget · **manual** on-demand · **suggest when near**
  · **auto-but-cancelable** (fires as an approval you can deny to keep going — the default when
  automatic compaction is off) · **hard limit / forced** (at a ceiling you cannot proceed
  without compacting or taking another action).

### What is kept vs summarized

- Always keep the **system prompt** (never summarized). In **v1 safe-harbor**, everything else
  prior is summarized (fidelity comes from bookend quoting, below). The **most recent ~8K tokens
  verbatim** (`keep-recent`, configurable) is the **fast-follow** (#2/#3), not v1. Never cut
  across an in-progress tool cycle.
- **Anchored, evolving structured summary (D-28):** a fixed Markdown template (Goal /
  Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context /
  Relevant Files), capped (~4K tokens). On later compactions **update** the prior summary
  (preserve still-true, drop stale, merge new) rather than re-summarizing from scratch.
- **Bookends quoted as text (Fable-safe preservation):** the summarizer is instructed to
  **quote the original request and the latest turn (near-)verbatim inside the summary prose**.
  This preserves the crucial first/last content almost word-for-word, but it is *legally just
  summary text* — no signature, no tool cycle — so there's nothing for the provider to validate
  or flag. It lets even the **full-summarize safe-harbor** retain its bookends without entering
  the risky partial-replay regime.
- Tool outputs are **truncated** (~2K chars) when serialized into the *summary input*
  (this flattening applies to the **cross-model** path below, not the cache-reuse path).

### Two request paths for producing the summary

- **Cache-reuse (same-model) fast path — preferred when the compaction model == the working
  model.** Send the **exact live conversation** (system + tools + all turns, byte-identical to
  what the chat already sent) and **append the compaction instruction as the final message**.
  The provider serves the whole prefix from its **prompt cache (D-26)**; we pay full rate only
  for the short appended instruction + the summary output. Keep the request byte-identical to
  what's cached (same tools, `tool_choice: none`); the compaction instruction is **ephemeral**
  (never written into the transcript tree); append only at a **clean turn boundary**. No
  transcript flattening needed, and it's **Fable-safe by construction** — the prefix is the
  exact, already-validated conversation, unmodified. Summary effort can be set low to save cost.
- **Cross-model path — when a different/cheaper compactor is configured.** Build a separate
  summarizer request from a flattened, tool-output-truncated transcript (KiloCode-style). No
  shared cache, and it pays full input rate — a cost trade-off for the cheaper model.

### Fable-safety rules (the whole point)

**Guiding law — perfect-or-gone, per whole tool cycle.** A "tampered" verdict fires when a
signed thinking block's **signature fails to validate** (it was edited/reconstructed) **or**
when a kept thinking block is **orphaned** (its paired tool_use/tool_result was summarized
away). So every signed thinking block is either replayed **byte-exact with its entire tool
cycle intact**, or **removed entirely with its whole cycle** — never edited, reconstructed,
or orphaned. There is no safe middle.

- **Kept-verbatim recent turns are replayed from their original stored entries** — the opaque
  `reasoning_details` (incl. **signature / encrypted / redacted** payload) intact and unmodified
  (D-14). Never reconstruct a replayed assistant turn from serialized text.
- The flattened text used as **summary input** may render reasoning as plain text — that copy
  is *input to the summarizer only* and is **never replayed**.
- Summarized older turns are **dropped from replay** (replaced by the summary), so their
  reasoning is never sent — no signature to offend.
- The compaction cut lands on a **whole-tool-cycle boundary** — it never orphans a thinking
  block from its tool_use/tool_result, and never bisects an in-progress cycle.

**Full-summarize safe-harbor mode — the v1 regime (D-38).** Summarizing *everything* prior into
the blob (zero thinking replay) is definitionally safe — from the provider's view it's just a
**new conversation seeded with a big starter summary**, with nothing to validate. v1 uses this
as the **sole** compaction regime; the perfect-or-gone rules above then apply only to *normal*
(non-compaction) replay, where recent turns are sent verbatim per D-14.

- Verified by tests that (a) normal replay round-trips reasoning verbatim (D-14) and (b) a
  safe-harbor compaction produces a valid request that Fable accepts (TESTING.md). The
  partial-keep tests arrive with the #2 fast-follow.

### Related

- **Agent-directed minimize/expand (planned, X-08):** tools to collapse specific chunks the
  agent no longer needs (e.g. a file read) after noting what matters, expandable later. Same
  non-destructive overlay; targets non-reasoning items first.
- **Durability-aware context management (principle):** the agent tracks what it has **durably
  persisted** — written to files / committed to the harness or git, or otherwise re-readable via
  its tools — and may then **safely drop or minimize that from the live context**, since it can
  re-read it later; not-yet-persisted (ephemeral) content is kept. *"I saved it, so I can forget
  it for now."* This heuristic guides both compaction and X-08 minimize/expand — and it's the same
  instinct behind starting a fresh thread once state lives durably in the harness.
- **Transparency:** compaction/minimize events are shown in the UI and recorded; the
  pre-compaction tree stays in persisted history (§8) — nothing is truly lost.
- **O-02 resolved (D-38):** mooted by design — v1 ships safe-harbor only, #2 partial-keep-lite
  is the safe fast-follow, and the Fable-risky #3 is retired. Nothing left to test-gate.

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

## 23. Robustness: output truncation (max_tokens)

When the provider stops with `finish_reason: "length"` (or a tool call's arguments don't fully
parse), the turn was **cut off**. KiloCode v5 lost the content, never told the model (so it
**looped**), and worst of all a truncated edit's missing tail became a **silent deletion**.
Handling (agreed, D-30):

- **Detect, never be blind.** `finish_reason == "length"` or incomplete/unparsable tool-call
  args → a first-class **TruncationEvent**, surfaced in the UI and the debug journal (§14).
- **Reasoning cut mid-thought — re-express, don't replay.** The partial thinking is incomplete
  and unsigned, so it is **not** replayed as a block (perfect-or-gone, §15). Instead it is handed
  back as **plain-text input**: *"You hit the output limit while thinking; here are your partial
  thoughts: … — continue from here."* Fable-safe (no signature to validate), lossless, and the
  model resumes **aware**, so it doesn't loop. (Same **"re-express, don't replay"** principle as
  bookend-quoting and the safe-harbor in §15.)
- **Recovering the partial (why we can, D-31):** our thin client (D-21) **streams and retains
  the raw tool-call `arguments`**, so we recover partial content by **streaming value extraction**
  (build each field as it arrives → truncation leaves a *known, unterminated* `content` string,
  not opaque broken JSON), with a **repair-and-parse** fallback (close open structures). Pure-JS,
  no native dep. Trim a mid-escape tail to the last clean boundary; arguments are ordered
  **content-last** so metadata survives. (A black-box SDK would drop the partial — owning the
  client is what makes this possible.)
- **Tool-call cut off — split by op type:**
  - **Additive (create / append / insert):** a partial can't delete anything, so keep the
    recovered content and return a **visible tool-result** telling the model it was cut off and to
    continue — enabling **resumable, chunked file creation**. (If args are unrecoverable, reject + notify.)
  - **Replacing (range-edit / full rewrite):** a missing tail *is* a deletion, so **reject
    atomically** (all-or-nothing; temp→fsync→rename) and return a visible "not applied — redo
    smaller / additively." This is why the file tools favor truncation-resistant additive/anchored
    edits (§9, D-30).
- **Anti-loop.** Every truncation emits a **visible** signal the model sees next turn; two
  identical truncations in a row → **escalate to the user** (ask-user, §13). Optional one-time
  `max_tokens` bump for near-misses (configurable), coordinated with the context budget (§15).

"Never apply a partial edit" and "keep partial file creation" are consistent — they're the two
halves of the additive-vs-replacing split.

**Content transport (agreed, D-31):** file content travels as a normal **tool-call JSON
argument** (streamed + partial-recovered as above), *not* a separate output convention. Ordered
content-last; large writes use chunked append; prompt caching (§22) offsets re-send cost. An
output-convention text channel is kept in reserve as a future token-cost optimization for very
large writes only.

## 24. Safety: repeated-failure circuit breaker

Generalizing the anti-loop guard (§23): track **consecutive failures of any kind** — provider
errors, unresolved truncations, tool errors, invalid/unparsable tool calls, no-progress repeats.
**N in a row (default 3, configurable) → hard-stop the agent loop and escalate to the user**
(awaiting-input, §13), recording the streak in the debug journal (§14). Resets on any success.
Protects against runaway loops and, importantly, **runaway cost** (D-32). This is the backstop
behind the per-case handling (truncation §23, approvals §6).

## 25. Cost accounting, spend display & cap (D-33)

- The UI shows **current spend in a corner of the screen**, updating live.
- Spend is the **whole-tree total** — *every* model call charged to this conversation: all
  branches (fork/rewind don't erase what was spent), **plus compaction summaries, judge calls,
  and (future) sub-thread spend that rolls up (§27)**. Not just the active branch.
- Computed from token usage × model pricing (OpenRouter metadata), honoring cached-token
  discounts (§22); recorded per call in the debug journal (§14).
- A **settable spend limit**; on breach the agent **hard-stops and escalates** (awaiting-input,
  §13), offering to raise the cap — same backstop family as the circuit breaker (§24). *Proposed
  default: a per-conversation limit plus an optional global/per-config cap — veto if you want
  only one.*

## 26. Activity & interruption control (D-34)

- **Background tasks are first-class.** Long-running operations (shell commands that don't
  return promptly; future sub-threads §27) are tracked with live status and are **individually
  killable** from the UI — the affordance to kill a task that hung or won't finish soon.
- **Queued message.** You can type a message mid-turn; it **queues and applies at the next turn
  boundary** rather than interrupting the in-flight turn (FIFO; editable/cancelable before it
  applies). Lets you drop in an idea without derailing the current turn.
- **Global stop button.** Kills **all activity at once** — the agent loop *and* every background
  task. The big red button, distinct from the gentle queued-message path and the targeted
  per-task kill.
- All three are POST actions on the transport (§11); status and kill/stop states flow back over SSE.

## 27. Concurrency, sessions & orchestration

### Vocabulary (keep these distinct)

- **Branch** — an alternate *history* within one conversation (fork/rewind, §8). **Passive:**
  navigating a branch runs nothing; at most one live leaf per running session.
- **Session** — a live **running agent loop** bound to a conversation, with its own mode, config,
  status, cost, background tasks, and event stream. **Concurrency = multiple live sessions.**
- **Instance** — a whole JLCode process (Docker / fleet axis, §18), aggregated later by the proxy.

A history fork never silently starts or stops execution; anything executing is a **visible
session** with a running/idle status. "Fork into two live threads" is an *explicit* spawn of a
second session, not a side effect of branching.

### v1: multiple concurrent sessions, shared folder (D-36)

One server hosts a **SessionManager** = N independent, first-class sessions ("a bag of agents");
the per-session event bus (§11) is multiplexed to the frontend. Sessions may run **concurrently
in the same folder** — e.g. one committing the harness while another codes, or a side
"by-the-way" thread.

**Anti-entropy invariant (governing rule):** JLCode's own state stays consistent under any number
of concurrent sessions. Each session **fully owns its mutable state**; sessions share only
(a) read-mostly config, (b) append-only / per-session-file data stores (one file per conversation
→ no write contention), and (c) the workspace filesystem. The filesystem is the **single
deliberately-unguarded** shared resource: concurrent edits are a documented **"running with
scissors" power-user risk**, never a source of internal inconsistency. **Nothing is
"the current session"; no global-current state.**

- Each session holds its **own config** (the folder→config binding, D-06, is only the default for
  a *new* session); its **own** whole-tree spend (D-33, with a folder/global view summing live
  sessions); its own mode/approval, background tasks, and stop/kill controls (D-34).

### Deferred (same mechanism, later)

- **Running two live sessions on two branches of one conversation (X-14)** — *wanted, not built*.
  This is the explicit spawn the rule above describes; today no API can start a session from a
  chosen *(conversation, leaf)* pair. Was blocked on **H-05**, where a running turn appended wherever
  `activeLeaf` pointed *when the stream ended*; since D-54 a turn is pinned to the branch it started
  on, so "at most one live leaf per session" holds under mid-turn navigation and the leaf is purely
  what the reader is looking at. Open design question is whether a forked session copies the tree
  into its own conversation file or shares one live tree (see X-14).
- **Workspace isolation via git worktrees** — *postponed*. When added, an editing session can take
  its own worktree/branch so concurrent editing is safe (merge after); read-mostly side threads
  still just share the folder.
- **Agent-initiated orchestration (D-35)** — an agent spawning sub-sessions that report back is the
  **same** session mechanism, just agent- rather than user-initiated: sub-sessions are linked to a
  parent, **report results back**, their **spend rolls up** (§25), **kill/stop extends** to them
  (§26), and they appear in the bag + the fleet view (§18).

---

## Open questions

Tracked in [`DECISIONS.md`](DECISIONS.md) under "Open". Nothing blocking v1 scaffolding.
Testing strategy is agreed and documented in [`TESTING.md`](TESTING.md) (only the O-02
compaction/Fable tuning is deferred to build time).
