/**
 * The agent tools (X-56, D-88): `spawn_agent`, `send_message`, `list_models`,
 * the lifecycle three (P9f): `list_agents`, `close_agent`, `wake_agents`, and
 * `set_agent_mode` (P9f2, X-58).
 *
 * Thin by design — every decision (depth, key, names, the concurrency queue)
 * belongs to the coordinator behind `ctx.agents`, which is the one place that
 * can see the whole tree. What lives here is what the model reads, and that is
 * the part a live model has to find legible (P9c's one Tier-1 test).
 *
 * All of them are `meta` and non-mutating: they touch nothing outside the
 * conversation tree. A sub-agent's own writes are gated by its own mode and
 * approval policy, inherited from its parent, and its approvals go to the human
 * (Q10) — so spawning one cannot widen what the tree may do.
 *
 * `list_models` is a tool rather than a line in `spawn_agent`'s description
 * because the set of configs changes, and the tool definitions sit at the head
 * of the cached prefix (D-81): a changeable list there would re-bill the whole
 * window every time someone added a config.
 */
import { MODES, type Mode } from "../config/types.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export const SPAWN_AGENT = "spawn_agent";
export const SEND_MESSAGE = "send_message";
export const LIST_MODELS = "list_models";
export const LIST_AGENTS = "list_agents";
export const CLOSE_AGENT = "close_agent";
export const WAKE_AGENTS = "wake_agents";
export const SET_AGENT_MODE = "set_agent_mode";

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
          "to use your own model. `mode` makes the sub-agent stricter than you — \"ask\" (read-only) or " +
          "\"plan\" (markdown writes only) — never looser; omit it to give it your own mode.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "Everything the sub-agent needs to do the work and report back" },
            model: { type: "string", description: "A model config name from list_models (default: your own)" },
            mode: {
              type: "string",
              enum: [...MODES],
              description: "ask < plan < code. As strict as yours or stricter (default: your own mode)",
            },
          },
          required: ["task"],
        },
      },
    },
    execute(args, ctx) {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) return Promise.resolve({ content: "spawn_agent needs a non-empty `task`", isError: true });
      const model = typeof args.model === "string" && args.model.trim() !== "" ? args.model.trim() : undefined;
      const rawMode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
      if (rawMode !== "" && !(MODES as readonly string[]).includes(rawMode)) {
        return Promise.resolve({ content: `spawn_agent: \`mode\` is one of ${MODES.join(", ")}, not ${JSON.stringify(args.mode)}`, isError: true });
      }
      const mode = rawMode === "" ? undefined : (rawMode as Mode);
      return guarded(ctx, (agents) => agents.spawn(task, model, mode));
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

export function listAgentsTool(): Tool {
  return {
    name: LIST_AGENTS,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: LIST_AGENTS,
        description:
          "List your own sub-agents by name, with the model each runs on and how it stands (working, finished, " +
          "waiting on you, interrupted…). Closed ones are left out unless `show_closed` is true.",
        parameters: {
          type: "object",
          properties: { show_closed: { type: "boolean", description: "Also list the sub-agents you or the user closed" } },
        },
      },
    },
    execute(args, ctx) {
      return guarded(ctx, (agents) => agents.listAgents(args.show_closed === true));
    },
  };
}

export function closeAgentTool(): Tool {
  return {
    name: CLOSE_AGENT,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: CLOSE_AGENT,
        description:
          "Close one of your own sub-agents once you are done with it, to tidy your list: it stops whatever it " +
          "is doing, its own sub-agents fold away with it, and list_agents leaves it out. Nothing is deleted — a " +
          "send_message to it reopens it.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "The sub-agent's name, as spawn_agent gave it" } },
          required: ["name"],
        },
      },
    },
    execute(args, ctx) {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return Promise.resolve({ content: "close_agent needs the sub-agent's `name`", isError: true });
      return guarded(ctx, (agents) => agents.closeAgent(name));
    },
  };
}

export function wakeAgentsTool(): Tool {
  return {
    name: WAKE_AGENTS,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: WAKE_AGENTS,
        description:
          "Resume your sub-agents after an interruption (a restart, a crash, a stop): every open agent in your " +
          "tree that was cut off mid-turn, or has a message it never answered, carries on. Finished and closed " +
          "ones are left alone. Only the thread the user started can call this.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute(_args, ctx) {
      return guarded(ctx, (agents) => agents.wakeAgents());
    },
  };
}

export function setAgentModeTool(): Tool {
  return {
    name: SET_AGENT_MODE,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: SET_AGENT_MODE,
        description:
          "Change one of your own sub-agents' mode — e.g. one you started in \"ask\" that now needs \"code\" to do " +
          "the work. Any mode up to your own (ask < plan < code), never looser than you. It applies from the " +
          "sub-agent's next step and it is told; its context is kept. It does not start it working: if it is " +
          "idle, follow with send_message.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "The sub-agent's name, as spawn_agent gave it" },
            mode: { type: "string", enum: [...MODES], description: "ask < plan < code. At most your own mode" },
          },
          required: ["to", "mode"],
        },
      },
    },
    execute(args, ctx) {
      const to = typeof args.to === "string" ? args.to.trim() : "";
      if (!to) return Promise.resolve({ content: "set_agent_mode needs the sub-agent's name in `to`", isError: true });
      const mode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
      if (!(MODES as readonly string[]).includes(mode)) {
        return Promise.resolve({ content: `set_agent_mode: \`mode\` is one of ${MODES.join(", ")}, not ${JSON.stringify(args.mode)}`, isError: true });
      }
      return guarded(ctx, (agents) => agents.setAgentMode(to, mode as Mode));
    },
  };
}

/** The agent tools, in the order the model reads them. */
export function agentTools(): Tool[] {
  return [
    spawnAgentTool(),
    sendMessageTool(),
    listModelsTool(),
    listAgentsTool(),
    closeAgentTool(),
    wakeAgentsTool(),
    setAgentModeTool(),
  ];
}
