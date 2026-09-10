/**
 * `jlcode config model [<slug>]` — put this folder on a different model and
 * **keep its key** (X-40, D-82).
 *
 * The friction this deletes, in Joshua's words: *"I have to run at least two
 * different commands and also go into the text file to copy the key over."*
 * `config add` prompts for a key it has no way to know is the one this folder
 * already uses, so the only route to a new model under an existing client key
 * ran through `config.json` by hand — and the key is precisely the thing that
 * must not move.
 *
 * So this is a **derive** operation, not a create-from-nothing:
 *
 *  - take the key from the config this directory resolves to (walking up to the
 *    nearest bound ancestor — a *project* has a model, not whichever
 *    subdirectory you were standing in);
 *  - find-or-create the sibling holding the target model, where identity is the
 *    pair **(key, model)**, so switching back and forth converges on two rows
 *    instead of growing one per switch;
 *  - carry the settings that describe *how you work* and re-derive the four that
 *    describe the *old model* (see `MODEL_SPECIFIC_FIELDS`);
 *  - name the outcome distinctly — **created** / **switched back** / **already
 *    there** — because "nothing happened" and "a new config now holds your key"
 *    must not read the same.
 *
 * Every ambiguity is a numbered picker (`pickOne`), never an error you retype
 * past, and every prompt has a flag, so a non-interactive run refuses by
 * *naming the flag that would have answered it*.
 */
import type { JlcodePaths } from "../paths.js";
import { ModelCatalog, describeWindowSource } from "../llm/models.js";
import { parseArgs, flagString } from "../util/args.js";
import { pickOne, readLineOr, readSecret, type PickChoice } from "../util/prompt.js";
import { loadConfig, saveConfig } from "./store.js";
import { resolveBudget, shortId, thresholdLines } from "./describe.js";
import {
  DEFAULT_TOOL_ROUNDS,
  addModelConfig,
  DEFAULT_WATCHDOG_MINUTES,
  bindAndRemember,
  configsWithKeyAndModel,
  createAndBind,
  deriveConfigName,
  deriveModelConfig,
  findModelConfig,
  modelsUnderKey,
  nearestBinding,
  projectInstructionsEnabled,
  turnTimestampsEnabled,
} from "./operations.js";
import type { Config, ModelConfig, ModelPricing } from "./types.js";

export const MODEL_HELP = `jlcode config model — switch this folder to another model, keeping its key

  config model                 pick from the models already set up under this
                               folder's key (most recent first), or search
  config model <slug>          switch to a model by slug (exact wins, else a
                               substring search of the OpenRouter catalog)

Flags (each one answers a prompt, so a script never has to be interactive):
  --model <id>     the exact model id, when a short name matches several
  --config <name>  which existing config to switch to, when two share key+model
  --name <text>    the name for a config being created
  --key <secret>   the OpenRouter key, when this folder has no config yet
                   (bad form on a shared box — JLCODE_ADD_KEY works too)
  --offline        don't refresh the model catalog
`;

/** What the catalog had to say about a typed slug. */
type SlugMatch =
  | { kind: "known"; ids: string[] } // exact hit (one id) or substring hits
  | { kind: "unknown" } // the catalog is loaded and nothing matched
  | { kind: "offline" }; // no catalog at all — nothing to match against

/**
 * Resolve a slug against the catalog: exact wins, else substring (D-82).
 *
 * The three answers are kept apart because the caller treats them differently.
 * A `known` match is authoritative. `unknown` and `offline` both fall back to
 * accepting the literal string with a warning — the posture `config set` already
 * takes, and the one that lets a model released this morning be used this
 * morning — but only `known` may out-vote a config of the same name.
 */
export function matchSlug(catalog: ModelCatalog, slug: string): SlugMatch {
  const ids = catalog.modelIds();
  if (ids.length === 0) return { kind: "offline" };
  if (ids.includes(slug)) return { kind: "known", ids: [slug] };
  const q = slug.trim().toLowerCase();
  const hits = ids.filter((id) => id.toLowerCase().includes(q)).sort();
  return hits.length > 0 ? { kind: "known", ids: hits } : { kind: "unknown" };
}

