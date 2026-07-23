# JLCode — Agent Operating Guide

JLCode is a **from-scratch coding agent** (a KiloCode replacement) built to be
simple to maintain, with per-client model configurations, its own OpenRouter
connection, and explicit Ask / Plan / Code modes.

**Before implementing anything, read the harness:**

- [`harness/SPEC.md`](harness/SPEC.md) — what we're building (functional spec).
- [`harness/ARCHITECTURE.md`](harness/ARCHITECTURE.md) — how it's built (technical design).
- [`harness/DECISIONS.md`](harness/DECISIONS.md) — why (decision log, with rationale).
- [`harness/TESTING.md`](harness/TESTING.md) — the tiered/gated test strategy and cost model.
- [`harness/ROADMAP.md`](harness/ROADMAP.md) — the phased build plan and current milestone.
- [`harness/VISUAL-LOG.md`](harness/VISUAL-LOG.md) — real-browser peeks per UI slice (mocks can lie).

The spec is the source of truth. If code and spec disagree, fix one of them
deliberately and record it in `DECISIONS.md` — don't let them silently drift.

## Conventions

- **Runtime:** Node.js + TypeScript.
- **Minimize dependencies; no native binaries** (D-25). Prefer pure-JS/bundled packages so
  `npx jlcode` stays friction-free. Avoid native-binary deps (e.g. `better-sqlite3`); if a
  query store is ever needed, use `node:sqlite` (built-in) or `sql.js` (WASM).
- **Use `python3`, never `python`** when invoking Python (e.g. the `file_utils` MCP server).
- **Secrets never get committed.** OpenRouter keys live in the OS-level config
  store (see SPEC), not in the repo. `.gitignore` guards against stray `.env`s.
- **Sandbox everything file-touching** against the active workspace fence — one
  enforcement point, before any tool (native or MCP) touches disk.
- **Tests cost money.** Default runs are the free tiers (0+1) only. Before running any
  paid tier (2/3, live models), **ask Joshua which level to run** — unless the current task
  is specifically targeting that expensive model/feature. See [`harness/TESTING.md`](harness/TESTING.md).
- Match the surrounding code's style, naming, and comment density.

## Working discipline (read this every session)

These are automatic — don't wait to be reminded:

1. **Commit at every meaningful milestone.** Never pile epochs of work into the working
   tree uncommitted. A completed, tested unit → commit it. The working tree should rarely
   hold more than one focused change.
2. **Never commit red.** Build and run the free-tier tests (`npm run build && npm test`)
   before committing; only commit green. If a test **flakes**, root-cause it and fix it —
   don't shrug it off or commit through it. Leave a note for future-you if the cause is a hunch.
3. **Tests cost money.** Default runs are the free tiers (0+1). Before any paid tier
   (2/3, live models), **ask Joshua which level** — unless the task specifically targets that
   model/feature. See [`harness/TESTING.md`](harness/TESTING.md).
4. **Keep the harness current.** Update `ROADMAP.md`'s "Current status — resume here" block at
   each milestone so a lost session resumes cleanly. Record deliberate design changes in
   `DECISIONS.md`; don't let code and spec drift.
5. **Look at rendered surfaces in a real browser — at least once per UI slice.** Tests with more
   mocks than target code can pass while the real thing is broken or ugly. Chrome is installed;
   drive the built server with the fake driver and screenshot via CDP (recipe in `VISUAL-LOG.md`).
   Record each peek — what you confirmed with your own eyes + a screenshot — in
   [`harness/VISUAL-LOG.md`](harness/VISUAL-LOG.md). This complements tests, never replaces them.
6. **Watch context length; suggest a fresh thread at boundaries.** Caching discounts the stable
   prefix but the conversation still grows every turn (cost climbs, focus dulls). When the thread
   is long **and** you're at a natural boundary (a milestone committed, durable state in the
   harness), **proactively suggest Joshua start a new thread** — it resumes cleanly from the
   `ROADMAP.md` status + `DECISIONS.md`. This mirrors what we're building: once something is
   durably saved, it's safe to drop from the live context because it can be re-read later (see
   SPEC §15 durability-aware compaction / minimize-expand, X-08).

## Git

- This repo commits under the identity **Joshua Lansford <Joshua@lansfords.com>**
  (set locally). Claude manages commits per the discipline above: commit at meaningful
  milestones with clear messages. Do not push unless asked.

## Related project

- [`../file_utils`](../file_utils) — Joshua's Python MCP server for anchor-based
  editing of large files. JLCode will optionally consume it via MCP later; it is
  a specialist (surgical edits), not a general file layer. See SPEC → File access.
