/**
 * `jlcode config …` subcommands: list/which/use/clone/add/remove. Keys are
 * never printed — only whether one is set. Selection is keyed off the current
 * working directory (D-06).
 */
import { resolvePaths, type JlcodePaths } from "../paths.js";
import { ModelCatalog, describeWindowSource, type WindowSource } from "../llm/models.js";
// The same function `serve` uses to settle a session's windows (D-60/H-06) —
// borrowed rather than re-derived, so `config which` can never disagree with
// what the session will actually run under.
import { resolveWindows } from "../server/session-factory.js";
import {
  applyCompactorFit,
  computeBudget,
  describeThresholdSource,
  thresholdFitsWindow,
  type CompactionBudget,
} from "../session/compaction.js";
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
  turnTimestampsEnabled,
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
  --compaction-threshold <n|none>
                         compact once the context passes n tokens (X-27), e.g.
                         171500. Must be below the context window. Omit it and
                         the threshold stays derived (window − buffer);
                         "none" clears it back to that.
  --auto-retitle <on|off>
                         re-title a thread as it drifts (X-17); on by default.
                         Off keeps the name the opening exchange earned, and the
                         single model call it cost.
  --turn-timestamps <on|off>
                         tell the model when each user turn was sent (X-25).
                         On by default; off stops JLCode saying what day it is.
  --offline              (set/which) don't refresh the model catalog
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
  // The absolute compaction threshold (X-27). Shape only here; whether it fits
  // the model's window is checked in `set`, where the catalog is reachable.
  const threshold = flagString(flags, "compaction-threshold");
  if (threshold !== undefined) {
    if (threshold === "none" || threshold === "0") {
      patch.thresholdTokens = null; // back to the derived window − buffer
    } else {
      const n = Number(threshold);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--compaction-threshold must be a positive integer, or "none" to clear it`);
      }
      patch.thresholdTokens = n;
    }
  }
  // Drift re-titling (X-17). On/off rather than a bare flag, so `--auto-retitle
  // on` can turn it back on after it was turned off.
  const retitle = flagString(flags, "auto-retitle");
  if (retitle !== undefined) {
    if (retitle !== "on" && retitle !== "off") throw new Error(`--auto-retitle must be "on" or "off"`);
    patch.autoRetitle = retitle === "on";
  // Per-turn timestamps (X-25e). A flag with no value reads as "on", so
  // `--turn-timestamps` alone does the obvious thing.
  const stamps = flags["turn-timestamps"];
  if (stamps !== undefined) {
    const on = onOff(stamps, "turn-timestamps");
    patch.turnTimestamps = on;
  }
  return patch;
}

/** Parse an on/off flag; `--flag` with no value means on. */
function onOff(value: string | boolean, key: string): boolean {
  if (typeof value === "boolean") return value;
  const v = value.trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(v)) return true;
  if (["off", "false", "no", "0"].includes(v)) return false;
  throw new Error(`--${key} must be "on" or "off"`);
}

/**
 * Settle the window *and* the compaction threshold a session for this config
 * would run under — D-60's window precedence (config > catalog > fallback) plus
 * X-27's threshold precedence (absolute > `window − buffer`), with the D-44a
 * compactor-fit guard applied last, exactly as `serve` does it. Refreshes the
 * catalog unless `--offline`; a catalog failure is reported, never fatal.
 */
async function resolveBudget(
  config: ModelConfig,
  paths: JlcodePaths,
  opts: { offline?: boolean } = {},
): Promise<{ budget: CompactionBudget; source: WindowSource; catalogError?: string }> {
  const catalog = new ModelCatalog({ file: paths.modelsCacheFile });
  let catalogError: string | undefined;
  if (!opts.offline) ({ error: catalogError } = await catalog.ensureKnown(config.model));
  const windows = resolveWindows(config, catalog);
  const bufferTokens = config.compaction?.bufferTokens;
  const budget = applyCompactorFit(
    computeBudget(windows.window, { bufferTokens, thresholdTokens: config.compaction?.thresholdTokens }),
    windows.compactorWindow,
    bufferTokens,
  );
  return { budget, source: windows.source, catalogError };
}

/** The two lines that state where compaction fires and why (X-27). */
function thresholdLines(budget: CompactionBudget): string {
  let out = `    compacts above ${budget.threshold.toLocaleString()} tokens — ${describeThresholdSource(budget)}\n`;
  if (budget.refusedThreshold !== undefined) {
    out +=
      `    ⚠ compaction.thresholdTokens ${budget.refusedThreshold.toLocaleString()} is not below the window — ` +
      `ignored (it could never fire); set a lower --compaction-threshold\n`;
  }
  return out;
}

/** The one line that says whether the model is told when each turn was sent (X-25). */
function turnTimestampLine(config: ModelConfig): string {
  return turnTimestampsEnabled(config)
    ? `    turn timestamps: on — each user turn carries the time it was sent\n`
    : `    turn timestamps: off — the model is never told what day it is ` +
        `(environment.turnTimestamps=false)\n`;
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
      const offline = Boolean(parseArgs(rest).flags["offline"]);
      const { budget, source, catalogError } = await resolveBudget(selected, paths, { offline });
      if (catalogError) process.stdout.write(`  (model catalog unavailable — ${catalogError})\n`);
      process.stdout.write(
        `    context window ${budget.window.toLocaleString()} tokens — ${describeWindowSource(source)}\n`,
      );
      // And where compaction actually fires under it (X-27) — a threshold you
      // can set is only useful if you can read it back.
      process.stdout.write(thresholdLines(budget));
      // Drift re-titling (X-17) — stated only when it is off, since a setting
      // that is on by default and printed every time is just noise.
      if (selected.autoRetitle === false) {
        process.stdout.write(`    auto re-title off — threads keep their opening name\n`);
      }
      // Whether the model is told what day it is (X-25). Stated here for the
      // same reason the window is: the failure it fixes is silent, so "off"
      // must be readable rather than inferred from missing JSON.
      process.stdout.write(turnTimestampLine(selected));
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
      const patch = patchFromFlags(flags);
      const offline = Boolean(flags["offline"]);
      // A threshold above the window can never fire (X-27d) — the silent failure
      // H-06 just showed is easy to miss. Refuse it here, against the window the
      // *updated* config would run under, so the error lands at the moment the
      // value is typed rather than as months of un-compacted conversations.
      if (typeof patch.thresholdTokens === "number") {
        const target = findModelConfig(config, ref);
        if (!target) throw new Error(`No model config matching "${ref}"`);
        const probe: ModelConfig = {
          ...target,
          model: patch.model ?? target.model,
          compaction: {
            ...(target.compaction ?? { auto: false }),
            ...(patch.contextLength !== undefined ? { contextLength: patch.contextLength } : {}),
          },
        };
        const { budget, source, catalogError } = await resolveBudget(probe, paths, { offline });
        if (catalogError) process.stderr.write(`  (model catalog unavailable — ${catalogError})\n`);
        if (!thresholdFitsWindow(patch.thresholdTokens, budget.window)) {
          // An assumed window is a guess, not a fact (D-60d) — refusing on a
          // guess would block a value that is very likely right, so warn and
          // accept, naming the fix.
          if (source === "fallback") {
            process.stderr.write(
              `warning: ${probe.model} isn't in the OpenRouter catalog, so its window is an assumed ` +
                `${budget.window.toLocaleString()} — accepting ${patch.thresholdTokens.toLocaleString()} anyway. ` +
                `Set --context-length <n> to state the real window.\n`,
            );
          } else {
            throw new Error(
              `--compaction-threshold ${patch.thresholdTokens.toLocaleString()} is not below the ` +
                `${budget.window.toLocaleString()}-token context window of ${probe.model} ` +
                `(${describeWindowSource(source)}) — it would never fire. Pick a lower value` +
                `${source === "config" ? ", or raise --context-length" : ""}.`,
            );
          }
        }
      }
      const { config: next, updated } = updateModelConfig(config, ref, patch);
      saveConfig(next, paths);
      const mt = updated.sampling?.maxTokens;
      process.stdout.write(
        `Updated → ${updated.name}  ${updated.model}  effort:${updated.reasoningEffort ?? "-"}` +
          `${mt !== undefined ? `  max_tokens:${mt}` : ""}  ${shortId(updated.id)}\n`,
      );
      // Read the threshold back whenever this command touched it — the effective
      // one, so a compactor-fit tightening (D-44a) is visible rather than silent.
      if (patch.thresholdTokens !== undefined || patch.contextLength !== undefined) {
        const { budget } = await resolveBudget(updated, paths, { offline });
        process.stdout.write(thresholdLines(budget));
      }
      // Same read-back for the stamps (X-25e): turning them off is a decision
      // to see confirmed, not one to assume took.
      if (patch.turnTimestamps !== undefined) process.stdout.write(turnTimestampLine(updated));
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
