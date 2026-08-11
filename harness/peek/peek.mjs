#!/usr/bin/env node
/**
 * `peek` — drive the built browser client for a real-browser look (CLAUDE.md
 * discipline #5, VISUAL-LOG.md).
 *
 * The recipe used to live only as prose in VISUAL-LOG.md, so every slice
 * hand-rebuilt the same three throwaway scripts: write an isolated config, start
 * `serve` under the fake driver, screenshot over CDP. This is that recipe as a
 * tool. Nothing here is shipped — `package.json` publishes `dist` only.
 *
 * No new dependencies (D-45 is about *runtime* deps carrying their weight; this
 * is a dev script and Node already has everything it needs): global `fetch` and
 * global `WebSocket`, which is why it wants Node 22+.
 *
 *   node harness/peek/peek.mjs up --ctx 4000 --buffer 1000 --trigger suggest
 *   node harness/peek/peek.mjs chat "hello there"
 *   node harness/peek/peek.mjs shot x24-normal --crop topbar
 *   node harness/peek/peek.mjs click ".tool-head" --shot x23-expanded
 *   node harness/peek/peek.mjs state
 *   node harness/peek/peek.mjs down
 *
 * `shot` writes straight into `harness/visual/`, since a peek that isn't
 * recorded may as well not have happened.
 *
 * ## Two peeks at once — `JLCODE_PEEK_PORT`
 *
 * Everything transient is keyed by the server port, so a second peek on a second
 * port is a second *instance*: its own state file, config, data, chrome profile
 * and pids under `/tmp/jlcode-peek-<port>/`. `down` therefore only ever tears
 * down the instance you named — which is what makes two agents peeking side by
 * side safe.
 *
 *   JLCODE_PEEK_PORT=7811 JLCODE_PEEK_CDP_PORT=9421 node harness/peek/peek.mjs up
 *
 * ## `click` — the mouse, because some surfaces need one
 *
 * Hover-revealed affordances and collapsed blocks can't be reached by `shot`
 * alone; two slices (X-12b, X-23) hand-rolled the same CDP mouse dance before
 * this existed. Steps run in order in **one** invocation — peek opens its tab
 * per command and closes it after, so a hover in one process is gone by the next
 * — and `--shot` captures the result of the sequence:
 *
 *   node harness/peek/peek.mjs click "hover:.rail-item.history@1" \
 *        ".rail-item.history .rail-close@1" ".rail-confirm-actions .danger" \
 *        --shot x12b-deleted --crop rail
 *
 * A step is `[hover:]<css selector>[@n]`, where `@n` picks from that selector's
 * own matches and so goes at the end. A step that matches nothing, matches
 * several, isn't rendered, or is covered by something else is an **error**,
 * never a shrug: the failure this must not have is a screenshot of a page that
 * never changed.
 *
 * ## `--attach` — screenshot the browser *you* are looking at
 *
 * The opposite default, and deliberately opt-in per command (Joshua's call,
 * 2026-08-06): with `--attach`, peek drives the user's own browser instead of a
 * throwaway one, so "grab what's on my screen" is possible but can never happen
 * by accident. It **navigates nothing and resizes nothing** — it captures the
 * tab as-is — opens no tab and closes none, and records no pid, so `down` can
 * never kill it.
 *
 *   google-chrome --remote-debugging-port=9222      # the user starts this
 *   node harness/peek/peek.mjs tabs --attach        # what's open
 *   node harness/peek/peek.mjs shot look --attach --tab 2
 *
 * Attach captures land in the scratch dir, not `harness/visual/` — they are
 * ad-hoc, may contain anything on screen, and must not drift into a commit.
 * A browser that was already running cannot be opted in after the fact: the flag
 * is only read at startup.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const VISUAL_DIR = path.join(REPO, "harness", "visual");

/** The server port, and with it the identity of a peek *instance*. Overridable
 *  because two peeks have to be able to coexist — two agents on one machine, or
 *  a second look while the first is still posed — and a hardcoded port made that
 *  impossible. Same shape as `JLCODE_PEEK_CDP_PORT` below. */
