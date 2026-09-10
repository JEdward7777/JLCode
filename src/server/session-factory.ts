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
import { Session, type SessionRetarget } from "../session/session.js";
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
 * Everything a Session derives from a model config *plus the catalog* — settled
 * in one place so construction and a live switch (X-40, D-82a) cannot disagree.
 *
 * The three that matter are the three the H-06/X-33 defects were made of: the
 * context window (no window → compaction never fires), the image capability
 * (which `read_file` both advertises and enforces), and the watchdog interval
 * (which `run_command`'s description states to the model). A retarget that
 * changed the model and left any of them behind would be the same bug wearing
 * the new feature's clothes.
 */
function deriveFromConfig(deps: SessionFactoryDeps, config: ModelConfig) {
  const windows = resolveWindows(config, deps.catalog);
  const { acceptsImages } = resolveImages(config, deps.catalog);
  const watchdogMinutes = commandWatchdogMinutes(config);
  return {
    windows,
    acceptsImages,
    watchdogMinutes,
    toolRounds: toolRoundBudget(config),
    tools: new ToolRegistry([
      ...defaultTools({ watchdogMinutes, acceptsImages }),
      askUserTool(),
      ...deps.mcpTools(),
    ]),
  };
}

/**
 * Re-point a **running** session at a different config (D-82a) — what the server
 * calls at the top of a user turn when `jlcode config model` has switched this
 * directory underneath an open thread.
 *
 * The workspace instructions are *not* re-read: X-15 makes that a once-per-
 * session read (the system prompt is the cached prefix, D-26), so an edited
 * `AGENTS.md` still applies to the next thread, not this one. The config's own
 * addendum does change, because that is part of the config being adopted.
 */
export function createSessionRetarget(deps: SessionFactoryDeps) {
  return (session: Session, config: ModelConfig): boolean => {
    const d = deriveFromConfig(deps, config);
    const retarget: SessionRetarget = {
      config,
      driver: deps.makeDriver(config),
      tools: d.tools,
      watchdogMs: d.watchdogMinutes * 60_000,
      maxToolIterations: d.toolRounds,
      contextWindow: d.windows.window,
      contextWindowSource: d.windows.source,
      compactorWindow: d.windows.compactorWindow,
      acceptsImages: d.acceptsImages,
    };
    return session.adoptConfig(retarget);
  };
}

/**
 * Build the `newSession` the server is handed. Reads config fresh on every call
 * so `jlcode config set/use` takes effect on the next thread without a restart.
 */
export function createSessionFactory(deps: SessionFactoryDeps) {
  return (config: ModelConfig, conversation?: Conversation): Session => {
    const cfg = loadConfig(deps.paths);
    const roots = [deps.cwd, ...(cfg.folderRoots?.[deps.cwd] ?? [])];
    // The window, the image capability, the watchdog, the tool-round budget and
    // the tool registry, all from one place — see `deriveFromConfig`, which a
    // live config switch runs again against the new config.
    const { windows, acceptsImages, watchdogMinutes, toolRounds, tools } = deriveFromConfig(deps, config);
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
    return new Session({
      config,
      driver: deps.makeDriver(config),
      tools,
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
      autoRetitle: config.autoRetitle === true,
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
