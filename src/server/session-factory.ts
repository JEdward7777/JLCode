/**
 * How `serve` builds a Session (H-06).
 *
 * This lives in its own module for one reason: it is the seam where the context
 * window was missing for a month. Every `Session` unit test injected a
 * `contextWindow` and passed, while the only factory that runs in production
 * passed none — so `compactionBudget()` was undefined for every real session and
 * the whole Phase 6 compaction machine never fired once. Testing *this function*
 * is the test that would have caught it; a test that builds its own Session
 * cannot, by construction.
 */
import { loadConfig, saveConfig } from "../config/store.js";
import { commandWatchdogMinutes, toolRoundBudget, projectInstructionsEnabled } from "../config/operations.js";
import { readWorkspaceInstructions, renderProjectInstructions } from "../workspace/instructions.js";
import type { ModelConfig } from "../config/types.js";
import type { JlcodePaths } from "../paths.js";
import type { LlmDriver } from "../llm/types.js";
import type { ImageSupport, ModelCatalog, WindowSource } from "../llm/models.js";
import { Session } from "../session/session.js";
import { ToolRegistry, defaultTools } from "../tools/registry.js";
import { askUserTool } from "../tools/ask-user.js";
import { Sandbox } from "../tools/sandbox.js";
import { ModeApprovalGate } from "../tools/mode-gate.js";
import type { Tool } from "../tools/types.js";
import type { Conversation } from "../conversation/types.js";

export interface SessionFactoryDeps {
  paths: JlcodePaths;
  /** The workspace the instance is fenced to. */
  cwd: string;
  makeDriver: (config: ModelConfig) => LlmDriver;
  /** Extra tools contributed by MCP servers (D-47). */
  mcpTools: () => Tool[];
  /** Resolved model catalog — supplies the context window (D-44c). */
  catalog: ModelCatalog;
}

export interface WindowResolution {
  window: number;
  source: WindowSource;
  compactorWindow: number | undefined;
}

/**
 * Whether this session may hand the model a picture (P8b, D-78c).
 *
 * The config wins when it says anything — the catalog can lag a model, and this
 * is the only way back from a wrong answer. Otherwise the catalog decides, and
 * an `"unknown"` model is treated as text-only: advertising a capability the
 * provider will 400 on costs a turn mid-task, while withholding one costs a
 * refusal that *names the reason*, which is the failure a person can act on.
 */
export function resolveImages(
  config: ModelConfig,
  catalog: ModelCatalog,
): { acceptsImages: boolean; support: ImageSupport } {
  const support = catalog.imageSupport(config.model);
  if (config.acceptsImages !== undefined) return { acceptsImages: config.acceptsImages, support };
  return { acceptsImages: support === "yes", support };
}

/**
 * Settle the windows a session runs under. The working model's window comes
 * from the config override, else the catalog, else a labelled fallback — it is
 * never undefined, which is the point of H-06. The compactor's window is only
 * resolved when a *different* summarizer is configured, since that is the only
 * case the compactor-fit guard (D-44a) bites in.
 */
export function resolveWindows(config: ModelConfig, catalog: ModelCatalog): WindowResolution {
  const { window, source } = catalog.resolve(config.model, config.compaction?.contextLength);
  const compactorId = config.compaction?.model;
  const compactorWindow =
    compactorId && compactorId !== config.model ? catalog.windowFor(compactorId) : undefined;
  return { window, source, compactorWindow };
}

/**
 * Build the `newSession` the server is handed. Reads config fresh on every call
 * so `jlcode config set/use` takes effect on the next thread without a restart.
 */
export function createSessionFactory(deps: SessionFactoryDeps) {
  return (config: ModelConfig, conversation?: Conversation): Session => {
    const cfg = loadConfig(deps.paths);
    const roots = [deps.cwd, ...(cfg.folderRoots?.[deps.cwd] ?? [])];
    const windows = resolveWindows(config, deps.catalog);
    // Can this model see? Settled here, once, and handed to `read_file` — which
    // uses it twice, for what the description advertises and for what the tool
    // actually does. Those two must not be able to disagree (X-33's lesson).
    const { acceptsImages } = resolveImages(config, deps.catalog);
    // The workspace's own instructions (X-15), read **here** and exactly once
    // per session — the same reason the module comment gives: the system prompt
    // is the cached prefix, so this read must not be per turn. Doing it per
    // session (not once per process) is what makes an edited AGENTS.md apply to
    // the next thread without a restart, matching how `loadConfig` above is
    // re-read on every call, and matching D-50: no live reload into a session
    // that is already running.
    const workspaceInstructions = projectInstructionsEnabled(config)
      ? readWorkspaceInstructions(deps.cwd)
      : undefined;
    // The command watchdog (X-33), read once here and used **twice**: the Session
    // arms the timer with it, and `run_command`'s description states it to the
    // model. Both come off this one line deliberately — a description promising a
    // check at 30 minutes while the timer fires at 5 is the H-06 failure with a
    // new face, a setting that looks stored and reaches only half of what it
    // governs.
    const watchdogMinutes = commandWatchdogMinutes(config);
    // The tool-round budget (D-79), resolved from the same `commands` group. A
    // setting that reaches no factory is the H-06 defect; this one governs when
    // the loop stops to ask whether it is still getting somewhere.
    const toolRounds = toolRoundBudget(config);
    return new Session({
      config,
      driver: deps.makeDriver(config),
      tools: new ToolRegistry([
        ...defaultTools({ watchdogMinutes, acceptsImages }),
        askUserTool(),
        ...deps.mcpTools(),
      ]),
      watchdogMs: watchdogMinutes * 60_000,
      maxToolIterations: toolRounds,
      sandbox: new Sandbox(roots),
      // Live-switchable gate (D-07/D-08): rebuilt when the user changes
      // mode/approval from the browser. Starts from the config defaults.
      mode: config.defaultMode,
      approval: config.defaultApproval,
      buildGate: (mode, approval) => new ModeApprovalGate(mode, approval, cfg.autoSafeAllowlist),
      projectInstructions: workspaceInstructions ? renderProjectInstructions(workspaceInstructions) : undefined,
      conversation,
      // The compaction budget (D-44/D-44c). Without these two lines nothing in
      // Phase 6 can ever trigger — see the module comment.
      contextWindow: windows.window,
      contextWindowSource: windows.source,
      compactorWindow: windows.compactorWindow,
      // Name the thread after the first exchange (X-09) — the browser rail and
      // the tab title have somewhere to show it, so the extra call earns its keep.
      autoTitle: true,
      // …and re-name it as it drifts (X-17), unless this config opted out. A
      // long thread keeps the label it earned on turn one otherwise, which is
      // exactly when a label matters most.
      autoRetitle: config.autoRetitle !== false,
      // The same one answer the native tools were built with, carried down to
      // the bridged MCP tools, which are built once per instance and so cannot
      // be told at construction (P8e).
      acceptsImages,
      onAddRoot: (dir) => {
        const current = loadConfig(deps.paths);
        const existing = current.folderRoots?.[deps.cwd] ?? [];
        if (!existing.includes(dir)) {
          saveConfig(
            { ...current, folderRoots: { ...(current.folderRoots ?? {}), [deps.cwd]: [...existing, dir] } },
            deps.paths,
          );
        }
      },
    });
  };
}
