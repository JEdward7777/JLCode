/**
 * `jlcode serve` — start the minimal dev HTTP endpoint. Binds localhost by
 * default (D-19/§20 posture). Uses the OpenRouter client for the selected
 * config, or the fake echo driver when JLCODE_FAKE_LLM=1 (offline, no spend).
 */
import { resolvePaths } from "../paths.js";
import { getVersion } from "../version.js";
import { loadConfig } from "../config/store.js";
import { resolveForCwd } from "../config/operations.js";
import { OpenRouterClient } from "../llm/client.js";
import type { LlmDriver } from "../llm/types.js";
import { echoDriver } from "../session/fake.js";
import { parseArgs, flagString } from "../util/args.js";
import { createServer } from "./server.js";
import { startNodeServer } from "./node-adapter.js";

const DEFAULT_PORT = 4517;
const HOST = "127.0.0.1";

export async function runServe(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const config = resolveForCwd(loadConfig(resolvePaths()), process.cwd());
  if (!config) {
    process.stderr.write(`No model config selected for ${process.cwd()}.\nUse: jlcode config use <name>\n`);
    return 1;
  }

  const fake = process.env.JLCODE_FAKE_LLM === "1";
  if (!fake && !config.openRouterKey) {
    process.stderr.write(`Config "${config.name}" has no OpenRouter key. Re-add it.\n`);
    return 1;
  }

  const driver: LlmDriver = fake
    ? echoDriver()
    : new OpenRouterClient({
        apiKey: config.openRouterKey,
        referer: "https://github.com/JEL-LL/JLCode",
        title: "JLCode",
      });

  const port = Number(flagString(flags, "port") ?? process.env.JLCODE_PORT ?? DEFAULT_PORT);
  const { app } = createServer({ config, driver, version: getVersion() });
  const server = await startNodeServer((req) => app.fetch(req), { host: HOST, port });

  const base = `http://${HOST}:${port}`;
  process.stderr.write(
    [
      `JLCode dev server — ${config.name} (${config.model})${fake ? " [fake]" : ""}`,
      `listening on ${base}`,
      ``,
      `  curl -s ${base}/health`,
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
