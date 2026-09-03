/** A registry of tools: name → Tool, and the ToolDef[] advertised to the model. */
import type { ToolDef } from "../llm/types.js";
import type { Tool } from "./types.js";
import { fileTools, type FileToolsOptions } from "./file-tools.js";
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
 * `options` carries the two things a tool can only learn from the session that
 * built it: the configured watchdog interval, which `run_command` states in its
 * description (X-33), and whether the model accepts images, which `read_file`
 * both advertises and acts on (P8b). Both are optional because every caller that
 * does not care — tests, bare embeddings — should get the conservative default:
 * the 30-minute watchdog the Session arms, and no images. Stating a capability
 * the session will not honour is the one outcome worth ruling out.
 */
export function defaultTools(options: ShellToolOptions & FileToolsOptions = {}): Tool[] {
  return [...fileTools(options), runCommandTool(options), ...todoTools()];
}
