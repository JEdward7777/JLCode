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
import type { ModelConfig } from "../config/types.js";
import type { JlcodePaths } from "../paths.js";
import type { LlmDriver } from "../llm/types.js";
import type { ModelCatalog, WindowSource } from "../llm/models.js";
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
    return new Session({
      config,
      driver: deps.makeDriver(config),
      tools: new ToolRegistry([...defaultTools(), askUserTool(), ...deps.mcpTools()]),
      sandbox: new Sandbox(roots),
      // Live-switchable gate (D-07/D-08): rebuilt when the user changes
      // mode/approval from the browser. Starts from the config defaults.
      mode: config.defaultMode,
      approval: config.defaultApproval,
      buildGate: (mode, approval) => new ModeApprovalGate(mode, approval, cfg.autoSafeAllowlist),
      conversation,
      // The compaction budget (D-44/D-44c). Without these two lines nothing in
      // Phase 6 can ever trigger — see the module comment.
      contextWindow: windows.window,
      contextWindowSource: windows.source,
      compactorWindow: windows.compactorWindow,
      // Name the thread after the first exchange (X-09) — the browser rail and
      // the tab title have somewhere to show it, so the extra call earns its keep.
      autoTitle: true,
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
