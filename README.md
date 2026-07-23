# JLCode

A from-scratch coding agent (a KiloCode replacement) built to be simple to
maintain: per-client model configurations, its own OpenRouter connection, and
explicit **Ask / Plan / Code** modes.

The design lives in [`harness/`](harness/) — start with
[`harness/SPEC.md`](harness/SPEC.md). Agent operating notes are in
[`CLAUDE.md`](CLAUDE.md).

> **Status:** Phase 0 (scaffold). See [`harness/ROADMAP.md`](harness/ROADMAP.md).

## Requirements

- Node.js **≥ 20** (developed on 24). No native-binary dependencies (D-25).

## Develop

```bash
npm install       # install dev toolchain (TypeScript, Vitest)
npm run build     # compile src → dist
npm test          # Tier-0 tests (offline, free)
npm run typecheck # type-check without emitting
```

## Run

```bash
npm start -- info      # resolve + print the config/data dirs
node dist/cli.js info  # same, directly
```

Once published this runs via `npx jlcode` without a global install (D-22).

### Locations

JLCode keeps nothing in your project. Config and data live in OS-level stores,
overridable by env:

| Env | Default (Linux) | Holds |
|-----|-----------------|-------|
| `JLCODE_CONFIG_DIR` | `~/.config/jlcode` | `config.json` (model configs, bindings) |
| `JLCODE_DATA_DIR` | `~/.local/share/jlcode` | conversations + logs |
| `JLCODE_LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
