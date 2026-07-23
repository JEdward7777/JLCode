# JLCode — Roadmap

Status: **placeholder.** The v1 build sequence is intentionally *not* laid out yet —
it depends on the architecture decisions still open in [`DECISIONS.md`](DECISIONS.md)
(§Open) / [`ARCHITECTURE.md`](ARCHITECTURE.md). We'll fill this in **with Joshua** once
those are settled, rather than pre-committing a plan.

## What's in v1 vs later

- **v1 scope:** see [`SPEC.md`](SPEC.md) §2 (Goals).
- **Deferred / non-goals:** see `SPEC.md` §3 and `DECISIONS.md` (Deferred table X-01..X-07).

## Rough phase sketch (tentative — not agreed)

A likely ordering, to be confirmed after the architecture discussion:

1. Skeleton: config store + model-config selection + OpenRouter client + minimal agent loop.
2. Native file tools + sandbox; shell tool; modes + approval gate.
3. HTTP frontend (markdown/mermaid/images) over the event bus; ask-user + approvals.
4. Persistence + resume + history filter; fork/rewind.
5. Compaction; diagnostics log; auth.
6. Later: notifications, MCP, remote/fleet view, browser testing, VS Code webview.

These steps are a starting point for discussion, not a plan of record.
