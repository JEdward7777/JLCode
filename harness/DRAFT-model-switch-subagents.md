# DRAFT — per-thread model switching + background sub-agents

> **Status: spec Q&A in progress (started 2026-10-13, Joshua + Claude).** Not yet phased.
> When the Q&A is complete this folds into SPEC / DECISIONS / ROADMAP as phases and this file is
> deleted. Saved mid-Q&A because a session was lost to a reboot once already.

## Goal (Joshua, 2026-10-13)

- A UI widget to pick any defined model config for the thread in view; the pick overrides the
  command-line binding and survives later binding changes.
- Switch mid-conversation; if the new model fusses, switch back and fork before the error.
- Switching to a config with a different key asks for confirmation.
- Agent-spawned sub-agents, possibly on another model — **only configs sharing the current
  thread's key**.
- GUI must show sub-agents as visually belonging to the parent thread (folder-like) while still
  being interactable.

## Settled

**Q1 — where the choice lives.** A model switch is an **entry in the conversation log**. The model
in force at any point is the nearest switch entry above it; forking above a switch reverts the
model for free. A thread (branch) with **no** switch entry follows the folder binding / `serve
--config` exactly as today (D-82a). Once a branch has a switch entry the binding never moves it,
and there is **no "back to default"** in the UI. (Corollary, accepted: forking above the *first*
switch yields a branch with no entry, which follows the binding again.) Supersedes D-82a for
switched threads; reconciles SPEC §27's "each session holds its own config".

**Q2 — what the entry points at.** The **config id**, resolved live on every request (later edits
to that config — effort, `--provider`, a rotated key — reach the thread), plus a display snapshot
(name + model at switch time) for the transcript marker. If the config has been **deleted**, the
thread refuses to send and shows an inline "this thread's model no longer exists — pick one" with
the picker open; picking writes an ordinary switch entry. Never a silent substitute.

