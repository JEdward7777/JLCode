# JLCode

A from-scratch coding agent (a KiloCode replacement) built to be simple to
maintain: per-client model configurations, its own OpenRouter connection, and
explicit **Ask / Plan / Code** modes.

The agent runs on the machine that holds your code; **you drive it from a
browser over HTTP** — see [How you drive it](#how-you-drive-it) below.

> **Status:** see the "Current status — resume here" block at the top of
> [`harness/ROADMAP.md`](harness/ROADMAP.md) — that block is the single source of
> truth for what is built, and it is updated at every milestone.

The design lives in [`harness/`](harness/) — start with
[`harness/SPEC.md`](harness/SPEC.md) (what), then
[`harness/ARCHITECTURE.md`](harness/ARCHITECTURE.md) (how) and
[`harness/DECISIONS.md`](harness/DECISIONS.md) (why). Agent operating notes are
in [`CLAUDE.md`](CLAUDE.md).

## Run it with npx

JLCode is **not on the npm registry**; install straight from this repo. npm
clones it, runs `prepare` (compiles TypeScript *and* builds the browser client),
then runs the `jlcode` bin:

```bash
npx github:JEdward7777/JLCode help
```

First-time setup — add a model config, bind this directory to it, then serve:

```bash
# The OpenRouter key is read from stdin (or $JLCODE_ADD_KEY) — never from argv.
npx github:JEdward7777/JLCode config add --name work --model anthropic/claude-sonnet-5
npx github:JEdward7777/JLCode config use work     # binds the current directory
npx github:JEdward7777/JLCode serve               # → http://127.0.0.1:4517
```

Then **open <http://127.0.0.1:4517/> in a browser** — that is the interface.

Pin a revision instead of tracking `main` with the usual git suffix
(`#main`, a tag, or a commit SHA):

```bash
npx github:JEdward7777/JLCode#main serve
```

To try it without spending money or configuring a key, use the built-in fake
echo driver:

```bash
JLCODE_FAKE_LLM=1 npx github:JEdward7777/JLCode serve
```

## How you drive it

**JLCode has no TUI and no editor plugin.** `jlcode serve` starts a local HTTP
server that hosts a pre-built React client and streams the conversation to it:

- **Down: SSE.** Tokens, reasoning, tool-call events, approval requests, spend
  updates and `ask_user` forms stream over `GET /events` (one multiplexed bus
  per instance, resumable via `Last-Event-ID`).
- **Up: POST.** Discrete actions — send a message, approve/deny/**edit** a tool
  call, answer a question, switch branch, change mode/approval. (D-18)

Because the transport is plain HTTP, *where the UI runs is your choice*: the
same machine, another machine on the LAN, or your phone through a reverse proxy.
The agent, the sandbox fence, and your files stay put.

What the browser gives you: streaming markdown chat with a reasoning
disclosure, a left rail of concurrent sessions, live Ask/Plan/Code + approval
controls, edit-before-approve on tool calls, out-of-fence prompts, whole-tree
spend with a settable cap, branch/rewind arrows with pencil edit-fork, a
per-turn debug-journal drawer, lazy-loaded Mermaid diagrams, and an MCP status
drawer. Every tool call leaves its result in the transcript — collapsed to the
tool, its arguments and a size hint, expandable to the full output — so you can
check the model's work instead of taking its summary on faith. An approval card
is also a chance to talk: anything you type in the composer while one is up rides
along with **Approve**/**Deny** and joins the transcript, so you can redirect the
run without waiting for the queue to drain at the next turn boundary. Each thread names
itself after the first exchange (rename it with the ✎ on its rail card), and the
tab title reads `<thread> — <project folder>`, so two instances in two projects
stay tellable apart. Screenshots of each slice are in
[`harness/VISUAL-LOG.md`](harness/VISUAL-LOG.md).

MCP tools pass the same gate and fence as native ones. JLCode can't take a
third-party server's word for what its tools do, so it assumes the worst — the
tool writes, a slashy argument is a path — and when one of those guesses is what
made it stop, the approval card asks you to settle it (*does this tool write?*,
*is this field a path?*). The answers are written back into your
`mcp_settings.json`, so each question is asked once. If your approval policy
would have let the call run unattended, nothing is asked (D-48).

### Serving scope and auth

The bind address declares the exposure, and auth follows from it (D-40):

```bash
jlcode serve                                  # 127.0.0.1 — loopback, no password
jlcode serve --host 0.0.0.0 --generate-password   # outward — password required
```

A loopback bind is auth-free so local development needs no ceremony. A
non-loopback bind **requires** a password, provisioned one of three ways:
`--generate-password` (makes and prints one), `--password-prompt` (typed
interactively, off argv), or `--password <pw>` (discouraged). The password is
stored hashed; sessions use an httpOnly signed cookie that survives a restart.
A single-use sign-in URL is always printed so the first login is one click.

Other flags: `--port <n>` (default `4517`, or `$JLCODE_PORT`) and
`--config <name>` to pin a config regardless of the directory binding.

### Talking to it without a browser

The same server is a plain JSON API — handy for scripts and for driving tests:

```bash
curl -s     http://127.0.0.1:4517/health
curl -s     http://127.0.0.1:4517/chat -H 'content-type: application/json' -d '{"text":"hello"}'
# reuse the returned sessionId to continue the thread:
curl -s     http://127.0.0.1:4517/chat -H 'content-type: application/json' -d '{"text":"and again","sessionId":"<id>"}'
curl -s     http://127.0.0.1:4517/conversation/<id>/journal   # the verbose debug record
curl -sX POST http://127.0.0.1:4517/shutdown                  # stop the server
```

There is also `jlcode chat`, a terminal REPL against the selected config. It is
a thin conversation harness — **the tool loop is server-side only**, so use
`serve` for real work.

## Commands

```
info, paths     Resolve and create the config/data dirs, then print them
config …        Manage model configurations (list/which/use/clone/add/set/remove)
mcp …           MCP servers (list/import/path) — reads KiloCode's mcp_settings format
chat            Terminal conversation with the selected config (no tools)
serve           Start the HTTP server + browser client
version         Print the version
help            Show this help
```

## Requirements

- Node.js **≥ 20** (developed on 24).

## Develop

```bash
npm install       # install the toolchain (TypeScript, Vite, Vitest)
npm run build     # compile src → dist  and  web → dist/web
npm test          # Tier-0/1 tests (offline, free)
npm run typecheck # type-check without emitting
npm start -- info # run the local build
```

Tests are tiered by cost — the default run is free and offline. Paid tiers hit
live models; see [`harness/TESTING.md`](harness/TESTING.md) before running them.

## Locations

JLCode keeps nothing in your project. Config and data live in OS-level stores,
overridable by env:

| Env | Default (Linux) | Holds |
|-----|-----------------|-------|
| `JLCODE_CONFIG_DIR` | `~/.config/jlcode` | `config.json` (model configs, bindings, auth) |
| `JLCODE_DATA_DIR` | `~/.local/share/jlcode` | conversations + logs |
| `JLCODE_PORT` | `4517` | default `serve` port |
| `JLCODE_LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `JLCODE_FAKE_LLM` | unset | `1` = offline echo driver, no spend |

`config.json` holds your OpenRouter keys and is written `chmod 600`.

## License

MIT.
