/**
 * The ask_user tool (D-18): the model calls it to pause and ask the user a
 * question. It isn't "executed" like other tools — the Session intercepts it,
 * enters the awaiting-input state, and resumes with the user's answer as the
 * tool result. The def below is what the model sees.
 */
import type { Tool } from "./types.js";

export const ASK_USER = "ask_user";

export function askUserTool(): Tool {
  return {
    name: ASK_USER,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: ASK_USER,
        description:
          "Pause and ask the user a question, then continue with their answer. Use when you need a decision or missing information.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" }, description: "Optional suggested answers" },
          },
          required: ["question"],
        },
      },
    },
    // Never actually invoked — the Session handles it. Present for completeness.
    execute() {
      return Promise.resolve({ content: "ask_user is handled by the session", isError: true });
    },
  };
}