const PORT = Number(process.env.JLCODE_PEEK_PORT ?? 7801);
/** Everything transient (config, data, chrome profile, pids) lives here, so a
 *  peek never touches the real `~/.config/jlcode` or the user's browser — and it
 *  is **keyed by the port**, so a second instance gets its own state file rather
 *  than adopting (and then `down`-ing) the first one's server and browser. */
const RUN_DIR = path.join(os.tmpdir(), `jlcode-peek-${PORT}`);
const STATE_FILE = path.join(RUN_DIR, "peek.json");

/** Deliberately *not* Chrome's conventional 9222: that is the port a person is
 *  most likely to have their own debuggable browser on, and the one collision we
 *  must never quietly win. Overridable for a genuine clash. */
const CDP_PORT = Number(process.env.JLCODE_PEEK_CDP_PORT ?? 9411);
/** Where `--attach` looks by default — the conventional port, because in that
 *  mode the *user's* browser is the whole point. */
const ATTACH_PORT = Number(process.env.JLCODE_PEEK_ATTACH_PORT ?? 9222);

/** Which CDP port a command talks to. Attach mode goes to the user's browser;
 *  everything else to the throwaway one we launch. */
const portFor = (flags) => Number(flags.port ?? (flags.attach ? ATTACH_PORT : CDP_PORT));

/** Crops worth naming, as [x, y, w, h] against a 2800x1800 (2x of 1400x900)
 *  shot. A full-page screenshot is the honest record; a crop is what makes a
 *  chip-sized detail actually legible in the log. */
const CROPS = {
  topbar: [700, 20, 1500, 120],
  rail: [0, 0, 620, 1000],
};

const VIEWPORT = { width: 1400, height: 900, scale: 2 };

// --------------------------------------------------------------------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A flag with no value after it (or followed by another flag) is a boolean —
    // including when it is the last argument, which is the common case for
    // `--attach` and is worth not getting wrong.
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      flags[a.slice(2)] = next === undefined || next.startsWith("--") ? true : argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a URL until it answers, so we never race a still-booting process. */
async function waitFor(url, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`${label} did not come up within ${timeoutMs}ms`);
}

// --------------------------------------------------------------------------

/** An isolated config with exactly the compaction knobs a peek wants to pose.
 *  `contextLength`/`bufferTokens` are the two dials that decide what the
 *  compaction surfaces (and X-24's meter) actually show, so they are flags. */