**Q3 — picker + key confirm.** Every config listed, **grouped by key**, current thread's group
first; group heading = last-4 key fingerprint + the config names in it. Same-group switch is one
click. Cross-group switch → inline confirm naming both fingerprints, **every time** (no "don't ask
again"). The full key never reaches the browser — the server sends fingerprints only. No cost
line in the confirm.

**Mechanics (Claude's, stated as fact).** The new model never receives the old model's signed
reasoning: the wire keeps text + tool calls and drops pre-switch `reasoning_details` (the
compaction rule). The switch entry **resets the provider pin** (D-49), as compaction does. The
first turn after a switch re-reads the thread at full price (cache is per model) — accepted, not
warned about.

**Q4 — when.** Switch applies only while idle/stopped. Picked while busy (running, or paused for
approval/question) → shown as **pending**, applied at the next idle point. **No warning
machinery** in the picker (no fit/cost estimates) — Joshua: "a lot to get right and a liability
if you get it wrong." Over-window / cost surfaces at send time as today.

**Q5 — sub-agent shape (Joshua's design, replaces the blocking proposal).** Sub-agents run in the
**background** with a **bidirectional channel**. Each agent is a full session with its own log,
linked to its parent (D-35: spend rolls up, Stop/Kill extend). Tools: `spawn_agent(task, model?)`
returns the agent's name at once; `send_message(to, text)` either direction. After spawning, the
parent simply ends its turn and goes idle (same as waiting on the user). An inbound agent message
arrives **as a user-side entry attributed to its sender** — starts a turn if the receiver is idle,
otherwise rides the existing queue.

**Q6 — completion + mid-task corrections.** On a sub-agent going idle the parent gets a
**completion notice** (who finished) — *not* an auto-post of its last text (Joshua: hackish); the
parent can `send_message` asking for a report. Mid-task corrections already work: the D-34 queue
is flushed **at every pass of the tool loop** (D-52, `flushPendingUser`), i.e. between model
calls once a tool batch drains — not only at end of task. So a message to a busy sub-agent lands
before its next model call.

**Q7 — runaway brake.** No new mechanism: reuse D-79's tool-round budget (`commands.toolRounds`,
pause + double on Continue). Change: **only a human-typed message resets it** — an agent-sent
message continues the same count (today `send()` resets at `session.ts:1308`). Per session, so
parent and each sub-agent pause independently.

**Q8 — the off switch (reverses D-79's "cannot be disabled", deliberately).** Joshua: unattended
work is the point; a user who knows what they're doing may take the risk. Two levels: (a) config
`jlcode config set <name> --tool-rounds off`, mirroring `--command-watchdog off`. (b) a third button on the pause card, "Continue, don't ask again in this
thread" — per thread (and its sub-agents), recorded in the log so it survives restart. The spend
cap (D-33) remains the only brake when off. *(Amended by Q13: (a) is read from the **root** thread's config, not
each child's.)*

**Q9 — sub-agent model choice.** `spawn_agent(task, model?)`: omitted `model` = the parent's own
config. Choices come from a separate **`list_models`** tool (configs sharing the thread's key,
name + model) — called only when the agent needs it, and keeping a changeable list out of the
cached tool prefix (D-81). `spawn_agent` validates against the **live** config set server-side; a
name outside the same-key set errors with the allowed names.

**Q10 — sub-agent permissions.** A sub-agent starts at its parent's current mode + approval policy
as a **ceiling**; `spawn_agent` may take an optional `mode` to make the child *stricter* (e.g. an
Ask-mode researcher), never looser — refused. Same workspace fence and remembered roots as the
parent. **Every approval prompt goes to the human, never to the parent agent** (an agent approving
its own child's writes would bypass the policy). The prompt shows in the sub-agent's view and the
"waiting for you" flag also surfaces on the parent. A sub-agent's `ask_user` likewise goes to the
human; the parent can still talk to it via `send_message`.

**Q11 — GUI.** Sub-agents live in the **existing active-threads list** (the rail) — not a new
pane — nested folder-style under the thread that spawned them: name, model, status dot (running /
idle / finished / waiting for you). The parent gets a disclosure arrow; collapsed, it shows its
most urgent child status (a child waiting on approval lights the parent). Clicking a sub-agent
opens it in the main pane like any thread: transcript, its own model picker, a composer — a
message typed there is human input (resets that agent's tool-round count, Q7). In the parent's
transcript, agent traffic renders as compact linked cards — spawned / → sent / ← received /
finished — styled distinctly from the human's own messages. No split pane.

**Q12/Q13 — nesting depth.** Sub-agents may spawn sub-agents, up to **N levels below the
human-started root**; past it `spawn_agent` errors and the agent does the work itself. N is a
**model-config** setting beside `toolRounds`/`watchdogMinutes`: `jlcode config set <name>
--agent-depth N`, default **3**, `0` = this config never spawns. A "how you work" field, so
`config model` carries it (D-82). Because a tree can mix configs, the **root thread's config
governs the whole tree** (read live, so a change applies at the next spawn) — a child on a laxer
config cannot nest deeper than the root allows. The Q8 tool-round off switch follows the same
root-governs rule. At every level: same key as the parent, permissions ≤ parent, nested in the
rail, Stop/Kill reach the subtree.

**Q14/Q15 — storage + boot.** *Storage:* the whole tree lives in the **root's one JSONL file**.
Already safe in-process: `ConversationStore` routes every write to a file through one `AppendLog`
queue, and load folds by `parent` pointers so interleave order is irrelevant. New: entries carry
their **agent id** → the file holds several roots (one per agent), each with its own `activeLeaf`
records and forks; a session loads only its agent's subtree. Caveat (already true today): two
`serve` *processes* on one thread are two writers. *History* shows root threads, sub-agents nested.
*Boot:* nothing auto-starts. Agent state is derived from the log: **interrupted** (branch ends
mid-turn — unanswered tool call / turn marked cut off), **owes a reply** (last entry is an inbound
message it hasn't answered), **quiescent** (ends on its own finished reply). To make "owes a reply"
survive a crash, an agent message is **written to the receiver's log when sent** (as pending), not
held only in the in-memory queue. A **Wake** button on any rail entry resumes that thread and its
subtree — **only interrupted / owes-a-reply agents**; quiescent ones stay asleep. Interrupted turns
retry like Retry; owing agents start a turn on the pending message. The root agent may call
`wake_agents` (scoped to its own tree). Woken turns do **not** reset the tool-round budget.

**Q16/Q17 — questions are addressed by the model (amends Q10's "ask_user goes to the human").**
Every inbound message carries its **sender** (the human, or an agent by name) as part of the
message, so an agent always knows who it is talking to. The question tool takes a **`to`**:
`user` or `parent` — the model decides. Omitted `to` defaults to **whoever started the current
turn** (the spawn task / a parent message → parent; the human typing in that agent's view →
user), so a model that forgets still does the sensible thing; `parent` on a root is refused with
"you have no parent — ask the user". An outstanding question is answered only by **its addressee
or the human** (the human outranks every agent and the question is visible in the agent's view);
anyone else's messages queue normally. An agent that can't answer a question it received
escalates by asking its own questioner, up to the human at the root. **Approvals never route
through agents** — always straight to the human. (Tool rename from `ask_user` to something like
`ask` is a build-time call.)

**Q18–Q20 — finished vs closed, and who can close.** A **finished** (quiescent) sub-agent keeps its
place in the rail with a dimmed status dot. A **closed** one turns grey and **sinks below its open
siblings** within its own parent (its children fold away); clicking it **reopens** it (loads, opens
in the main pane, rises back). More than ~5 closed siblings fold into one "N closed" row that
expands in place — a local shift the user triggers, never a global "show closed" toggle. Root
threads close into the history list as today. **Closed is one flag, shared by human and agents:**
an agent may close its own children too, and a `list_agents` tool lists an agent's children,
**omitting closed ones unless `show_closed`** — so a long-running coordinator can tidy its own
view. Otherwise closing is organizational: a closed agent still receives messages (delivery
reopens it) and still sends its completion notice. **Exception: Wake skips closed agents**, even
interrupted / owing ones — reopen one to make it wakeable. Closing unloads the session from memory.

## Open (in order)

- Concurrency: a cap on simultaneously running agents?
- Then: phase the build into ROADMAP.
