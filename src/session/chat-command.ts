/**
 * `jlcode chat` — the Phase 2 walking skeleton: a terminal REPL that streams a
 * conversation through a Session. Uses the OpenRouter client for the selected
 * config, or a fake echo driver when JLCODE_FAKE_LLM=1 (offline, no spend).
 */
import readline from "node:readline";
import { resolvePaths } from "../paths.js";
import { loadConfig } from "../config/store.js";
import { resolveForCwd } from "../config/operations.js";
import { OpenRouterClient } from "../llm/client.js";
import type { LlmDriver } from "../llm/types.js";
import { SessionManager } from "./manager.js";
import { echoDriver } from "./fake.js";

export async function runChat(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  const config = resolveForCwd(loadConfig(resolvePaths()), cwd);
  if (!config) {
    process.stderr.write(`No model config selected for ${cwd}.\nUse: jlcode config use <name>\n`);
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

  const session = new SessionManager().create({ config, driver });
  const showReasoning = process.env.JLCODE_SHOW_REASONING === "1";

  session.onEvent((ev) => {
    switch (ev.type) {
      case "assistant-start":
        process.stdout.write("jlcode> ");
        break;
      case "text":
        process.stdout.write(ev.delta);
        break;
      case "reasoning":
        if (showReasoning) process.stderr.write(ev.delta);
        break;
      case "assistant-end":
        process.stdout.write("\n");
        break;
      case "truncation":
        process.stderr.write(`[truncated] ${ev.message}\n`);
        break;
      case "error":
        process.stderr.write(`\n[error] ${ev.message}\n`);
        break;
      case "halted":
        process.stderr.write(`[halted] ${ev.reason}\n`);
        break;
    }
  });

  process.stderr.write(
    `JLCode chat — ${config.name} (${config.model})${fake ? " [fake]" : ""}. Type /exit to quit.\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  process.stdout.write("you> ");
  for await (const line of rl) {
    const text = line.trim();
    if (text === "/exit" || text === "/quit") break;
    if (text === "") {
      process.stdout.write("you> ");
      continue;
    }
    try {
      await session.send(text);
    } catch (err) {
      process.stderr.write(`\n[error] ${(err as Error).message}\n`);
    }
    if (session.status === "halted") break;
    process.stdout.write("you> ");
  }
  rl.close();
  return 0;
}
