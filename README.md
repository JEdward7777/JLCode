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

### Getting the *latest* code, not the first copy npx ever fetched

**npx caches by spec string, not by resolved commit.** `github:JEdward7777/JLCode`
keeps serving whatever it downloaded the first time, out of
`~/.npm/_npx/<hash>/node_modules/jlcode` — so a fix that is pushed is still not a
fix you are running. The reliable launch, and the one in daily use here, hands
npx a throwaway cache so it always resolves the current `main`:

```bash
npm_config_cache=$(mktemp -d) npx github:JEdward7777/JLCode serve
```

The trade is that every launch re-clones and rebuilds (tens of seconds) and
leaves a temp dir behind in `/tmp`. The alternatives are to clear the cache entry
by hand (`rm -rf ~/.npm/_npx/<hash>`) or to pin an exact revision, which is
worth doing when you want a *known* build rather than the newest one:

```bash
npx github:JEdward7777/JLCode#main serve     # branch, tag, or commit SHA
```

If you are working on JLCode itself, skip npx entirely and run the build
directly — no clone, no cache, no round trip:

```bash
node /path/to/JLCode/dist/cli.js serve
```

### On Windows

`VAR=value command` is POSIX shell syntax and does **not** work in PowerShell or
`cmd` — the variable has to be set as its own statement first. The throwaway-cache
launch above becomes:

```powershell
# PowerShell
$env:npm_config_cache = Join-Path $env:TEMP ("jlcode-" + [guid]::NewGuid())
npx github:JEdward7777/JLCode serve
```

```bat
:: cmd.exe
set "npm_config_cache=%TEMP%\jlcode-%RANDOM%"
npx github:JEdward7777/JLCode serve
```

npm creates the cache directory itself, so neither form needs to make it first.
Note that `$env:` / `set` persist for the rest of that shell session — open a new
shell (or set it back) when you want npm's normal cache again. The same pattern
applies to every other `VAR=1 npx …` line in this README, `JLCODE_FAKE_LLM=1`
included.

Two Windows differences worth knowing: config and data land under `%APPDATA%` and
`%LOCALAPPDATA%` rather than the XDG paths (see [Locations](#locations)), and the
`chmod 600` that protects `config.json` on POSIX has no real effect on Windows —
your OpenRouter key sits in a file with ordinary user permissions, so treat the
account it lives in as the security boundary.

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
stay tellable apart.

When a turn fails, **↻ Retry** sits on the error. A failed attempt writes nothing
to the thread, so retrying re-sends exactly what was sent before — go top up your
OpenRouter credits, come back, click it, and the answer lands under the message
you already sent, with no "continue" typed in to restart things. The same button
appears if a running request goes quiet for 20s: that one abandons the model
request only, leaving background commands and your queued messages alone (Stop is
still there for everything else). Blips you never see — a rate limit or a 5xx is
re-sent automatically, with the backoff shown as it happens.

Past threads are in the rail too, under **HISTORY** below the live ones — filtered
to the folder you're serving, with an *all folders* toggle. Clicking one **peeks**
at it: the transcript renders read-only from disk, with branch arrows to walk it,
while whatever was running keeps running behind you. Nothing is created by
looking — **typing is what picks the thread back up**, from the branch you're
looking at, and the card moves up into LIVE. That also means a browser tab left
open across a restart heals itself: the session it knew is gone, but the thread
is right there in the list. A past row takes the same ✎ to rename it and an ✕ to
drop it from the list; the ✕ only hides it — the conversation stays on disk, so
an oops is one hand-edited flag in `index.jsonl` away from coming back. Open a
session and never type in it and it doesn't join the list at all. Screenshots of
each slice are in [`harness/VISUAL-LOG.md`](harness/VISUAL-LOG.md).

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

**A busy port isn't fatal — for the default.** With no `--port`, `serve` walks
up from `4517` to the first free port (through `4526`, then any port the OS
offers) and prints where it actually landed, so a second instance in another
workspace just starts. A port you *asked* for is bound as asked: if `--port
4000` (or `$JLCODE_PORT`) is taken, `serve` says so and exits rather than
quietly answering somewhere else.

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
- Any OS Node runs on. Development and the visual checks happen on Linux, so the
  Windows paths above are written from the code's platform branches rather than
  from daily use — if something there is wrong, it is a bug worth reporting.

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

| Env | Default (Linux/macOS) | Default (Windows) | Holds |
|-----|-----------------------|-------------------|-------|
| `JLCODE_CONFIG_DIR` | `~/.config/jlcode` | `%APPDATA%\jlcode` | `config.json` (model configs, bindings, auth) |
| `JLCODE_DATA_DIR` | `~/.local/share/jlcode` | `%LOCALAPPDATA%\jlcode` | conversations + logs |
| `JLCODE_PORT` | `4517` | `4517` | `serve` port — set, it's binding (no scan-on-busy) |
| `JLCODE_LOG_LEVEL` | `info` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `JLCODE_FAKE_LLM` | unset | unset | `1` = offline echo driver, no spend |
| `JLCODE_FAKE_LLM_DELAY_MS` | `0` | `0` | ms between fake stream events, so a turn can be watched mid-flight |

The data dir also holds `models.json`, a cached copy of OpenRouter's model list
(refetched daily) — it is what tells JLCode how big each model's context window
is, and therefore when to compact. Delete it and it comes back on the next
`serve`.

`config.json` holds your OpenRouter keys and is written `chmod 600` — which is
real protection on Linux and macOS and effectively none on Windows, where the
file keeps ordinary user permissions.

## License

MIT.
