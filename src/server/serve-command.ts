/**
 * `jlcode serve` — start the minimal dev HTTP endpoint. Binds localhost by
 * default (D-19/§20 posture). Uses the OpenRouter client for the selected
 * config, or the fake echo driver when JLCODE_FAKE_LLM=1 (offline, no spend).
 */
import { resolvePaths } from "../paths.js";
import { createLogger } from "../logger.js";
import { getVersion } from "../version.js";
import { loadConfig, saveConfig } from "../config/store.js";
import { resolveForCwd, findModelConfig } from "../config/operations.js";
import { OpenRouterClient } from "../llm/client.js";
import type { LlmDriver } from "../llm/types.js";
import type { ModelConfig } from "../config/types.js";
import { fakeAgentDriver } from "../session/fake.js";
import { Session } from "../session/session.js";
import { ToolRegistry, defaultTools } from "../tools/registry.js";
import { McpManager, mcpSettingsFiles } from "../mcp/client.js";
import { askUserTool } from "../tools/ask-user.js";
import { Sandbox } from "../tools/sandbox.js";
import { ModeApprovalGate } from "../tools/mode-gate.js";
import { ConversationStore } from "../persist/conversation-store.js";
import { DebugJournal } from "../persist/debug-journal.js";
import type { Conversation } from "../conversation/types.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { parseArgs, flagString } from "../util/args.js";
import { readSecret } from "../util/prompt.js";
import { createServer } from "./server.js";
import { startNodeServer } from "./node-adapter.js";
import { randomBytes } from "node:crypto";
import {
  createAuthGuard,
  generatePassword,
  hashPassword,
  randomToken,
  type AuthGuard,
  type AuthSecrets,
} from "./auth.js";
import type { AuthConfig } from "../config/types.js";

const DEFAULT_PORT = 4517;
const DEFAULT_HOST = "127.0.0.1";

/** The built browser client (dist/web), relative to this compiled module
 *  (dist/server/serve-command.js → ../web). Undefined if not built yet. */
