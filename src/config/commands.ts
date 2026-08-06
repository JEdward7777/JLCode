/**
 * `jlcode config …` subcommands: list/which/use/clone/add/remove. Keys are
 * never printed — only whether one is set. Selection is keyed off the current
 * working directory (D-06).
 */
import { resolvePaths } from "../paths.js";
import { ModelCatalog, describeWindowSource } from "../llm/models.js";
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
  updateModelConfig,
  type ModelConfigPatch,
} from "./operations.js";
import {
  APPROVAL_POLICIES,
  MODES,
  REASONING_EFFORTS,
  type ModelConfig,
  type SamplingParams,
} from "./types.js";

const CONFIG_HELP = `jlcode config — manage model configurations

  config list [query]              list configs (filtered by name/model)
  config which [--offline]         show the config selected for this directory,
                                   plus its effective context window
  config use <name|id>             bind this directory to a config
  config clone <src> <new-name>    clone an existing config
  config add --name <> --model <>  add a config (key read from stdin or JLCODE_ADD_KEY)
  config set <name|id> [flags]     edit fields of an existing config
  config remove <name|id>          delete a config

Fields (for add/set): --model --effort <none|low|medium|high|adaptive>
  --mode <ask|plan|code> --approval <manual|auto-safe|full-auto|read-only>
  --system <text> --max-tokens <n> --temperature <n> --top-p <n>
  --context-length <n>   override the model's context window; normally unset,
                         since it is read live from OpenRouter (D-44c)
`;

function numberFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const s = flagString(flags, key);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`Invalid number for --${key}: "${s}"`);
  return n;
}

function samplingFromFlags(flags: Record<string, string | boolean>): Partial<SamplingParams> {
  const out: Partial<SamplingParams> = {};
  const t = numberFlag(flags, "temperature");
  if (t !== undefined) out.temperature = t;
  const p = numberFlag(flags, "top-p");
  if (p !== undefined) out.topP = p;
  const m = numberFlag(flags, "max-tokens");
  if (m !== undefined) out.maxTokens = m;
  return out;
}

function patchFromFlags(flags: Record<string, string | boolean>): ModelConfigPatch {
  const patch: ModelConfigPatch = {};
  const name = flagString(flags, "name");
  if (name) patch.name = name;
  const model = flagString(flags, "model");
  if (model) patch.model = model;
  const effort = oneOf(flagString(flags, "effort"), REASONING_EFFORTS, "effort");
  if (effort) patch.reasoningEffort = effort;
  const mode = oneOf(flagString(flags, "mode"), MODES, "mode");
  if (mode) patch.defaultMode = mode;
  const approval = oneOf(flagString(flags, "approval"), APPROVAL_POLICIES, "approval");
  if (approval) patch.defaultApproval = approval;
  const system = flagString(flags, "system");
  if (system !== undefined) patch.systemPromptAddendum = system;
  const sampling = samplingFromFlags(flags);
  if (Object.keys(sampling).length > 0) patch.sampling = sampling;
  const contextLength = flagString(flags, "context-length");
  if (contextLength !== undefined) {
    const n = Number(contextLength);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--context-length must be a positive integer`);
    patch.contextLength = n;
  }
  return patch;
}

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
      // The effective context window, and where it came from (D-44c, H-06).
      // Printed here because the failure mode this fixes was invisible: nothing
      // ever stated the window, so "no window at all" looked exactly like a
      // working setup. `--offline` keeps the command from reaching the network.
      const catalog = new ModelCatalog({ file: paths.modelsCacheFile });
      if (!parseArgs(rest).flags["offline"]) {
        const { error } = await catalog.ensureKnown(selected.model);
        if (error) process.stdout.write(`  (model catalog unavailable — ${error})\n`);
      }
      const window = catalog.resolve(selected.model, selected.compaction?.contextLength);
      process.stdout.write(
        `    context window ${window.window.toLocaleString()} tokens — ${describeWindowSource(window.source)}\n`,
      );
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
      const sampling = samplingFromFlags(flags);
      const { config: next, added } = addModelConfig(config, {
        name,
        model,
        openRouterKey,
        reasoningEffort: oneOf(flagString(flags, "effort"), REASONING_EFFORTS, "effort"),
        systemPromptAddendum: flagString(flags, "system"),
        defaultMode: oneOf(flagString(flags, "mode"), MODES, "mode") ?? "code",
        defaultApproval: oneOf(flagString(flags, "approval"), APPROVAL_POLICIES, "approval") ?? "manual",
        sampling: Object.keys(sampling).length > 0 ? sampling : undefined,
        compaction: { auto: true },
      });
      saveConfig(next, paths);
      process.stdout.write(`Added → ${added.name}  ${shortId(added.id)}\n`);
      return 0;
    }

    case "set": {
      const { positionals, flags } = parseArgs(rest);
      const ref = positionals[0];
      if (!ref) throw new Error("Usage: jlcode config set <name|id> [--model <> --max-tokens <> …]");
      const config = loadConfig(paths);
      const { config: next, updated } = updateModelConfig(config, ref, patchFromFlags(flags));
      saveConfig(next, paths);
      const mt = updated.sampling?.maxTokens;
      process.stdout.write(
        `Updated → ${updated.name}  ${updated.model}  effort:${updated.reasoningEffort ?? "-"}` +
          `${mt !== undefined ? `  max_tokens:${mt}` : ""}  ${shortId(updated.id)}\n`,
      );
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