function writeConfig({ cfgDir, workDir, ctx, buffer, trigger, model, mcp }) {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const config = {
    version: 1,
    modelConfigs: [
      {
        id: "cfg_peek",
        name: "Peek",
        openRouterKey: "sk-fake",
        model,
        defaultMode: "code",
        defaultApproval: "manual",
        // Fallback pricing so the spend chip has something to show (D-33);
        // the fake driver reports no authoritative cost.
        pricing: { promptPerMTok: 3, completionPerMTok: 15 },
        compaction: {
          auto: false,
          triggerModes: [trigger],
          ...(ctx ? { contextLength: Number(ctx) } : {}),
          ...(buffer ? { bufferTokens: Number(buffer) } : {}),
        },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
    folderBindings: { [workDir]: "cfg_peek" },
    autoSafeAllowlist: [],
  };
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify(config, null, 2));
  // `--mcp <file>`: an `mcp_settings.json` copied in *before* the server starts,
  // because MCP children are spawned ahead of the listen (D-47e) — writing it
  // afterwards is too late. Without this the MCP surfaces (the status drawer,
  // learn-on-pause, H-08's fence note) cannot be peeked at all, which is why
  // they never had been.
  if (mcp) {
    const from = path.resolve(mcp);
    if (!fs.existsSync(from)) throw new Error(`--mcp: no such file: ${from}`);
    fs.copyFileSync(from, path.join(cfgDir, "mcp_settings.json"));
  }
}

/** Is a peek server already answering on our port, and is it *ours*? The same
 *  question `ensureChrome` asks of the CDP port, for the same reason: a listener
 *  we did not start belongs to someone else — another agent's peek, most likely
 *  — and taking it over (or shutting it down) breaks their run silently. */
async function serverOnPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function cmdUp(flags) {
  const state = readState();
  if (await serverOnPort(PORT)) {
    if (!(state.serverPid && isAlive(state.serverPid))) {
      throw new Error(
        `something is already serving on port ${PORT} and this tool did not start it.\n` +
          `  Refusing to shut it down — it is most likely another peek (or another agent's).\n` +
          `  Run yours somewhere else: JLCODE_PEEK_PORT=<port> JLCODE_PEEK_CDP_PORT=<port> peek up`,
      );
    }
  }
  await cmdDown({ quiet: true }); // never stack two servers on the port

  const cfgDir = path.join(RUN_DIR, "config");
  const dataDir = path.join(RUN_DIR, "data");
  const workDir = path.join(RUN_DIR, "work");
  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });

  // An unlisted model id by default: the catalog lookup misses, so the window
  // comes from this config and no network fetch is attempted (H-06/D-60).
  const model = flags.model ?? "peek/model";
  const trigger = flags.trigger ?? "suggest";
  writeConfig({ cfgDir, workDir, ctx: flags.ctx, buffer: flags.buffer, trigger, model, mcp: flags.mcp });

  const cli = path.join(REPO, "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error(`no build at ${cli} — run \`npm run build\` first`);

  const log = fs.openSync(path.join(RUN_DIR, "serve.log"), "w");
  const server = spawn(process.execPath, [cli, "serve", "--port", String(PORT)], {
    cwd: workDir,
    env: {
      ...process.env,
      JLCODE_CONFIG_DIR: cfgDir,
      JLCODE_DATA_DIR: dataDir,
      JLCODE_FAKE_LLM: "1", // offline echo/agent driver — no key, no spend
      // Streaming surfaces can't be screenshotted if a turn settles instantly.
      ...(flags.delay ? { JLCODE_FAKE_LLM_DELAY_MS: String(flags.delay) } : {}),
    },
    detached: true,
    stdio: ["ignore", log, log],
  });
  server.unref();

  await waitFor(`http://127.0.0.1:${PORT}/health`, "server");
  writeState({ serverPid: server.pid, port: PORT, cfgDir, dataDir, workDir, session: null });
  process.stdout.write(fs.readFileSync(path.join(RUN_DIR, "serve.log"), "utf8"));
  console.log(`\npeek: server up on http://127.0.0.1:${PORT} (pid ${server.pid})`);
}

/** Chrome is started lazily by `shot` and reused across shots.
 *
 *  **Only ever a browser we launched.** A CDP port that is already answering is
 *  not necessarily ours — attaching to someone's real browser would mean driving
 *  a profile with their cookies and sessions in it, and `Page.navigate` would
 *  yank a tab they were using. So a live port is reused *only* when it is the
 *  process we recorded in the state file; anything else is refused loudly rather
 *  than adopted. The profile we do launch is a throwaway under `RUN_DIR`: no
 *  cookies, no history, no extensions, nothing but the local peek server. */