function staticDir(): string | undefined {
  const dir = fileURLToPath(new URL("../web", import.meta.url));
  return existsSync(dir) ? dir : undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

export async function runServe(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const paths = resolvePaths();
  const cwd = process.cwd();
  const fake = process.env.JLCODE_FAKE_LLM === "1";

  // Re-read on every new thread so `jlcode config set/use` takes effect live.
  // `--config <name>` pins a specific config regardless of the cwd binding.
  const pinned = flagString(flags, "config");
  const resolveConfig = () => {
    const cfg = loadConfig(paths);
    return pinned ? findModelConfig(cfg, pinned) : resolveForCwd(cfg, cwd);
  };
  const makeDriver = (config: ModelConfig): LlmDriver =>
    fake
      ? fakeAgentDriver()
      : new OpenRouterClient({
          apiKey: config.openRouterKey,
          referer: "https://github.com/JEdward7777/JLCode",
          title: "JLCode",
        });

  // A fully-wired session: driver + native tools + sandbox (fenced to cwd plus
  // any remembered roots) + the mode∩approval gate from the config
  // (D-07/D-08/D-19). "Remember this root" persists to folderRoots[cwd].
  // MCP servers (D-47): one child per enabled server for the whole instance,
  // started before we listen so every session sees the same tool set. A server
  // that fails is reported here and simply contributes no tools.
  const mcp = await McpManager.start({ workspace: cwd });
  for (const problem of mcp.problems) process.stderr.write(`mcp: warning: ${problem}\n`);
  for (const status of mcp.statuses()) {
    if (status.state === "failed") process.stderr.write(`mcp: ${status.name} failed to start — ${status.error ?? ""}\n`);
  }

  const newSession = (config: ModelConfig, conversation?: Conversation): Session => {
    const cfg = loadConfig(paths);
    const roots = [cwd, ...(cfg.folderRoots?.[cwd] ?? [])];
    return new Session({
      config,
      driver: makeDriver(config),
      tools: new ToolRegistry([...defaultTools(), askUserTool(), ...mcp.tools()]),
      sandbox: new Sandbox(roots),
      // Live-switchable gate (D-07/D-08): rebuilt when the user changes
      // mode/approval from the browser. Starts from the config defaults.
      mode: config.defaultMode,
      approval: config.defaultApproval,
      buildGate: (mode, approval) => new ModeApprovalGate(mode, approval, cfg.autoSafeAllowlist),
      conversation,
      onAddRoot: (dir) => {
        const current = loadConfig(paths);
        const existing = current.folderRoots?.[cwd] ?? [];
        if (!existing.includes(dir)) {
          saveConfig({ ...current, folderRoots: { ...(current.folderRoots ?? {}), [cwd]: [...existing, dir] } }, paths);
        }
      },
    });
  };

  const store = new ConversationStore(paths.conversationsDir);
  const debugJournal = new DebugJournal(paths.logsDir);
  const log = createLogger({ dir: paths.logsDir });

  const config = resolveConfig();
  if (!config) {
    process.stderr.write(`No model config selected for ${cwd}.\nUse: jlcode config use <name>\n`);
    return 1;
  }
  if (!fake && !config.openRouterKey) {
    process.stderr.write(`Config "${config.name}" has no OpenRouter key. Re-add it.\n`);
    return 1;
  }

  const port = Number(flagString(flags, "port") ?? process.env.JLCODE_PORT ?? DEFAULT_PORT);
  // Bind seam (D-40): localhost by default; --host selects the bind scope. An
  // outward (non-loopback) bind requires auth (provisioned just below).
  const host = flagString(flags, "host") ?? DEFAULT_HOST;
  const outward = !LOOPBACK.has(host);

  // P5f auth (D-40): outward binds are guarded by a hashed password. Password
  // provisioning, three ways: --password <pw> (discouraged), --password-prompt
  // (read interactively), --generate-password (make one and print it). If none
  // is given but a password is already stored, reuse it. A one-hit setup URL is
  // always printed so first login is frictionless even for a chosen password.
  let auth: AuthGuard | undefined;
  let oneHitUrl: string | undefined;
  let generatedPassword: string | undefined;
  if (outward) {
    const provided = flagString(flags, "password");
    const wantGenerate = flags["generate-password"] === true;
    const wantPrompt = flags["password-prompt"] === true;

    let plaintext: string | undefined;
    if (wantGenerate) plaintext = generatePassword();
    else if (provided) plaintext = provided;
    else if (wantPrompt) plaintext = await readSecret("Set server password: ");

    const current = loadConfig(paths);
    let secrets: AuthSecrets | undefined = current.auth;
    if (plaintext) {
      const { salt, hash } = hashPassword(plaintext);
      secrets = {
        passwordHash: hash,
        salt,
        cookieSecret: current.auth?.cookieSecret ?? randomBytes(32).toString("hex"),
        updatedAt: new Date().toISOString(),
      };
      saveConfig({ ...current, auth: secrets as AuthConfig }, paths);
      if (wantGenerate) generatedPassword = plaintext; // only echo one we made
    }
    if (!secrets) {
      process.stderr.write(
        `Binding ${host} (outward) requires a password. Provision one with:\n` +
          `  --generate-password        generate & print a password\n` +
          `  --password-prompt          type one interactively\n` +
          `  --password <pw>            pass one on the CLI (discouraged)\n`,
      );
      return 1;
    }
    const oneHit = randomToken();
    auth = createAuthGuard({ secrets, oneHitToken: oneHit });
    oneHitUrl = `http://${host}:${port}/?token=${oneHit}`;
  }
  // eslint-disable-next-line prefer-const
  let closeServer = (): void => {};
  const { app } = createServer({
    resolveConfig,
    newSession,
    store,
    debugJournal,
    workingDir: cwd,
    version: getVersion(),
    onShutdown: () => setTimeout(() => closeServer(), 100),
    staticDir: staticDir(),
    auth,
    logger: log,
    // Live MCP status for the browser panel (P7b) — re-read per request so
    // answers learned mid-session show up without a restart.
    mcpStatus: () => ({ servers: mcp.statuses(), problems: mcp.problems, files: mcpSettingsFiles(cwd) }),
    // Persist a live mode/approval switch as the config's new default (Joshua's
    // call: the header controls both re-gate now and stick for next launch).
    persistDefaults: (configName, patch) => {
      const current = loadConfig(paths);
      const idx = current.modelConfigs.findIndex((m) => m.name === configName);
      if (idx < 0) return;
      const mc = current.modelConfigs[idx]!;
      const configs = current.modelConfigs.slice();
      // A trigger-mode switch persists into compaction settings: `auto` sets the
      // auto flag; the other four are recorded as the first (active) trigger mode.
      const compaction =
        patch.triggerMode === undefined
          ? mc.compaction
          : {
              ...(mc.compaction ?? { auto: false }),
              auto: patch.triggerMode === "auto",
              triggerModes: [patch.triggerMode],
            };
      configs[idx] = {
        ...mc,
        defaultMode: patch.mode ?? mc.defaultMode,
        defaultApproval: patch.approval ?? mc.defaultApproval,
        ...(compaction ? { compaction } : {}),
        updatedAt: new Date().toISOString(),
      };
      saveConfig({ ...current, modelConfigs: configs }, paths);
    },
  });
  const server = await startNodeServer((req) => app.fetch(req), { host, port });
  // Flush pending persistence writes before exiting. flush() now *rejects* on a
  // stalled write (D-46) rather than resolving green, so report the loss on the
  // way out instead of exiting silently — and still exit, since a shutdown that
  // can't complete because the disk is full would be worse than a loud one.
  closeServer = () =>
    void Promise.all([store.flush(), debugJournal.flush(), mcp.close()])
      .catch((err: unknown) => {
        log.error("shutdown: unwritten records were lost", { err });
        process.exitCode = 1;
      })
      .finally(() => server.close(() => process.exit(process.exitCode ?? 0)));

  const base = `http://${host}:${port}`;
  const client = staticDir() ? `open ${base}/  in your browser` : `browser client not built — run \`npm run build\``;
  // Auth banner (D-40): outward binds print the one-hit sign-in URL (always, even
  // for a chosen password — Joshua's call) and any generated password.
  const authLines = auth
    ? [
        ``,
        `AUTH ON (outward bind) —`,
        ...(generatedPassword ? [`  password: ${generatedPassword}`] : []),
        `  one-hit sign-in URL (sets the session cookie on first load):`,
        `    ${oneHitUrl}`,
      ]
    : [];
  process.stderr.write(
    [
      `JLCode dev server — ${config.name} (${config.model})${fake ? " [fake]" : ""}`,
      `listening on ${base}  (pid ${process.pid})`,
      `  ${client}`,
      ...authLines,
      ``,
      `  curl -s ${base}/health`,
      `  curl -sX POST ${base}/shutdown        # stop the server (no UI button; curl-only)`,
      `  curl -s ${base}/chat -H 'content-type: application/json' -d '{"text":"hello"}'`,
      `  # reuse the returned sessionId to continue the thread:`,
      `  curl -s ${base}/chat -H 'content-type: application/json' -d '{"text":"and again","sessionId":"<id>"}'`,
      `  curl -s ${base}/session/<id>`,
      ``,
      `Ctrl-C to stop.`,
      ``,
    ].join("\n"),
  );

  return new Promise<number>((resolve) => {
    const shutdown = () => server.close(() => resolve(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
