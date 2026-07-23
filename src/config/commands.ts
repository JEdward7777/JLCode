/**
 * `jlcode config …` subcommands: list/which/use/clone/add/remove. Keys are
 * never printed — only whether one is set. Selection is keyed off the current
 * working directory (D-06).
 */
import { resolvePaths } from "../paths.js";
import { parseArgs, flagString } from "../util/args.js";
import { readSecret } from "../util/prompt.js";
import { loadConfig, saveConfig } from "./store.js";
import {
  addModelConfig,
  cloneModelConfig,
  filterModelConfigs,
  findModelConfig,
  removeModelConfig,
  resolveForCwd,
  setBinding,
} from "./operations.js";
import { APPROVAL_POLICIES, MODES, REASONING_EFFORTS, type ModelConfig } from "./types.js";

const CONFIG_HELP = `jlcode config — manage model configurations

  config list [query]              list configs (filtered by name/model)
  config which                     show the config selected for this directory
  config use <name|id>             bind this directory to a config
  config clone <src> <new-name>    clone an existing config
  config add --name <> --model <>  add a config (key read from stdin)
             [--effort <>] [--mode <>] [--approval <>] [--system <>]
  config remove <name|id>          delete a config
`;

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function line(c: ModelConfig, boundId: string | undefined): string {
  const mark = c.id === boundId ? "*" : " ";
  const key = c.openRouterKey ? "key:set" : "key:MISSING";
  const effort = c.reasoningEffort ?? "-";
  return `${mark} ${c.name}\n    ${c.model}  effort:${effort}  ${c.defaultMode}/${c.defaultApproval}  ${key}  ${shortId(c.id)}`;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${field} "${value}" — expected one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export async function runConfig(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const paths = resolvePaths();
  const cwd = process.cwd();

  switch (sub) {
    case undefined:
    case "help":
      process.stdout.write(CONFIG_HELP);
      return 0;

    case "list": {
      const { positionals } = parseArgs(rest);
      const config = loadConfig(paths);
      const boundId = config.folderBindings[cwd];
      const matches = filterModelConfigs(config, positionals[0] ?? "");
      if (matches.length === 0) {
        process.stdout.write("No model configs.\n");
        return 0;
      }
      for (const c of matches) process.stdout.write(line(c, boundId) + "\n");
      return 0;
    }

    case "which": {
      const config = loadConfig(paths);
      const selected = resolveForCwd(config, cwd);
      if (!selected) {
        process.stdout.write(`No config selected for ${cwd}. Use: jlcode config use <name>\n`);
        return 0;
      }
      process.stdout.write(`${selected.name}  (${selected.model})  ${shortId(selected.id)}\n`);
      return 0;
    }

    case "use": {
      const { positionals } = parseArgs(rest);
      const ref = positionals[0];
      if (!ref) throw new Error("Usage: jlcode config use <name|id>");
      const config = loadConfig(paths);
      const target = findModelConfig(config, ref);
      if (!target) throw new Error(`No model config matching "${ref}"`);
      saveConfig(setBinding(config, cwd, target.id), paths);
      process.stdout.write(`Bound ${cwd}\n   → ${target.name}\n`);
      return 0;
    }

    case "clone": {
      const { positionals } = parseArgs(rest);
      const [src, newName] = positionals;
      if (!src || !newName) throw new Error("Usage: jlcode config clone <src> <new-name>");
      const config = loadConfig(paths);
      const { config: next, added } = cloneModelConfig(config, src, newName);
      saveConfig(next, paths);
      process.stdout.write(`Cloned → ${added.name}  ${shortId(added.id)}\n`);
      return 0;
    }

    case "add": {
      const { flags } = parseArgs(rest);
      const name = flagString(flags, "name");
      const model = flagString(flags, "model");
      if (!name || !model) throw new Error("Usage: jlcode config add --name <> --model <>");
      const openRouterKey = process.env.JLCODE_ADD_KEY ?? (await readSecret("OpenRouter API key (input hidden): "));
      if (!openRouterKey) throw new Error("No key provided.");
      const config = loadConfig(paths);
      const { config: next, added } = addModelConfig(config, {
        name,
        model,
        openRouterKey,
        reasoningEffort: oneOf(flagString(flags, "effort"), REASONING_EFFORTS, "effort"),
        systemPromptAddendum: flagString(flags, "system"),
        defaultMode: oneOf(flagString(flags, "mode"), MODES, "mode") ?? "code",
        defaultApproval: oneOf(flagString(flags, "approval"), APPROVAL_POLICIES, "approval") ?? "manual",
        compaction: { auto: true },
      });
      saveConfig(next, paths);
      process.stdout.write(`Added → ${added.name}  ${shortId(added.id)}\n`);
      return 0;
    }

    case "remove": {
      const { positionals } = parseArgs(rest);
      const ref = positionals[0];
      if (!ref) throw new Error("Usage: jlcode config remove <name|id>");
      const config = loadConfig(paths);
      const target = findModelConfig(config, ref);
      if (!target) throw new Error(`No model config matching "${ref}"`);
      saveConfig(removeModelConfig(config, ref), paths);
      process.stdout.write(`Removed ${target.name}\n`);
      return 0;
    }

    default:
      process.stderr.write(`Unknown config command: ${sub}\n\n${CONFIG_HELP}`);
      return 2;
  }
}
