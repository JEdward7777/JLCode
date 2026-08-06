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
 *   node harness/peek/peek.mjs state
 *   node harness/peek/peek.mjs down
 *
 * `shot` writes straight into `harness/visual/`, since a peek that isn't
 * recorded may as well not have happened.
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
/** Everything transient (config, data, chrome profile, pids) lives here, so a
 *  peek never touches the real `~/.config/jlcode` or the user's browser. */
const RUN_DIR = path.join(os.tmpdir(), "jlcode-peek");
const STATE_FILE = path.join(RUN_DIR, "peek.json");

const PORT = 7801;
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
function writeConfig({ cfgDir, workDir, ctx, buffer, trigger, model }) {
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
}

async function cmdUp(flags) {
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
  writeConfig({ cfgDir, workDir, ctx: flags.ctx, buffer: flags.buffer, trigger, model });

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
      `--remote-debugging-port=${CDP_PORT}`,
      "--disable-gpu",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  chrome.unref();
  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, "chrome");
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
      pending.get(d.id)(d.result);
      pending.delete(d.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return {
    send,
    target,
    close: async () => {
      ws.close();
      // Only ever tidy up a tab we opened.
      if (!flags.attach) await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    },
  };
}

/** Our own blank tab in our own browser. */
async function newTab(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
}

/** List the user's open page tabs (attach mode). */
async function listTabs(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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

async function cmdShot(name, flags) {
  if (!name) throw new Error("usage: peek shot <name> [--session id] [--url u] [--crop topbar] [--wait ms] [--attach [--tab n]]");
  await ensureChrome(flags);
  const state = readState();
  const session = flags.session ?? state.session;

  const { send, target, close } = await cdp(flags);
  await send("Page.enable");

  if (flags.attach) {
    // Capture what the user is actually looking at: no navigate (that would yank
    // their page), no metrics override (that would visibly resize it). Their
    // window is the viewport, whatever size it happens to be.
    console.log(`peek: capturing YOUR tab — ${target.title} (${target.url})`);
  } else {
    const url = flags.url ?? `http://127.0.0.1:${state.port ?? PORT}/${session ? `?session=${session}` : ""}`;
    await send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.scale,
      mobile: false,
    });
    await send("Page.navigate", { url });
  }
  await sleep(Number(flags.wait ?? (flags.attach ? 250 : 2500))); // SSE connect + first render

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

  const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  // A peek of JLCode belongs in the visual log; a capture of the user's own
  // screen does not — it is ad-hoc, may hold anything, and must not drift into
  // a commit. Those land in the scratch dir unless a path is asked for.
  const dir = flags.out ? path.dirname(path.resolve(flags.out)) : flags.attach ? RUN_DIR : VISUAL_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const out = flags.out ? path.resolve(flags.out) : path.join(dir, name.endsWith(".png") ? name : `${name}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  await close();
  console.log(`peek: wrote ${out.startsWith(REPO) ? path.relative(REPO, out) : out}`);
}

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

async function cmdDown({ quiet } = {}) {
  const state = readState();
  try {
    await fetch(`http://127.0.0.1:${state.port ?? PORT}/shutdown`, { method: "POST" });
  } catch {
    /* not running */
  }
  for (const pid of [state.serverPid, state.chromePid]) {
    if (!pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  writeState({ serverPid: null, chromePid: null });
  if (!quiet) console.log("peek: down");
}

// --------------------------------------------------------------------------

const [cmd, ...argv] = process.argv.slice(2);
const { flags, rest } = parseFlags(argv);
const commands = {
  up: () => cmdUp(flags),
  chat: () => cmdChat(rest.join(" "), flags),
  new: () => cmdNewSession(),
  shot: () => cmdShot(rest[0], flags),
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