/** `$3.00 in / $15.00 out per Mtok`, or undefined when the catalog never said. */
export function formatPrice(pricing: ModelPricing | undefined): string | undefined {
  const inp = pricing?.promptPerMTok;
  const out = pricing?.completionPerMTok;
  if (inp === undefined || out === undefined) return undefined;
  const usd = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
  return `${usd(inp)} in / ${usd(out)} out per Mtok`;
}

/**
 * Every setting on this config that is **not** a default — the list D-82 says
 * must be printed on a switch. Inheriting a mode, an approval policy or a
 * 45-minute watchdog invisibly is how you end up running under something you
 * did not choose and cannot remember choosing.
 */
export function nonDefaultSettings(config: ModelConfig): string[] {
  const out: string[] = [];
  if (config.reasoningEffort) out.push(`effort:${config.reasoningEffort}`);
  if (config.defaultMode !== "code") out.push(`mode:${config.defaultMode}`);
  if (config.defaultApproval !== "manual") out.push(`approval:${config.defaultApproval}`);
  const s = config.sampling;
  if (s?.maxTokens !== undefined) out.push(`max_tokens:${s.maxTokens}`);
  if (s?.temperature !== undefined) out.push(`temperature:${s.temperature}`);
  if (s?.topP !== undefined) out.push(`top_p:${s.topP}`);
  const watchdog = config.commands?.watchdogMinutes;
  if (watchdog !== undefined && watchdog !== DEFAULT_WATCHDOG_MINUTES) {
    out.push(watchdog <= 0 ? `watchdog:off` : `watchdog:${watchdog}min`);
  }
  const rounds = config.commands?.toolRounds;
  if (rounds !== undefined && rounds !== DEFAULT_TOOL_ROUNDS) out.push(`toolRounds:${rounds}`);
  if (!turnTimestampsEnabled(config)) out.push("turn-timestamps:off");
  if (!projectInstructionsEnabled(config)) out.push("project-instructions:off");
  if (config.autoRetitle === true) out.push("auto-retitle:on");
  if (config.compaction?.auto === false) out.push("compaction:manual");
  if (config.compaction?.model) out.push(`compactor:${config.compaction.model}`);
  const addendum = config.systemPromptAddendum?.trim();
  if (addendum) out.push(`system addendum:${addendum.length} chars`);
  return out;
}

/**
 * Settings the catalog says the new model invalidates — **warned about by name,
 * never clamped** (D-82). A catalog can lag a model, and silently rewriting a
 * number the user typed is how a config stops meaning what it says. An
 * `undefined` answer from the catalog is not a `no`, so it warns about nothing.
 */
export function catalogWarnings(catalog: ModelCatalog, config: ModelConfig): string[] {
  const out: string[] = [];
  const effort = config.reasoningEffort;
  if (effort && effort !== "none" && catalog.supportsReasoning(config.model) === false) {
    out.push(
      `effort:${effort} carried over, but OpenRouter lists no reasoning support for ${config.model} — ` +
        `kept as-is, not clamped`,
    );
  }
  const cap = catalog.limitsFor(config.model)?.maxCompletionTokens;
  const want = config.sampling?.maxTokens;
  if (cap !== undefined && want !== undefined && want > cap) {
    out.push(
      `max_tokens:${want.toLocaleString()} is above ${config.model}'s output cap of ${cap.toLocaleString()} — ` +
        `kept as-is, not clamped; lower it with: jlcode config set "${config.name}" --max-tokens ${cap}`,
    );
  }
  return out;
}

/** Read the OpenRouter key for a config being created here. `--key` is bad form
 *  (it lands in shell history) and exists anyway, because every prompt gets a
 *  flag; without a terminal, the refusal names it. */
async function readKey(flags: Record<string, string | boolean>): Promise<string> {
  const flag = flagString(flags, "key");
  if (flag) return flag;
  if (process.env.JLCODE_ADD_KEY) return process.env.JLCODE_ADD_KEY;
  if (process.stdin.isTTY !== true) {
    throw new Error(
      "This folder has no model config yet, so one has to be created — and that needs an OpenRouter key.\n" +
        "No terminal to ask on — re-run with --key <secret> (or set JLCODE_ADD_KEY).",
    );
  }
  const key = await readSecret("OpenRouter API key (input hidden): ");
  if (!key) throw new Error("No key provided.");
  return key;
}

