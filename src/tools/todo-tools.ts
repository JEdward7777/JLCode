/**
 * The todo tools (X-31): `todo_read` and `todo_write`, the agent's half of a
 * list it shares with the person watching.
 *
 * Delivery is **pull, with a nudge** (Joshua's call). Nothing is injected per
 * turn — the guidance below is in the system prompt, the person's edits arrive
 * as a queued message carrying a capped diff of what changed (D-77), and the
 * compaction summary states the count. Reading is always the agent's move. Per-turn
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
  `You share a todo list with the user. \`${TODO_READ}\` returns it; \`${TODO_WRITE}\` adds items, rewords them, notes them and strikes them off.`,
  "",
  "- Keep it for work that spans several turns. A one-step request does not need a list.",
  `- **Read it once before your first write.** After that your own writes keep you current — every write hands back the whole list — so there is no need to re-read before each one. Read again when you are told the user edited the list, and after a rewind or a fork: the list follows the branch.`,
  "- Strike items as you finish them, not in a batch at the end.",
  `- **Reword an item when it goes stale** (\`edit\` with \`text\`) — an estimate you have overrun or a number that has moved is worse than no note at all. **Record the outcome when you strike it** (\`edit\` with \`note\`, e.g. "done — commit 6173b82"): the note lives on the list, where a compaction summary cannot blur it, and the transcript cannot.`,
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
          "Change the shared todo list: append new items, reword one or attach a short outcome note to " +
          "it, strike finished ones, or un-strike one that turned out not to be done. Items are " +
          `addressed by their **exact** text or by the id from ${TODO_READ} — never by position, since ` +
          "the user may have re-ordered the list. A target that matches nothing is refused and the " +
          "whole call is dropped, with the current list attached. Fields apply in the order " +
          "add → edit → strike → unstrike, so an item reworded in this same call must be addressed " +
          `after that by its new text or its id. You must call ${TODO_READ} at least once, and again ` +
          "after the user edits the list, before a write is accepted. Returns the whole list with the " +
          "rows this call changed marked.",
        parameters: {
          type: "object",
          properties: {
            add: {
              type: "array",
              items: { type: "string" },
              description: "New items to append, in order. Each must be distinct from every item already on the list.",
            },
            edit: {
              type: "array",
              description:
                "Reword items, and/or hang a short outcome note under them. Use this when wording goes " +
                "stale, and when striking something worth recording the result of.",
              items: {
                type: "object",
                properties: {
                  item: { type: "string", description: "The item to change: its exact text, or its id." },
                  text: { type: "string", description: "New wording. Omit to leave the wording alone." },
                  note: {
                    type: "string",
                    description:
                      'A short outcome to hang under the item, e.g. "done — commit 6173b82". Pass "" to clear it.',
                  },
                },
                required: ["item"],
              },
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
      const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
      const edits = Array.isArray(args.edit)
        ? args.edit
            .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
            .map((v) => ({ item: str(v.item) ?? "", text: str(v.text), note: str(v.note) }))
        : undefined;
      const result = ctx.todos.write({
        add: strings(args.add),
        edit: edits,
        strike: strings(args.strike),
        unstrike: strings(args.unstrike),
      });
      return Promise.resolve(
        result.ok
          ? { content: renderTodoList(result.items, result.changed) }
          : { content: result.error, isError: true },
      );
    },
  };
}

export function todoTools(): Tool[] {
  return [todoReadTool(), todoWriteTool()];
}
