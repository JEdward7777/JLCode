/** A registry of tools: name → Tool, and the ToolDef[] advertised to the model. */
import type { ToolDef } from "../llm/types.js";
import type { Tool } from "./types.js";
import { fileTools } from "./file-tools.js";
import { runCommandTool } from "./shell-tool.js";
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

/** The default native tool set: file tools + shell + the shared todo list. */
export function defaultTools(): Tool[] {
  return [...fileTools(), runCommandTool(), ...todoTools()];
}