/** Settle the model id a bare-slug argument means, asking when it is ambiguous. */
async function chooseModelId(catalog: ModelCatalog, slug: string, warn: (s: string) => void): Promise<string> {
  const match = matchSlug(catalog, slug);
  if (match.kind === "offline") {
    warn(`the OpenRouter catalog isn't available — accepting "${slug}" as typed`);
    return slug;
  }
  if (match.kind === "unknown") {
    warn(`"${slug}" isn't in the OpenRouter catalog — accepting it as typed`);
    return slug;
  }
  if (match.ids.length === 1) return match.ids[0]!;
  return pickOne({
    title: `${match.ids.length} models match "${slug}":`,
    choices: match.ids.map((id) => ({ label: id, value: id })),
    flag: "--model <id>",
    example: `--model ${match.ids[0]}`,
  });
}

/** The bare `config model` picker: the models already set up under this folder's
 *  key, most-recently-used first (so the round trip is always `1`), with a final
 *  `other…` entry that searches the whole catalog. */
async function chooseFromFolder(
  store: Config,
  source: ModelConfig,
  bindingDir: string,
  catalog: ModelCatalog,
  warn: (s: string) => void,
): Promise<string> {
  const siblings = modelsUnderKey(store, { key: source.openRouterKey, dir: bindingDir, exclude: source.id });
  const choices: PickChoice<string | null>[] = siblings.map((c) => ({
    label: c.model,
    detail: `${c.name}  ${shortId(c.id)}`,
    value: c.model,
  }));
  // `null` is the escape hatch — "none of these", i.e. search the catalog.
  choices.push({ label: "other…  (search the OpenRouter catalog)", value: null });
  const picked = await pickOne({
    title:
      siblings.length > 0
        ? `Models already set up under this key (most recent first) — currently on ${source.model}:`
        : `No other model is set up under this key yet — currently on ${source.model}:`,
    choices,
    flag: "--model <id>",
    example: `--model ${siblings[0]?.model ?? "anthropic/claude-sonnet-5"}`,
  });
  if (picked !== null) return picked;
  const query = (await readLineOr("Search the catalog for", "")).trim();
  if (query === "") throw new Error("cancelled");
  return chooseModelId(catalog, query, warn);
}

/** Width of the label column in the report below — one number so the rows and
 *  the borrowed threshold lines can't drift out of alignment. */
const LABEL_WIDTH = 11;

export interface ModelCommandOptions {
  paths: JlcodePaths;
  cwd: string;
}

/**
 * `jlcode config model [<slug>] [flags]`. Returns the process exit code; every
 * refusal is thrown, so the CLI's own error path prints it.
 */
export async function runConfigModel(args: string[], opts: ModelCommandOptions): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals[0] === "help" || flags["help"] === true) {
    process.stdout.write(MODEL_HELP);
    return 0;
  }
  const { paths, cwd } = opts;
  const offline = Boolean(flags["offline"]);
  const warn = (text: string): void => {
    process.stderr.write(`warning: ${text}\n`);
  };

  const catalog = new ModelCatalog({ file: paths.modelsCacheFile });
  if (!offline) {
    const { error } = await catalog.refresh();
    if (error) warn(`could not refresh the model catalog — ${error}`);
  }

  const store = loadConfig(paths);
  // `--model` wins over the positional: it is the explicit answer to the
  // "which model did you mean" prompt, so a script that was told to pass it
  // must not be second-guessed by whatever argument was already there.
  const arg = flagString(flags, "model") ?? positionals[0];
  const binding = nearestBinding(store, cwd);

  if (!binding) return setUpUnboundFolder({ store, arg, flags, catalog, paths, cwd, offline, warn });

  const source = binding.config;
  const model = arg
    ? await modelFromArgument(store, arg, catalog, warn)
    : await chooseFromFolder(store, source, binding.dir, catalog, warn);

  // Now that the id is settled, make sure *this* model is in the catalog —
  // `refresh` above honours the TTL, so a model released since the last fetch
  // would otherwise get the fallback window and no price (the D-44c miss).
  if (!offline) await catalog.ensureKnown(model);

  const siblings = configsWithKeyAndModel(store, source.openRouterKey, model);

  // Outcome 1 of 3: already there. Named distinctly and writes nothing.
  if (siblings.some((c) => c.id === source.id)) {
    process.stdout.write(
      `Already on ${model} — nothing changed.\n` + `   ${source.name}  ${shortId(source.id)}\n`,
    );
    return 0;
  }

  const derivedName = deriveConfigName(binding.dir, model);
  let target: ModelConfig;
  let created: boolean;
  if (siblings.length === 0) {
    // `--name` overrides the derived name for the row about to be created; the
    // derived one is a good default, not a rule.
    const name = flagString(flags, "name") ?? derivedName;
    const { config: next, added } = addDerived(store, source, model, name, catalog);
    target = added;
    created = true;
    saveConfig(bindAndRemember(next, binding.dir, added.id), paths);
  } else {
    target =
      siblings.length === 1
        ? siblings[0]!
        : await chooseSibling(siblings, model, derivedName, flagString(flags, "config"));
    created = false;
    saveConfig(bindAndRemember(store, binding.dir, target.id), paths);
  }

  await report({ target, source, created, bindingDir: binding.dir, catalog, paths, offline });
  return 0;
}