async function ensureChrome(flags = {}) {
  const port = portFor(flags);
  const state = readState();
  let portInUse = false;
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`);
    portInUse = true;
  } catch {
    /* free */
  }

  // `--attach`: drive the browser the *user* is already looking at, on purpose.
  // The inverse of the guard below, and it must stay an explicit per-command
  // flag — never sticky, never a fallback — because it is the one mode that can
  // see real cookies, real tabs, real private content. Nothing is launched and
  // no pid is recorded, so `down` can never kill their browser.
  if (flags.attach) {
    if (!portInUse) {
      throw new Error(
        `--attach: nothing is listening on CDP port ${port}.\n` +
          `  Your browser needs to have been *started* with remote debugging on:\n` +
          `    google-chrome --remote-debugging-port=${port}\n` +
          `  Note an already-running Chrome can't be opted in after the fact — that command\n` +
          `  just opens a window in the existing process and the flag is ignored. Quit Chrome\n` +
          `  first, or start a separate profile with --user-data-dir=<dir>.`,
      );
    }
    return;
  }

  if (portInUse) {
    if (state.chromePid && isAlive(state.chromePid)) return; // ours, from an earlier shot
    throw new Error(
      `something is already listening on CDP port ${port} and it is not a browser this tool started.\n` +
        `  Refusing to attach — that could be your real Chrome, with your cookies and open tabs.\n` +
        `  If driving your own browser is what you want, say so explicitly: --attach\n` +
        `  Otherwise close it, or point this run elsewhere with JLCODE_PEEK_CDP_PORT=<port>.`,
    );
  }
  const profile = path.join(RUN_DIR, "chrome");
  const bin = ["google-chrome", "google-chrome-stable", "chromium", "/opt/google/chrome/chrome"].find((b) =>
    b.startsWith("/") ? fs.existsSync(b) : true,
  );
  const log = fs.openSync(path.join(RUN_DIR, "chrome.log"), "w");
  const chrome = spawn(
    bin,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--disable-gpu",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  chrome.unref();
  await waitFor(`http://127.0.0.1:${port}/json/version`, "chrome");
  writeState({ chromePid: chrome.pid });
}

/** A minimal CDP client. Chrome's `--virtual-time-budget` screenshot stalls on
 *  the long-lived SSE connection the client holds open, so we drive a real page
 *  and wait a real moment instead.
 *
 *  Opens its **own** tab (`/json/new`) rather than taking whichever page happens
 *  to be first in the target list, and closes it after — belt to `ensureChrome`'s
 *  braces, so even a mistakenly-shared browser never has a tab navigated out from
 *  under its user. */
async function cdp(flags = {}) {
  const port = portFor(flags);
  // Attach mode uses a tab that is already open — creating one would pop a
  // window in the user's face, and closing one afterwards could take a tab they
  // wanted. Otherwise: our own fresh tab, closed after.
  const target = flags.attach ? await pickTab(port, flags.tab) : await newTab(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej, method } = pending.get(d.id);
      // A CDP command that failed used to resolve `undefined` and read as a
      // silent no-op two steps later; `click` cannot afford that.
      d.error ? rej(new Error(`CDP ${method}: ${d.error.message ?? JSON.stringify(d.error)}`)) : res(d.result);
      pending.delete(d.id);
    }
  };
  // A browser that dies mid-command (they do: OOM, a crashed renderer) simply
  // stops answering, and an un-answered `await` is a hang with no message at
  // all — the worst failure a peek can have, because it looks like a slow one.
  // So: every pending call is failed when the socket goes, and every call has a
  // deadline of its own.
  const failAll = (why) => {
    for (const [i, p] of pending) {
      p.rej(new Error(`CDP ${p.method}: ${why}`));
      pending.delete(i);
    }
  };
  ws.onclose = () => failAll("the browser closed the connection (did Chrome die? see the chrome.log in the run dir)");
  ws.onerror = () => failAll("the CDP connection errored");
  await new Promise((r) => (ws.onopen = r));
  const budget = Number(flags["cdp-timeout"] ?? 20000);
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => {
        if (pending.delete(i)) rej(new Error(`CDP ${method}: no answer in ${budget}ms`));
      }, budget);
      pending.set(i, { res: (v) => (clearTimeout(timer), res(v)), rej: (e) => (clearTimeout(timer), rej(e)), method });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return {
    send,
    target,
    close: async () => {
      ws.close();
      // Only ever tidy up a tab we opened.
      if (!flags.attach) await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, { signal: AbortSignal.timeout(10000) }).catch(() => {});
    },
  };
}

/** Our own blank tab in our own browser. */
async function newTab(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(10000) })).json();
}

/** List the user's open page tabs (attach mode). */
async function listTabs(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  return list.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
}

/** Choose which of the user's tabs to capture. `--tab` takes an index from
 *  `peek tabs`, or a substring matched against title/URL. With one tab open the
 *  choice is obvious; with several, ambiguity is an error rather than a guess —
 *  silently screenshotting the wrong window is the failure that matters here. */
