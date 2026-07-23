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
          "to ask several at once pass `questions`, each rendered as its own form field.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "A single question (convenience for the one-question case)" },
            options: { type: "array", items: { type: "string" }, description: "Suggested answers for `question`" },
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
                  allowFreeText: { type: "boolean", description: "Allow a typed answer too" },
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
