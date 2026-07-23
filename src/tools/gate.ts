/**
 * Tool gates decide whether a tool call may run: `allow`, `deny`, or `prompt`
 * (Phase 3b). The mode∩approval gate lands in 3b; for now `AllowAllGate` runs
 * everything (used to wire and test the tool-execution loop).
 */
import type { GateDecision, Tool, ToolGate } from "./types.js";

export class AllowAllGate implements ToolGate {
  check(_tool: Tool, _args: Record<string, unknown>): GateDecision {
    return { kind: "allow" };
  }
}
