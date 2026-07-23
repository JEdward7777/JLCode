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
