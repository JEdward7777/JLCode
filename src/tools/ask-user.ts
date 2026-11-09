/**
 * The question tool (D-18): the model calls it to pause and ask a question. It
 * isn't "executed" like other tools — the Session intercepts it, enters the
 * awaiting-input state, and resumes with the answer as the tool result. The def
 * below is what the model sees.
 *
 * **Named `ask` since P9d (X-56 Q16/Q17, D-93)**, when it learned `to`: a
 * sub-agent may address its question to the person or to its parent agent, and
 * `ask_user(to: "parent")` would contradict itself. The old name is still
 * intercepted ({@link isAskTool}): every log written before the rename holds
 * `ask_user` calls, and a model reading that history may call it again.
 */
import type { Tool } from "./types.js";

export const ASK = "ask";
/** The name before P9d — never offered any more, still understood. */
export const ASK_USER = "ask_user";

/** Whether a tool call is the question tool, under either name. */
export function isAskTool(name: string): boolean {
  return name === ASK || name === ASK_USER;
}

export function askTool(): Tool {
  return {
    name: ASK,
    kind: "meta",
    mutates: false,
    def: {
      type: "function",
      function: {
        name: ASK,
        description:
          "Pause and ask one or more questions, then continue with the answers. Use when you need a " +
          "decision or missing information. `to` says who you are asking: \"user\" (the person) or \"parent\" (the " +
          "agent that started you, if you are a sub-agent — its reply is your answer). Omit it to ask whoever " +
          "started your current turn. Either way the person can see the question and may answer it themselves. " +
          "For a single quick question pass `question` (+ optional `options`); " +
          "to ask several at once pass `questions`, each rendered as its own form field. " +
          "`options` are suggestions, never a menu the user is trapped in: they can always type an answer " +
          "instead, and can always decline to answer unless you mark the question `required`. A decline comes " +
          "back to you saying so — it means 'none of these', not the option you think is closest, so do not " +
          "substitute one. Continue with what you have and state your assumption, or ask something else.",
        parameters: {
          type: "object",
          properties: {
            to: {
              type: "string",
              enum: ["user", "parent"],
              description: "Who to ask (default: whoever started your current turn)",
            },
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
      return Promise.resolve({ content: "ask is handled by the session", isError: true });
    },
  };
}

/** @deprecated The pre-P9d name; the tool is {@link askTool}. */
export const askUserTool = askTool;
