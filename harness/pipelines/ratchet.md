# The ratchet — pipeline mode

**Opt-in. This is not how work is normally done here.** It exists so that when Joshua says
*"run the pipeline"*, *"ratchet"*, *"do these phases pipeline-style"*, or names this file, a
session knows exactly what is being asked for without being told again. A session that is not
asked follows [`../../CLAUDE.md`](../../CLAUDE.md) and ignores this file.

Called the ratchet because each phase only moves forward: nothing is committed until a fresh
reviewer finds nothing left to fix, and every phase is committed and pushed before the next one
starts — so a later phase going wrong never endangers an earlier one, and Joshua can stop the run
cleanly at any phase boundary.

Cribbed 2026-10-20 from two field-tested copies in Joshua's other projects —
`Satellite-Chess/harness/pipeline/ratchet.md` and `niceclaude/harness/pipelines/ratchet.md` —
and adapted to this repo's rules. Their failure-mode stories are theirs; the rules below are the
ones that transfer. First intended use: **ROADMAP Phase 9** (X-56).

**When to reach for it:** a multi-slice change whose *what* is settled — a ROADMAP phase with
its slices already written — where a defect is expensive. **When not to:** exploratory work where
the design is still moving (review rounds against a moving target burn agents on churn), or a
one-file fix (just make it).

```
for each slice, one at a time:
    spawn an implementer for it                 (keep its name — fixes go back to it)
    loop:
        spawn a NEW reviewer on the uncommitted diff
        if VERDICT: FIX  → send the must-fix items to the SAME implementer, loop
        if VERDICT: CLEAN → break
    coordinator: harness bookkeeping, stage by explicit path, commit, push
```

## Operator inputs — have these before spawning anything

| Input | Notes |
|---|---|
| **The slice list, in order** | From ROADMAP (Phase 9 = P9a…P9g). If deriving one, get the split confirmed first. |
| **The spec for each slice** | The ROADMAP slice text **plus** the decisions and settled-design records it cites (for Phase 9: D-87/D-88/D-89 and DECISIONS "X-56 — settled design"). Name exact paths. |
| **The stop point** | Which slices are in scope. **Paid test tiers (2/3) are Joshua's** unless a TESTING.md grant covers the exact run — P9g is a stop point, not a slice to run unattended. |
| **The baseline** | `npm run build && npm test` on the untouched tree, recorded *before* the first implementer starts: "these exact results and no others". Today: 982 green. |
| **Next free ids** | Decision `D-…`, backlog `X-…`, hardening `H-…`. Without them parallel additions collide. |

## The rules that make it work

**One agent touches the tree at a time.** One working copy; slices are sequential. Only the
coordinator and the one running subagent are ever live (reviewers read and run, never edit).

**A new reviewer every round.** One that already blessed a diff is invested in it. Brief it in a
paragraph on what earlier rounds verified and fixed, and tell it to spot-check that rather than
re-derive it or trust it.

**The same implementer for fixes.** It holds the reasoning, so a fix costs a message, not a
re-read. **But write every finding self-contained** — `file` + symbol, the wrong behavior, a
concrete failure scenario, the suggested fix — so that if the implementer's transcript is gone
("No transcript found for agent ID"), a fresh fixer can act on it without stalling the run.

**A reviewer ends with a verdict line** — `VERDICT: CLEAN` or `VERDICT: FIX` followed by numbered
must-fix items. Optional nits go in a separate section and are **not** fed back automatically;
the coordinator picks from them deliberately and says why. No praise, no restating the change.

**Reviewers run things, they do not only read.** The highest-value rule in both source copies.
Each reviewer runs `npm run build && npm test` *itself* and never trusts the implementer's report
of green. For a UI slice it runs the peek tool on **its own port pair**
(`JLCODE_PEEK_PORT=78NN JLCODE_PEEK_CDP_PORT=94NN node harness/peek/peek.mjs up …`, then `down`) —
the coordinator keeps the list of ports already handed out and gives each agent a fresh pair.
Give each reviewer **specific questions**: the doubts the implementer reported, the risk the last
fix introduced, and the worst outcome for Joshua (for Phase 9: a key or a binding silently
changed, an agent tree that runs unbraked, a log that no longer folds back).

**Round N usually finds a bug next to round N−1's fix.** Don't stop because a fix "obviously"
closed a problem. No round cap — stop when a review is clean. If rounds repeat the **same class**
of finding instead of converging (~3 rounds), take a second opinion on whether to stop.

