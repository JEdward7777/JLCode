/** A registry of tools: name → Tool, and the ToolDef[] advertised to the model. */
import type { ToolDef } from "../llm/types.js";
import type { Tool } from "./types.js";
import { fileTools } from "./file-tools.js";
import { runCommandTool, type ShellToolOptions } from "./shell-tool.js";
import { todoTools } from "./todo-tools.js";

export class ToolRegistry {
  private readonly map = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const tool of tools) this.map.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.map.get(name);
  }

  all(): Tool[] {
    return [...this.map.values()];
  }

  defs(): ToolDef[] {
    return this.all().map((t) => t.def);
  }
}

/**
 * The default native tool set: file tools + shell + the shared todo list.
 *
 * `options` reaches `run_command` only, and only to state the configured
 * watchdog interval in its description (X-33). It is optional because every
 * caller that does not care — tests, bare embeddings — should get the same
 * 30-minute default the Session arms, and stating a number the session will not
 * honour is the one outcome worth ruling out.
 */
export function defaultTools(options: ShellToolOptions = {}): Tool[] {
  return [...fileTools(), runCommandTool(options), ...todoTools()];
}