async function pickTab(port, selector) {
  const tabs = await listTabs(port);
  if (tabs.length === 0) throw new Error("--attach: that browser has no open page tabs.");
  if (selector === undefined || selector === true) {
    if (tabs.length === 1) return tabs[0];
    throw new Error(
      `--attach: ${tabs.length} tabs are open — say which with --tab <n|substring>:\n` +
        tabs.map((t, i) => `    ${i}  ${t.title}  —  ${t.url}`).join("\n"),
    );
  }
  if (/^\d+$/.test(String(selector))) {
    const t = tabs[Number(selector)];
    if (!t) throw new Error(`--attach: no tab #${selector} (${tabs.length} open)`);
    return t;
  }
  const needle = String(selector).toLowerCase();
  const hits = tabs.filter((t) => `${t.title} ${t.url}`.toLowerCase().includes(needle));
  if (hits.length === 0) throw new Error(`--attach: no tab matching "${selector}"`);
  if (hits.length > 1) {
    throw new Error(
      `--attach: "${selector}" matches ${hits.length} tabs — be more specific:\n` +
        hits.map((t) => `    ${t.title}  —  ${t.url}`).join("\n"),
    );
  }
  return hits[0];
}

/** `peek tabs --attach` — what's open in the user's browser, so `--tab` has
 *  something to name. Read-only: it navigates nothing and captures nothing. */
async function cmdTabs(flags) {
  if (!flags.attach) throw new Error("usage: peek tabs --attach   (lists tabs in YOUR browser; requires --attach)");
  await ensureChrome(flags);
  const tabs = await listTabs(portFor(flags));
  if (tabs.length === 0) return console.log("peek: no open page tabs");
  tabs.forEach((t, i) => console.log(`${i}  ${t.title}\n   ${t.url}`));
}

/** Is a pid we recorded still running? `signal 0` tests without signalling. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Open the page a command works on: our own tab at the peek server (posed to
 *  the session we are following), or — under `--attach` — the user's tab exactly
 *  as it is. Shared by `shot` and `click`, which is also *why* clicking and
 *  shooting compose in one invocation: the tab is per-invocation. */
async function openPage(flags) {
  await ensureChrome(flags);
  const state = readState();
  const session = flags.session ?? state.session;
  const page = await cdp(flags);
  await page.send("Page.enable");

  if (flags.attach) {
    // Capture what the user is actually looking at: no navigate (that would yank
    // their page), no metrics override (that would visibly resize it). Their
    // window is the viewport, whatever size it happens to be.
    console.log(`peek: on YOUR tab — ${page.target.title} (${page.target.url})`);
  } else {
    const url = flags.url ?? `http://127.0.0.1:${state.port ?? PORT}/${session ? `?session=${session}` : ""}`;
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.scale,
      mobile: false,
    });
    await page.send("Page.navigate", { url });
  }
  await sleep(Number(flags.wait ?? (flags.attach ? 250 : 2500))); // SSE connect + first render
  return page;
}

async function cmdShot(name, flags) {
  if (!name) throw new Error("usage: peek shot <name> [--session id] [--url u] [--crop topbar] [--wait ms] [--attach [--tab n]]");
  const { send, close } = await openPage(flags);
  await capture(send, name, flags);
  await close();
}

