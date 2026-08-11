/**
 * The todo tools (X-31): `todo_read` and `todo_write`, the agent's half of a
 * list it shares with the person watching.
 *
 * Delivery is **pull, with a nudge** (Joshua's call). Nothing is injected per
 * turn — the guidance below is in the system prompt, the person's edits arrive
 * as a queued message saying only that the list changed, and the compaction
 * summary states the count. Reading is always the agent's move. Per-turn
 * injection was considered and rejected as premature; if drift shows up in real
 * use it is a small change on top of this.
 *
 * Both tools are `meta` and **non-mutating** on purpose. `mutates` in this
 * codebase means "has an effect outside the conversation, so an approval policy
 * gets a say" — the todo list has none: it lives in the conversation's own log
 * and the person can already rewrite it at will. Classifying it as a write would
 * put an approval card in front of every bullet point under `manual`, and would
 * let `read-only` stop the agent from keeping notes, which is nobody's idea of
 * what read-only means.
 */
import type { TodoAccess } from "../conversation/todos.js";
import { renderTodoList } from "../conversation/todos.js";
import type { Tool } from "./types.js";

export const TODO_READ = "todo_read";
export const TODO_WRITE = "todo_write";

/** The usage instructions that ride in the system prompt (the "nudge" half). */
export const TODO_GUIDANCE = [
  "## Todo list",
  "",
  `You share a todo list with the user. \`${TODO_READ}\` returns it; \`${TODO_WRITE}\` appends items and strikes them off.`,
  "",
  "- Keep it for work that spans several turns. A one-step request does not need a list.",
  `- **Read before you write.** \`${TODO_WRITE}\` is refused until you have read the current list at least once, and again after the user has edited it — they can add, reword, re-order and strike items at any time, so the list you remember may not be the list that exists.`,
  "- Strike items as you finish them, not in a batch at the end.",
  "- Address items by their exact text, or by the id shown on every read. Never by position.",
  "- The list survives compaction. When a summary tells you items are outstanding, read the list rather than guessing what they were.",
].join("\n");

export function todoReadTool(): Tool {
  return {
    name: TODO_READ,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: TODO_READ,
        description:
          "Read the shared todo list. Returns every item with its id and whether it is done. " +
          "The user can edit this list at any time, so read it before acting on what you remember of it.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute(_args, ctx) {
      if (!ctx.todos) return Promise.resolve({ content: "no todo list is available in this session", isError: true });
      return Promise.resolve({ content: renderTodoList(ctx.todos.read()) });
    },
  };
}

export function todoWriteTool(): Tool {
  return {
    name: TODO_WRITE,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: TODO_WRITE,
        description:
          "Change the shared todo list: append new items, strike finished ones, or un-strike one that " +
          "turned out not to be done. Items are addressed by their **exact** text or by the id from " +
          `${TODO_READ} — never by position, since the user may have re-ordered the list. A target that ` +
          "matches nothing is refused and the whole call is dropped, with the current list attached. " +
          `You must call ${TODO_READ} at least once, and again after the user edits the list, before a ` +
          "write is accepted. Returns the updated list.",
        parameters: {
          type: "object",
          properties: {
            add: {
              type: "array",
              items: { type: "string" },
              description: "New items to append, in order. Each must be distinct from every item already on the list.",
            },
            strike: {
              type: "array",
              items: { type: "string" },
              description: "Items to mark done, each given as its exact text or its id.",
            },
            unstrike: {
              type: "array",
              items: { type: "string" },
              description: "Items to put back to not-done, each given as its exact text or its id.",
            },
          },
        },
      },
    },
    execute(args, ctx) {
      if (!ctx.todos) return Promise.resolve({ content: "no todo list is available in this session", isError: true });
      const strings = (value: unknown): string[] | undefined =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
      const result = ctx.todos.write({
        add: strings(args.add),
        strike: strings(args.strike),
        unstrike: strings(args.unstrike),
      });
      return Promise.resolve(
        result.ok ? { content: renderTodoList(result.items) } : { content: result.error, isError: true },
      );
    },
  };
}

export function todoTools(): Tool[] {
  return [todoReadTool(), todoWriteTool()];
}
