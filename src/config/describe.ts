/**
 * The lines that state what a config will actually run under — the window,
 * where it came from, and where compaction fires.
 *
 * Extracted from `commands.ts` when `config model` (X-40) needed the same
 * answers: a switch has to print the *new* model's window and threshold, and a
 * second implementation of that arithmetic would be free to disagree with
 * `config which` — which is the exact failure H-06 was, a setting that looked
 * settled in one place and was missing in another.
 */
import type { JlcodePaths } from "../paths.js";
import { ModelCatalog, type WindowSource } from "../llm/models.js";
// The same function `serve` uses to settle a session's windows (D-60/H-06) —
// borrowed rather than re-derived, so nothing here can disagree with what the
// session will actually run under.
import { resolveWindows } from "../server/session-factory.js";
import {
  applyCompactorFit,
  computeBudget,
  describeThresholdSource,
  type CompactionBudget,
} from "../session/compaction.js";
import type { ModelConfig } from "./types.js";

/** A config id, trimmed to the length the CLI prints. */
export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * Settle the window *and* the compaction threshold a session for this config
 * would run under — D-60's window precedence (config > catalog > fallback) plus
 * X-27's threshold precedence (absolute > `window − buffer`), with the D-44a
 * compactor-fit guard applied last, exactly as `serve` does it. Refreshes the
 * catalog unless `--offline`; a catalog failure is reported, never fatal.
 */
export async function resolveBudget(
  config: ModelConfig,
  paths: JlcodePaths,
  opts: { offline?: boolean; catalog?: ModelCatalog } = {},
): Promise<{ budget: CompactionBudget; source: WindowSource; catalogError?: string }> {
  const catalog = opts.catalog ?? new ModelCatalog({ file: paths.modelsCacheFile });
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
export function thresholdLines(budget: CompactionBudget, indent = "    "): string {
  let out = `${indent}compacts above ${budget.threshold.toLocaleString()} tokens — ${describeThresholdSource(budget)}\n`;
  if (budget.refusedThreshold !== undefined) {
    out +=
      `${indent}⚠ compaction.thresholdTokens ${budget.refusedThreshold.toLocaleString()} is not below the window — ` +
      `ignored (it could never fire); set a lower --compaction-threshold\n`;
  }
  return out;
}