/** Screenshot the page as it now stands and write it where it belongs. */
async function capture(send, name, flags) {
  const clip = flags.crop
    ? (() => {
        // Named crops are measured against our own 2x viewport, so they mean
        // nothing in someone else's window — there, a crop must be explicit
        // CSS pixels.
        if (flags.attach && CROPS[flags.crop]) {
          throw new Error(`--attach: the named crop "${flags.crop}" is measured against peek's own viewport. Give x,y,w,h instead.`);
        }
        const c = CROPS[flags.crop] ?? String(flags.crop).split(",").map(Number);
        if (!c || c.length !== 4 || c.some((n) => !Number.isFinite(n))) {
          throw new Error(`unknown crop: ${flags.crop} (try: ${Object.keys(CROPS).join(", ")} or x,y,w,h)`);
        }
        const s = flags.attach ? 1 : VIEWPORT.scale; // clip is in CSS pixels
        return { x: c[0] / s, y: c[1] / s, width: c[2] / s, height: c[3] / s, scale: 1 };
      })()
    : undefined;

  // A freshly-launched headless Chrome answers the first `captureScreenshot`
  // with a bare `Internal error` now and then — the renderer isn't ready and the
  // frame doesn't exist yet. Seen once here, on the first shot of a second peek
  // started while the first was busy. Capturing is idempotent, so retry rather
  // than fail the run; a *persistent* failure still throws, loudly and named.
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) }));
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(500);
    }
  }
  // A peek of JLCode belongs in the visual log; a capture of the user's own
  // screen does not — it is ad-hoc, may hold anything, and must not drift into
  // a commit. Those land in the scratch dir unless a path is asked for.
  const dir = flags.out ? path.dirname(path.resolve(flags.out)) : flags.attach ? RUN_DIR : VISUAL_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const out = flags.out ? path.resolve(flags.out) : path.join(dir, name.endsWith(".png") ? name : `${name}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`peek: wrote ${out.startsWith(REPO) ? path.relative(REPO, out) : out}`);
}

// ---------------------------------------------------------------- `click` ---
//
// Some surfaces only exist under a mouse: X-12b's ✕ is `opacity: 0` until its
// row is hovered and its confirm is a click deeper, X-23's tool block starts
// collapsed. Both slices hand-rolled the same throwaway CDP script; this is it,
// once, with the failure modes made loud.

/** Names a match in an error message. Which of the four `.rail-close`es you
 *  actually addressed is a question only the text around it can answer. */
const DESCRIBE_JS = `((el) => {
  if (!el) return "nothing";
  const raw = typeof el.className === "string" ? el.className : "";
  const cls = raw.trim() ? raw.trim().split(/\\s+/).slice(0, 3).map((c) => "." + c).join("") : "";
  const text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 48);
  return el.tagName.toLowerCase() + cls + (text ? ' "' + text + '"' : "");
})`;

async function evalJs(send, expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`in-page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

/** What a selector matches right now, each match named and measured. */
const probe = (send, sel) =>
  evalJs(
    send,
    `(() => {
      const describe = ${DESCRIBE_JS};
      let els;
      try { els = Array.from(document.querySelectorAll(${JSON.stringify(sel)})); }
      catch (e) { return { invalid: String(e.message), matches: [] }; }
      return { url: location.href, matches: els.map((el) => {
        const r = el.getBoundingClientRect();
        // The parent's text is what tells three identical ✕ buttons apart.
        return { label: describe(el), where: describe(el.parentElement), w: r.width, h: r.height };
      }) };
    })()`,
  );

/** Scroll the chosen match into view and return the point to aim at — plus
 *  whether something else is on top of that point, because a click that lands on
 *  an overlay is exactly the silent no-op this command exists to prevent. */
const aim = (send, sel, i) =>
  evalJs(
    send,
    `(() => {
      const describe = ${DESCRIBE_JS};
      const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}];
      if (!el) return { gone: true };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { x, y, w: r.width, h: r.height, label: describe(el),
               covered: !top || !(el.contains(top) || top.contains(el)), cover: describe(top) };
    })()`,
  );

/** A cheap fingerprint of the rendered DOM, so "the click changed nothing" can
 *  be *said* rather than silently screenshotted. */
const domFingerprint = (send) =>
  evalJs(
    send,
    `(() => { const s = document.body ? document.body.innerHTML : "";
      let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      return h + ":" + s.length; })()`,
  );

/** A step is `[hover:]<css selector>[@n]`. Hover is a *step*, not a verb of its
 *  own: peek opens its tab per invocation and closes it after, so a hover in one
 *  process is already gone by the time a second one starts. `@n` is peek's own
 *  index suffix (a CSS selector never contains `@`) — the explicit answer to an
 *  ambiguous match, in the same spirit as `--tab`. */
