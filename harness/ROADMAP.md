# JLCode — Roadmap

Status: **ready to firm up.** The load-bearing architecture is now settled
([`DECISIONS.md`](DECISIONS.md) D-13…D-22; only O-02 deferred to build time), so the phase
plan below can move from sketch to an agreed sequence. Next session: confirm the ordering
with Joshua and start building the skeleton.

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
