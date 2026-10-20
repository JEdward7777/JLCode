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

## Open (in order)

- Q7 — runaway brake: agents re-triggering each other's billed turns.
- Sub-agent model choice: same-key only (Joshua) — default when `model` omitted, how the agent
  learns the allowed list.
- Sub-agent permissions: mode/approval inheritance; who answers a sub-agent's approval prompt.
- GUI: folder-like nesting in the rail, interacting with a sub-agent, attribution rendering.
- Lifecycle: sub-agents of a sub-agent? Closing/killing; restart/resume of a tree; history list.
- Then: phase the build into ROADMAP.
