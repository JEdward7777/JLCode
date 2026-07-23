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
import type { Conversation } from "../conversation/types.js";
import { parseArgs, flagString } from "../util/args.js";
import { createServer } from "./server.js";
import { startNodeServer } from "./node-adapter.js";

const DEFAULT_PORT = 4517;
const HOST = "127.0.0.1";

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
  // eslint-disable-next-line prefer-const
  let closeServer = (): void => {};
  const { app } = createServer({
    resolveConfig,
    newSession,
    store,
    workingDir: cwd,
    version: getVersion(),
    onShutdown: () => setTimeout(() => closeServer(), 100),
  });
  const server = await startNodeServer((req) => app.fetch(req), { host: HOST, port });
  // Flush pending persistence writes before exiting.
  closeServer = () => void store.flush().finally(() => server.close(() => process.exit(0)));

  const base = `http://${HOST}:${port}`;
  process.stderr.write(
    [
      `JLCode dev server — ${config.name} (${config.model})${fake ? " [fake]" : ""}`,
      `listening on ${base}  (pid ${process.pid})`,
      ``,
      `  curl -s ${base}/health`,
      `  curl -sX POST ${base}/shutdown        # stop the server`,
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