function parseStep(raw) {
  const hover = String(raw).startsWith("hover:");
  const body = hover ? String(raw).slice(6) : String(raw);
  const m = /^(.*?)@(\d+)$/.exec(body.trim());
  const sel = (m ? m[1] : body).trim();
  if (sel.includes("@")) {
    // `@n` indexes the whole selector's match list, so it can only go at the
    // end. To reach *inside* one of several containers, index the leaf
    // (`.rail-item.history .rail-close@1`) or scope it in CSS (`:nth-of-type`).
    throw new Error(
      `"${raw}": the @n index goes at the *end* of a selector — it picks from that selector's own matches.\n` +
        `  To act inside the nth container, index the leaf instead: ".rail-item.history .rail-close@1"\n` +
        `  or scope it in CSS: ".rail-item.history:nth-of-type(2) .rail-close"`,
    );
  }
  return { hover, raw: String(raw), sel, index: m ? Number(m[2]) : null };
}

async function runStep(send, step, flags) {
  const timeout = Number(flags.timeout ?? 3000);
  const deadline = Date.now() + timeout;
  let found;
  for (;;) {
    found = await probe(send, step.sel);
    if (found.invalid) throw new Error(`not a usable selector: ${step.sel}\n  ${found.invalid}`);
    if (found.matches.length > 0) break;
    if (Date.now() > deadline) {
      throw new Error(
        `nothing matches "${step.sel}" — waited ${timeout}ms, and nothing was clicked (${found.url}).\n` +
          `  If the page needed longer to render: --wait <ms> (before the first step) or --timeout <ms>.\n` +
          `  If the element only appears under the cursor: put a "hover:<selector>" step in front of it.`,
      );
    }
    await sleep(100);
  }

  // Several matches with no index is an error, not a guess at the first one:
  // clicking the wrong ✕ deletes the wrong thread, and the screenshot looks fine.
  if (found.matches.length > 1 && step.index === null) {
    throw new Error(
      `"${step.sel}" matches ${found.matches.length} elements — say which with @n (e.g. "${step.sel}@0"), or narrow the selector:\n` +
        found.matches.map((m, i) => `    ${i}  ${m.label}   in ${m.where}`).join("\n"),
    );
  }
  const i = step.index ?? 0;
  if (!found.matches[i]) {
    throw new Error(`"${step.sel}@${i}" — there are only ${found.matches.length} matches (0…${found.matches.length - 1}).`);
  }

  await aim(send, step.sel, i);
  await sleep(120); // let the scroll land before measuring where the thing ended up
  const spot = await aim(send, step.sel, i);
  const verb = step.hover ? "hover" : "click";
  if (spot.gone) throw new Error(`"${step.sel}@${i}" left the page between finding it and ${verb}ing it.`);
  if (!(spot.w > 0 && spot.h > 0)) {
    throw new Error(
      `${spot.label} matches "${step.sel}" but is ${spot.w}×${spot.h} — it is not rendered, so there is nothing to ${verb}.\n` +
        `  Hidden until hovered? Put a "hover:<selector>" step in front of it.`,
    );
  }
  if (spot.covered) {
    throw new Error(
      `${spot.label} is covered by ${spot.cover} at its centre — a ${verb} there would land on that instead.\n` +
        `  Dismiss the overlay first, or address the element that is actually on top.`,
    );
  }

  const at = { x: spot.x, y: spot.y };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, buttons: 0 });
  if (!step.hover) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 });
  }
  console.log(`peek: ${verb} ${spot.label}  @ ${Math.round(spot.x)},${Math.round(spot.y)}`);
}

async function cmdClick(steps, flags) {
  if (steps.length === 0) {
    throw new Error(
      'usage: peek click "[hover:]<selector>[@n]" ["<selector>" …] [--shot <name> [--crop c]] [--wait ms] [--settle ms] [--timeout ms]',
    );
  }
  if (flags.shot === true) throw new Error("--shot needs a name: --shot x23-expanded");
  const parsed = steps.map(parseStep);
  const { send, close } = await openPage(flags);
  try {
    const before = await domFingerprint(send);
    let clicked = false;
    for (const step of parsed) {
      await runStep(send, step, flags);
      clicked ||= !step.hover;
      await sleep(Number(flags.settle ?? 300)); // the render the click caused
    }
    if (flags.shot) {
      // A hover changes CSS only, so silence is expected there; a click that
      // left the DOM byte-identical is worth saying out loud before the shot.
      if (clicked && (await domFingerprint(send)) === before) {
        console.log("peek: warning — the DOM is identical to before the click; this shot may prove nothing.");
      }
      await capture(send, String(flags.shot), flags);
    }
  } finally {
    await close();
  }
}

