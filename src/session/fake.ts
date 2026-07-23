/**
 * Fake LLM drivers for offline development and tests — so the walking skeleton
 * and the loop can be exercised without a live (paid) OpenRouter call.
 */
import type { ChatRequest, LlmDriver, StreamEvent } from "../llm/types.js";

export function scriptedDriver(
  script: StreamEvent[] | ((req: ChatRequest) => StreamEvent[]),
): LlmDriver {
  return {
    async *streamChat(req) {
      const events = typeof script === "function" ? script(req) : script;
      for (const ev of events) yield ev;
    },
  };
}

export function throwingDriver(message = "simulated provider error"): LlmDriver {
  return {
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncGenerator<StreamEvent> {
      throw new Error(message);
    },
  };
}

/** Streams "You said: <last user message>" a token at a time. */
export function echoDriver(): LlmDriver {
  return scriptedDriver((req) => {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const said = typeof lastUser?.content === "string" ? lastUser.content : "";
    const text = `You said: ${said}`;
    const events: StreamEvent[] = [{ type: "reasoning", delta: "(considering) " }];
    for (const token of text.split(/(\s+)/)) {
      if (token.length > 0) events.push({ type: "text", delta: token });
    }
    events.push({ type: "finish", reason: "stop" });
    events.push({ type: "usage", usage: { promptTokens: 8, completionTokens: text.length } });
    return events;
  });
}

function textReply(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const token of text.split(/(\s+)/)) if (token.length > 0) events.push({ type: "text", delta: token });
  events.push({ type: "finish", reason: "stop" });
  return events;
}

function toolCall(name: string, args: unknown): StreamEvent[] {
  return [
    { type: "tool_call", index: 0, id: `fake_${Date.now()}`, name, argsDelta: JSON.stringify(args) },
    { type: "finish", reason: "tool_calls" },
  ];
}

/**
 * An offline driver that can drive the *gated* flows (approvals, ask_user) end
 * to end for the browser — no spend, no key. It reacts to command prefixes in
 * the latest user message so a person can trigger each surface by hand:
 *
 *   write: <path> | <content>   → a write_file call (approval card)
 *   run: <command>              → a run_command call (approval card, edit-approve)
 *   read: <path>                → a read_file call
 *   ask: <question>             → a single-question ask_user form
 *   form:                       → a multi-question ask_user form
 *
 * Anything else echoes like {@link echoDriver}. Once a tool result comes back
 * (the latest message is no longer the user's), it gives a short final answer.
 */
export function fakeAgentDriver(): LlmDriver {
  return scriptedDriver((req) => {
    const last = req.messages[req.messages.length - 1];
    // A tool result (or anything non-user) just settled → wrap up the turn.
    if (!last || last.role !== "user") return textReply("Done — the tool ran and reported back.");

    const msg = typeof last.content === "string" ? last.content.trim() : "";
    const after = (p: string) => msg.slice(p.length).trim();

    if (msg.startsWith("write:")) {
      const [rawPath, ...rest] = after("write:").split("|");
      const path = (rawPath ?? "note.txt").trim() || "note.txt";
      const content = rest.join("|").trim() || "hello from JLCode\n";
      return toolCall("write_file", { path, content });
    }
    if (msg.startsWith("run:")) return toolCall("run_command", { command: after("run:") || "echo hi" });
    if (msg.startsWith("read:")) return toolCall("read_file", { path: after("read:") || "README.md" });
    if (msg.startsWith("ask:")) {
      return toolCall("ask_user", { question: after("ask:") || "How should I proceed?", options: ["Yes", "No"] });
    }
    if (msg.startsWith("form:")) {
      return toolCall("ask_user", {
        questions: [
          { header: "Store", question: "Which store should I use?", options: ["sqlite", "postgres"] },
          {
            header: "Targets",
            question: "Which environments?",
            options: ["dev", "staging", "prod"],
            multiSelect: true,
            allowFreeText: true,
          },
          { header: "Notes", question: "Anything else I should know?", allowFreeText: true },
        ],
      });
    }
    return echoReply(msg);
  });
}

function echoReply(said: string): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "reasoning", delta: "(considering) " }, ...textReply(`You said: ${said}`)];
  return events;
}