/** An argument that could be a model slug, a config name, or — the case that
 *  needs the picker — both (D-82). Catalog matches out-vote nothing on their
 *  own: they are *offered beside* the config of the same name. */
async function modelFromArgument(
  store: Config,
  arg: string,
  catalog: ModelCatalog,
  warn: (s: string) => void,
): Promise<string> {
  const asConfig = findModelConfig(store, arg);
  const match = matchSlug(catalog, arg);
  const modelIds = match.kind === "known" ? match.ids : [];

  if (modelIds.length > 0 && asConfig) {
    return pickOne<string>({
      title: `"${arg}" is both a model and a config here — which did you mean?`,
      choices: [
        ...modelIds.map((id) => ({ label: `model ${id}`, value: id })),
        {
          label: `config "${asConfig.name}"`,
          detail: `switch this folder to its model, ${asConfig.model}`,
          value: asConfig.model,
        },
      ],
      flag: "--model <id>",
      example: `--model ${asConfig.model}`,
    });
  }
  if (modelIds.length > 0) return chooseModelId(catalog, arg, warn);
  if (asConfig) return asConfig.model;
  return chooseModelId(catalog, arg, warn); // unknown/offline → literal, with a warning
}

/** Two configs share this key *and* this model. The derived name is the
 *  tiebreak D-82 names, so it is offered first; beyond that the user picks —
 *  or has already answered with `--config`, which is the flag the refusal
 *  names. */
function chooseSibling(
  siblings: ModelConfig[],
  model: string,
  derivedName: string,
  ref: string | undefined,
): Promise<ModelConfig> {
  if (ref !== undefined) {
    const chosen = siblings.find((c) => c.id === ref || c.name === ref || c.name.toLowerCase() === ref.toLowerCase());
    if (!chosen) {
      return Promise.reject(
        new Error(
          `--config "${ref}" doesn't match any of the configs holding this key and ${model}: ` +
            siblings.map((c) => `"${c.name}"`).join(", "),
        ),
      );
    }
    return Promise.resolve(chosen);
  }
  const ordered = [...siblings].sort((a, b) => {
    const byName = Number(b.name === derivedName) - Number(a.name === derivedName);
    return byName !== 0 ? byName : a.name.localeCompare(b.name);
  });
  return pickOne({
    title: `${siblings.length} configs already hold this key and ${model} — which one should this folder use?`,
    choices: ordered.map((c) => ({
      label: c.name,
      detail: `${shortId(c.id)}  ${nonDefaultSettings(c).join("  ") || "all defaults"}`,
      value: c,
    })),
    flag: "--config <name|id>",
    example: `--config "${ordered[0]!.name}"`,
  });
}

/** Derive and add the sibling, with `pricing` re-derived from the catalog. */
function addDerived(
  store: Config,
  source: ModelConfig,
  model: string,
  name: string,
  catalog: ModelCatalog,
): { config: Config; added: ModelConfig } {
  return addModelConfig(
    store,
    deriveModelConfig(source, { model, name, pricing: catalog.pricingFor(model) }),
  );
}

/** A folder with no bound ancestor: create the config inline and bind it here,
 *  through the same helper `config add --use` uses (D-82). */