**Cite symbols, not line numbers.** A `file:NNN` anchor dies with any insertion above it and
reviewers will chase stale anchors one per round forever. Tell reviewers up front: *"do not
report an anchor merely because its line number moved; do report one whose target contradicts
the claim it supports."*

**No second-model gate here.** niceclaude's copy ends each phase with a review by a different
model; Joshua's plan for this repo has no second model (2026-10-20), so the fresh-reviewer loop is
the whole gate. If a second model ever becomes available, it runs once the loop is quiet, on a
settled tree, handed the first model's claims marked *do not trust* — never raced alongside a round.

**Judgement calls get a second opinion first.** When a call is Joshua's and he is away — is this
optional item worth taking, is this loop going anywhere — spawn one cheap independent read with
the options and a word limit before deciding.

**Pre-existing failures are not the implementer's.** The baseline is the success criterion. An
*additional* failure is the slice's; a flake gets root-caused (CLAUDE.md), never committed
through.

## Who does what

**Joshua's session is the coordinator and never implements** — except that when a round is down to
one verifiable string replacement, doing it directly beats another round trip. It writes the
prompts, relays each report in a few plain lines (Joshua reads a terminal, often at a glance),
picks optional items, and decides when a slice is done. It reads only final reports, not
transcripts, and does its own cheap checks (`git log` after a push, a glance at a post-review
change).

**A fresh implementer per slice.** One carries a slice through all its rounds; the next slice gets
a new one, because a slice's context is spent by the end of it.

**The coordinator commits** — subagents never commit, stage, or touch git. After a clean review:
1. Harness bookkeeping, kept out of review rounds so reviewers don't flag a deliberately stale
   status: ROADMAP slice marked ✅ + the "resume here" block, DECISIONS rows for build-time calls,
   the README if how Joshua runs or drives JLCode changed, VISUAL-LOG for a UI slice's peek.
   (Delegate it to the implementer as a FINALIZE message, or do it directly.)
2. `npm run build && npm test` green.
3. **Stage by explicit path**, then `git diff --cached --stat` — only this slice's files.
   Never `git add -A` / `.`. `niceclaude-usage.png` and `observed_items_needing_filed_in_harness.txt`
   are Joshua's untracked files and are never staged.
4. Commit naming the slice (`P9a: …`) with the repo's trailer
   (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), then **push** — on this repo an
   unpushed commit is a fix Joshua cannot run (CLAUDE.md).

**Changes after a clean review must be small** — tested, mirroring already-reviewed code, and read
by the coordinator before commit. Anything larger gets another round.

**Don't end a slice with a question.** If the next slice is in scope, proceed; report at the real
stop condition. Joshua may be away.

## Stop conditions

- The scoped slices are committed and pushed → stop and summarize.
- A stop point is reached (a paid tier, anything outward-facing beyond `git push`) → stop.
- An agent is blocked → surface it; don't let it work around a blocker.
- **Interrupted?** Commit what is green with a resume checklist in ROADMAP's resume block — done,
  not done, the settled calls, the next items in order — so a new thread continues the loop with
  nothing re-derived.

## What goes in a subagent prompt

Subagents start cold. Every prompt carries:

- **Read first:** `CLAUDE.md`, the slice's ROADMAP text, the decisions and settled-design records
  it cites, and `harness/TESTING.md` for the tier rules.
- **Scope:** the slice id, and what is explicitly *out* (other slices' work).
- **Repo rules a cold agent breaks:** use libraries (D-45); `python3` never `python`; tests and
  peeks use temp `JLCODE_CONFIG_DIR`/`JLCODE_DATA_DIR`, never Joshua's real `~/.config/jlcode`;
  never print an OpenRouter key; **free tiers only** — no paid tier, no live model; match the
  surrounding code's style and comment density.
- **Verify:** `npm run build && npm test`; the baseline; for UI, the peek tool on its assigned port
  pair.
- **Git:** do not commit or stage; never `reset --hard`, `clean`, `stash`, `checkout -- .`, or move
  `HEAD` — the tree is shared.
- **Joshua is away: make the call yourself and never stop to ask.**
- **Flag, don't fix, unrelated rot** — note it in the report with the next free `H-`/`X-` id.
- **Report** the exact list of files touched, test results, and any doubts.

**Reviewer prompts add:** the implementer's claims (*do not trust — verify*), the earlier rounds in
a paragraph, the specific questions, its peek ports, *never edit source or touch git*, and the
exact verdict-line format.
