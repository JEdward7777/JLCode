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
          "Pause and ask the user one or more questions, then continue with their answers. Use when you need a " +
          "decision or missing information. For a single quick question pass `question` (+ optional `options`); " +
          "to ask several at once pass `questions`, each rendered as its own form field. " +
          "`options` are suggestions, never a menu the user is trapped in: they can always type an answer " +
          "instead, and can always decline to answer unless you mark the question `required`. A decline comes " +
          "back to you saying so — it means 'none of these', not the option you think is closest, so do not " +
          "substitute one. Continue with what you have and state your assumption, or ask something else.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "A single question (convenience for the one-question case)" },
            options: { type: "array", items: { type: "string" }, description: "Suggested answers for `question`" },
            required: { type: "boolean", description: "`question` may not be left blank (use sparingly)" },
            questions: {
              type: "array",
              description: "A structured multi-question form; each entry becomes one field",
              items: {
                type: "object",
                properties: {
                  header: { type: "string", description: "Short label/chip for the field" },
                  question: { type: "string" },
                  options: { type: "array", items: { type: "string" }, description: "Suggested answers" },
                  multiSelect: { type: "boolean", description: "Allow selecting several options" },
                  required: {
                    type: "boolean",
                    description:
                      "This field may not be left blank. Use sparingly — it removes the user's ability to " +
                      "decline. It never forces one of `options`; a typed answer still satisfies it.",
                  },
                },
                required: ["question"],
              },
            },
          },
        },
      },
    },
    // Never actually invoked — the Session handles it. Present for completeness.
    execute() {
      return Promise.resolve({ content: "ask_user is handled by the session", isError: true });
    },
  };
}