async function setUpUnboundFolder(ctx: {
  store: Config;
  arg: string | undefined;
  flags: Record<string, string | boolean>;
  catalog: ModelCatalog;
  paths: JlcodePaths;
  cwd: string;
  offline: boolean;
  warn: (s: string) => void;
}): Promise<number> {
  const { store, arg, flags, catalog, paths, cwd, offline, warn } = ctx;
  if (!arg) {
    throw new Error(
      `No model config is bound to ${cwd} or any folder above it, so there is no key to keep — ` +
        `name the model to set one up here.\n` +
        `  jlcode config model <slug> --key <secret>\n` +
        `…or bind an existing config first: jlcode config use <name>`,
    );
  }
  const model = await chooseModelId(catalog, arg, warn);
  if (!offline) await catalog.ensureKnown(model);
  const name = await readLineOr(
    "Name for this config",
    flagString(flags, "name") ?? deriveConfigName(cwd, model),
  );
  const openRouterKey = await readKey(flags);
  const { config: next, added } = createAndBind(
    store,
    {
      name,
      model,
      openRouterKey,
      defaultMode: "code",
      defaultApproval: "manual",
      compaction: { auto: true },
      ...(catalog.pricingFor(model) ? { pricing: catalog.pricingFor(model) } : {}),
    },
    cwd,
  );
  saveConfig(next, paths);
  process.stdout.write(`Created  ${added.name}  ${shortId(added.id)}   — this folder had no config, so one was set up\n`);
  process.stdout.write(`   ${"model".padEnd(LABEL_WIDTH)}${added.model}\n`);
  process.stdout.write(`   ${"bound".padEnd(LABEL_WIDTH)}${cwd}\n`);
  await report({ target: added, created: true, bindingDir: cwd, catalog, paths, offline, brief: true });
  return 0;
}

/**
 * State what you are now running under. The outcome line comes first and names
 * itself; everything under it exists so that no carried setting is inherited
 * invisibly (D-82) — including the ones that were *not* carried, which is the
 * half a person has no other way to notice.
 */
async function report(ctx: {
  target: ModelConfig;
  source?: ModelConfig;
  created: boolean;
  bindingDir: string;
  catalog: ModelCatalog;
  paths: JlcodePaths;
  offline: boolean;
  brief?: boolean;
}): Promise<void> {
  const { target, source, created, bindingDir, catalog, paths, offline } = ctx;
  const row = (label: string, value: string): void => {
    process.stdout.write(`   ${label.padEnd(LABEL_WIDTH)}${value}\n`);
  };

  if (!ctx.brief) {
    process.stdout.write(
      (created
        ? `Created  ${target.name}  ${shortId(target.id)}   — a new config now holds your key`
        : `Switched back to  ${target.name}  ${shortId(target.id)}   — an existing config; nothing was created`) +
        "\n",
    );
    row("model", `${target.model}${source ? `   (was ${source.model})` : ""}`);
    row("key", `unchanged${source ? ` — the one "${source.name}" uses` : ""}`);
    row("bound", bindingDir);
  }

  const price = formatPrice(catalog.pricingFor(target.model));
  const wasPrice = source ? formatPrice(catalog.pricingFor(source.model)) : undefined;
  if (price) row("price", `${price}${wasPrice ? `   (was ${wasPrice})` : ""}`);

  // "carried" only where something was in fact carried — a config created in a
  // folder that had none inherited nothing, and saying otherwise would invent a
  // provenance for settings that are simply the defaults.
  const settings = nonDefaultSettings(target);
  row(created && source ? "carried" : "settings", settings.length > 0 ? settings.join("  ") : "all defaults");

  // The four re-derived fields, shown as the numbers they produce (D-82). The
  // window and threshold come from the same code `config which` and `serve`
  // use, so this can never claim a budget the session won't run under.
  const { budget, source: windowSource } = await resolveBudget(target, paths, { offline, catalog });
  row("window", `${budget.window.toLocaleString()} tokens — ${describeWindowSource(windowSource)}`);
  process.stdout.write(thresholdLines(budget, " ".repeat(3 + LABEL_WIDTH)));
  const images = catalog.imageSupport(target.model);
  row("images", images === "yes" ? "yes" : images === "no" ? "no — text only" : "unknown to the catalog");

  for (const warning of catalogWarnings(catalog, target)) process.stderr.write(`  ⚠ ${warning}\n`);
}