// -----------------------------------------------------------------------------

/** Send a turn through the fake driver, remembering the session so subsequent
 *  `chat`/`shot`/`state` calls continue the same thread without repeating an id. */
async function cmdChat(text, flags) {
  if (!text) throw new Error('usage: peek chat "<message>" [--session id]');
  const state = readState();
  const session = flags.session ?? state.session;
  const res = await fetch(`http://127.0.0.1:${state.port ?? PORT}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...(session ? { sessionId: session } : {}) }),
  });
  const body = await res.json();
  writeState({ session: body.sessionId });
  console.log(summarize(body));
}

async function cmdNewSession() {
  const state = readState();
  const res = await fetch(`http://127.0.0.1:${state.port ?? PORT}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = await res.json();
  writeState({ session: body.sessionId });
  console.log(`peek: session ${body.sessionId}`);
}

async function cmdState(flags) {
  const state = readState();
  const session = flags.session ?? state.session;
  if (!session) throw new Error("no session yet — run `peek chat` or `peek new` first");
  const res = await fetch(`http://127.0.0.1:${state.port ?? PORT}/session/${session}/state`);
  console.log(summarize(await res.json()));
}

/** The fields a peek is usually checking, without the whole entry tree. */
function summarize(s) {
  const keep = [
    "sessionId",
    "status",
    "mode",
    "approval",
    "spendUsd",
    "triggerMode",
    "needsCompaction",
    "contextTokens",
    "contextWindow",
    "contextThreshold",
    "contextWindowSource",
  ];
  return JSON.stringify(Object.fromEntries(keep.filter((k) => k in s).map((k) => [k, s[k]])), null, 2);
}

/** Down tears down **what this instance started**, and nothing else: the pids in
 *  our own (port-keyed) state file. With no recorded server pid we started no
 *  server, so we don't get to POST `/shutdown` at whatever is on the port — that
 *  is how a second peek would kill the first one's. */
async function cmdDown({ quiet } = {}) {
  const state = readState();
  if (state.serverPid) {
    try {
      await fetch(`http://127.0.0.1:${state.port ?? PORT}/shutdown`, { method: "POST" });
    } catch {
      /* not running */
    }
  }
  const stopped = [];
  for (const [what, pid] of [
    ["server", state.serverPid],
    ["chrome", state.chromePid],
  ]) {
    if (!pid) continue;
    try {
      process.kill(pid, "SIGTERM");
      stopped.push(`${what} ${pid}`);
    } catch {
      /* already gone */
    }
  }
  writeState({ serverPid: null, chromePid: null });
  // Say what was actually stopped: "down" over a port someone else is serving
  // means *nothing was touched*, and that should read as such.
  if (!quiet) console.log(stopped.length ? `peek: down — stopped ${stopped.join(", ")}` : "peek: down (nothing of ours was running)");
}

// --------------------------------------------------------------------------

const [cmd, ...argv] = process.argv.slice(2);
const { flags, rest } = parseFlags(argv);
const commands = {
  up: () => cmdUp(flags),
  chat: () => cmdChat(rest.join(" "), flags),
  new: () => cmdNewSession(),
  shot: () => cmdShot(rest[0], flags),
  click: () => cmdClick(rest, flags),
  tabs: () => cmdTabs(flags),
  state: () => cmdState(flags),
  down: () => cmdDown({}),
};
if (!commands[cmd]) {
  console.error(`usage: peek <${Object.keys(commands).join("|")}> [...]\n\nSee the header of ${path.relative(REPO, fileURLToPath(import.meta.url))} for examples.`);
  process.exit(1);
}
try {
  await commands[cmd]();
} catch (err) {
  console.error(`peek: ${err.message}`);
  process.exit(1);
}
