/**
 * `jlcode serve` — start the minimal dev HTTP endpoint. Binds localhost by
 * default (D-19/§20 posture). Uses the OpenRouter client for the selected
 * config, or the fake echo driver when JLCODE_FAKE_LLM=1 (offline, no spend).
 */
import { resolvePaths } from "../paths.js";
import { getVersion } from "../version.js";
import { loadConfig, saveConfig } from "../config/store.js";
import { resolveForCwd, findModelConfig } from "../config/operations.js";
import { OpenRouterClient } from "../llm/client.js";
import type { LlmDriver } from "../llm/types.js";
import type { ModelConfig } from "../config/types.js";
import { echoDriver } from "../session/fake.js";
import { Session } from "../session/session.js";
import { ToolRegistry, defaultTools } from "../tools/registry.js";
import { askUserTool } from "../tools/ask-user.js";
import { Sandbox } from "../tools/sandbox.js";
import { ModeApprovalGate } from "../tools/mode-gate.js";
import { ConversationStore } from "../persist/conversation-store.js";
import { DebugJournal } from "../persist/debug-journal.js";
import type { Conversation } from "../conversation/types.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { parseArgs, flagString } from "../util/args.js";
import { createServer } from "./server.js";
import { startNodeServer } from "./node-adapter.js";

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
      ? echoDriver()
      : new OpenRouterClient({
          apiKey: config.openRouterKey,
          referer: "https://github.com/JEL-LL/JLCode",
          title: "JLCode",
        });

  // A fully-wired session: driver + native tools + sandbox (fenced to cwd plus
  // any remembered roots) + the mode∩approval gate from the config
  // (D-07/D-08/D-19). "Remember this root" persists to folderRoots[cwd].
  const newSession = (config: ModelConfig, conversation?: Conversation): Session => {
    const cfg = loadConfig(paths);
    const roots = [cwd, ...(cfg.folderRoots?.[cwd] ?? [])];
    return new Session({
      config,
      driver: makeDriver(config),
      tools: new ToolRegistry([...defaultTools(), askUserTool()]),
      sandbox: new Sandbox(roots),
      gate: new ModeApprovalGate(config.defaultMode, config.defaultApproval, cfg.autoSafeAllowlist),
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
  // Bind seam (D-40): localhost by default; --host selects the bind scope.
  // Auth for outward binds arrives in P5f — warn until then.
  const host = flagString(flags, "host") ?? DEFAULT_HOST;
  if (!LOOPBACK.has(host)) {
    process.stderr.write(
      `WARNING: binding ${host} (non-loopback) — there is no auth yet (P5f/D-40); anyone who can reach this port can drive the agent.\n`,
    );
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
  });
  const server = await startNodeServer((req) => app.fetch(req), { host, port });
  // Flush pending persistence writes before exiting.
  closeServer = () =>
    void Promise.all([store.flush(), debugJournal.flush()]).finally(() => server.close(() => process.exit(0)));

  const base = `http://${host}:${port}`;
  const client = staticDir() ? `open ${base}/  in your browser` : `browser client not built — run \`npm run build\``;
  process.stderr.write(
    [
      `JLCode dev server — ${config.name} (${config.model})${fake ? " [fake]" : ""}`,
      `listening on ${base}  (pid ${process.pid})`,
      `  ${client}`,
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
