/**
 * The agent tools (X-56, D-88): `spawn_agent`, `send_message`, `list_models`.
 *
 * Thin by design — every decision (depth, key, names, the concurrency queue)
 * belongs to the coordinator behind `ctx.agents`, which is the one place that
 * can see the whole tree. What lives here is what the model reads, and that is
 * the part a live model has to find legible (P9c's one Tier-1 test).
 *
 * All three are `meta` and non-mutating: they touch nothing outside the
 * conversation tree. A sub-agent's own writes are gated by its own mode and
 * approval policy, inherited from its parent, and its approvals go to the human
 * (Q10) — so spawning one cannot widen what the tree may do.
 *
 * `list_models` is a tool rather than a line in `spawn_agent`'s description
 * because the set of configs changes, and the tool definitions sit at the head
 * of the cached prefix (D-81): a changeable list there would re-bill the whole
 * window every time someone added a config.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";

export const SPAWN_AGENT = "spawn_agent";
export const SEND_MESSAGE = "send_message";
export const LIST_MODELS = "list_models";

const NO_TREE: ToolResult = { content: "sub-agents are not available in this session", isError: true };

/** Run an agent call, turning a refusal into the error result the model reads. */
async function guarded(ctx: ToolContext, run: (agents: NonNullable<ToolContext["agents"]>) => Promise<string> | string): Promise<ToolResult> {
  if (!ctx.agents) return NO_TREE;
  try {
    return { content: await run(ctx.agents) };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export function spawnAgentTool(): Tool {
  return {
    name: SPAWN_AGENT,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: SPAWN_AGENT,
        description:
          "Start a sub-agent: a separate agent that works on `task` in the background, in this same workspace, " +
          "with your permissions. Returns its name at once. Your turn then ends — do not wait or poll for it. " +
          "When the sub-agent finishes a turn you are sent a notice; it does not send its results unless asked, " +
          "so say in `task` what to report back with send_message, or ask it afterwards. Write `task` so it stands " +
          "on its own: the sub-agent cannot see your conversation. `model` is a name from list_models; omit it " +
          "to use your own model.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "Everything the sub-agent needs to do the work and report back" },
            model: { type: "string", description: "A model config name from list_models (default: your own)" },
          },
          required: ["task"],
        },
      },
    },
    execute(args, ctx) {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) return Promise.resolve({ content: "spawn_agent needs a non-empty `task`", isError: true });
      const model = typeof args.model === "string" && args.model.trim() !== "" ? args.model.trim() : undefined;
      return guarded(ctx, (agents) => agents.spawn(task, model));
    },
  };
}

export function sendMessageTool(): Tool {
  return {
    name: SEND_MESSAGE,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: SEND_MESSAGE,
        description:
          "Send a message to another agent: your parent agent (`to: \"parent\"`) or one of your sub-agents, by " +
          "the name spawn_agent gave it. It reaches them as a message from you — starting their turn if they are " +
          "idle, or landing before their next step if they are busy. Returns at once; any reply comes back later " +
          "as a message to you.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "\"parent\", or a sub-agent's name" },
            text: { type: "string", description: "The message" },
          },
          required: ["to", "text"],
        },
      },
    },
    execute(args, ctx) {
      const to = typeof args.to === "string" ? args.to.trim() : "";
      const text = typeof args.text === "string" ? args.text : "";
      if (!to || text.trim() === "") {
        return Promise.resolve({ content: "send_message needs a recipient `to` and a non-empty `text`", isError: true });
      }
      return guarded(ctx, (agents) => agents.send(to, text));
    },
  };
}

export function listModelsTool(): Tool {
  return {
    name: LIST_MODELS,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: LIST_MODELS,
        description:
          "List the models a sub-agent may run on — the model configs that share your OpenRouter key — by name " +
          "and model id. Pass a name as spawn_agent's `model`.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute(_args, ctx) {
      return guarded(ctx, (agents) => agents.listModels());
    },
  };
}

/** The three agent tools, in the order the model reads them. */
export function agentTools(): Tool[] {
  return [spawnAgentTool(), sendMessageTool(), listModelsTool()];
}
