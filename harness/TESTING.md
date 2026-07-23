# JLCode — Testing Strategy

Status: **agreed** (2026-07-22). Goal: thorough coverage **without repeated LLM spend**.
The suite is **tiered** (free by default) and **gated** (expensive tiers run intentionally).

Framework: **Vitest** (TS-first, fast) — revisable.

---

## Cost model: a request-keyed LLM cache (not brittle static recordings)

Every model call made during tests goes through a cache **keyed by the full request
signature** — model id + messages + tools + sampling/reasoning params.

- **First** time a signature is seen: a real call is made and the response is stored.
- **Every run after:** free replay from the cache.
- **When our code changes the request** (different prompt, tools, params), the signature
  changes → **cache miss → one new real call**, then it's cached again.

That last property is the whole point: the cache **self-invalidates exactly when our side
changes**, so it never silently masks a behavior change — unlike a fixed recording that
could mismatch a changed request. "Pay once, free until we change something."

- Cached responses are committed as fixtures so CI and teammates replay for free.
- Refresh deliberately via a command (delete a key / `--refresh`).
- LLM output is nondeterministic: we freeze one sampled response per signature (fine for
  deterministic tests). Where output legitimately varies, assert **weak properties**
  (a tool call happened, no error, `reasoning_details` present) rather than exact text.

**Substrate (D-24):** the cache is **content-addressed, git-blob-style sharded files** —
`cache/ab/abcdef…json`, filename = the signature hash. O(1) point lookup, no index, no
startup scan, zero deps, no native binary. Test fixtures are committed to the repo.

> **Not the same as provider prompt caching (D-26).** This local cache stores *our whole
> responses* to avoid repeat calls. Provider prompt caching is a server-side input-token
> discount the OpenRouter client requests via `cache_control` breakpoints. Different caches,
> different jobs — don't conflate them.

## Tiers

| Tier | What | Model cost | When |
|------|------|-----------|------|
| **0 — Offline unit** | Pure logic, no model: sandbox path resolution, config store + folder binding, conversation tree (append/fork/rewind/`activeLeaf`/wire-assembly), compaction overlay, mode∩approval gate, editable-approval representation, SSE framing, OpenRouter request/response serialization. The bulk. | none | always |
| **1 — Cached model tests** | Real model behavior via the request-keyed cache: reasoning round-trip verbatim, redacted/Fable reasoning survival, tool-call parsing, streaming assembly. | pay-once, then free | always (CI) |
| **2 — Cheap live smoke** | End-to-end loop against a live endpoint. Driver = **minimax 2.5** (configurable). Weak assertions. | cheap | gated |
| **3 — Expensive model-targeted live** | Sharp edges aimed straight at **Opus 4.8 / Fable**: the Fable×compaction boundary (O-02), redacted-reasoning replay end-to-end. | expensive | gated, rare, **per-model** |

**Two different jobs:** the cache (Tiers 0–1) catches regressions in **our** code; the
periodic Tier-3 live runs catch **provider-side drift** — the exact rot that breaks KiloCode.
So Tier 3 gets run occasionally even when the cached tiers are green.

**Named must-pass tests — Fable-safety (D-28, D-38).** v1 uses the safe-harbor regime, so:
(a) **normal replay** round-trips `reasoning_details` (signature/encrypted/redacted)
**byte-identical** to what was stored (D-14) — cached Tier 1, live **Fable** Tier 3; and
(b) a **safe-harbor compaction** produces a request Fable accepts (no signed thinking carried
across the cut). The partial-keep "reasoning survives compaction" tests arrive with the
#2 fast-follow.

## LLM-as-judge

- A first-class helper to call a model as a **correctness judge** for semantic checks
  ("did the edit actually accomplish X?") where exact-match assertions don't fit.
- Judge calls go through the **same request-keyed cache** (prompt → verdict cached), so
  judging is pay-once too.
- Judge model is configurable (a mid/cheap model); judging is itself a gated cost.

## Gating & how we run

- **Default `npm test` = Tiers 0 + 1** (free) — run constantly, on every commit / in CI.
- **Live tiers (2, 3)** require an explicit flag **and** credentials present (e.g.
  `JLCODE_LIVE=1`), and are **selectable per target model** (run just Fable's, just Opus's).
  Nothing expensive ever fires by accident.
- CI: Tiers 0+1 on every push; Tiers 2/3 on manual dispatch or a schedule.

### Operational rule (for the agent running tests)

The tier levels are documented here as shared vocabulary ("run Tier 2", "run the Fable tier").
When about to run **anything beyond the free tiers**, **ask Joshua which level to run**, so
paid runs are intentional — **except** when the current task is *specifically* targeting an
expensive model/feature, in which case run that targeted tier directly (don't ask redundantly).

## Related: response caching as a product feature (to evaluate, not committed)

The same request-keyed caching could become a **runtime feature** to cut cost on repeated
calls. **Caveat (Fable / provider terms):** a cached runtime replay must still honor the
reasoning-replay rules (D-14) — never drop or reconstruct required reasoning — and must not
violate provider terms of service. Note Anthropic's **own prompt caching** is the sanctioned
mechanism for cheap input reuse (the safe lane); reusing whole responses is the lane that
needs care. Evaluate before shipping.
