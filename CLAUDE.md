# JLCode — Agent Operating Guide

JLCode is a **from-scratch coding agent** (a KiloCode replacement) built to be
simple to maintain, with per-client model configurations, its own OpenRouter
connection, and explicit Ask / Plan / Code modes.

**Before implementing anything, read the harness:**

- [`harness/SPEC.md`](harness/SPEC.md) — what we're building (functional spec).
- [`harness/ARCHITECTURE.md`](harness/ARCHITECTURE.md) — how it's built (technical design).
- [`harness/DECISIONS.md`](harness/DECISIONS.md) — why (decision log, with rationale).
- [`harness/ROADMAP.md`](harness/ROADMAP.md) — the phased build plan and current milestone.

The spec is the source of truth. If code and spec disagree, fix one of them
deliberately and record it in `DECISIONS.md` — don't let them silently drift.

## Conventions

- **Runtime:** Node.js + TypeScript.
- **Use `python3`, never `python`** when invoking Python (e.g. the `file_utils` MCP server).
- **Secrets never get committed.** OpenRouter keys live in the OS-level config
  store (see SPEC), not in the repo. `.gitignore` guards against stray `.env`s.
- **Sandbox everything file-touching** against the active workspace fence — one
  enforcement point, before any tool (native or MCP) touches disk.
- Match the surrounding code's style, naming, and comment density.

## Git

- This repo commits under the identity **Joshua Lansford <Joshua@lansfords.com>**
  (set locally). Claude manages commits: commit at meaningful milestones with
  clear messages. Do not push unless asked.

## Related project

- [`../file_utils`](../file_utils) — Joshua's Python MCP server for anchor-based
  editing of large files. JLCode will optionally consume it via MCP later; it is
  a specialist (surgical edits), not a general file layer. See SPEC → File access.
