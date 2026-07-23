/**
 * A driver that serves responses from the request-keyed cache (D-24). On a
 * cache **hit** it replays the recorded result as a synthesized stream and
 * **never calls the underlying driver** — that's what makes cached tests cost
 * zero. On a **miss** it calls through, forwards the stream, and records the
 * accumulated result. The request signature never includes our generated ids
 * (verified elsewhere), so replay is deterministic.
 */
import { accumulate } from "./stream.js";
import type { LlmCache } from "./cache.js";
import type { AssistantResult, ChatRequest, LlmDriver, StreamEvent } from "./types.js";

/** Reconstruct a stream from a recorded result (accumulate() folds it back). */
function* replay(result: AssistantResult): Generator<StreamEvent> {
  if (result.reasoningText) yield { type: "reasoning", delta: result.reasoningText };
  if (result.reasoning !== undefined) yield { type: "reasoning_details", value: result.reasoning };
  if (result.text) yield { type: "text", delta: result.text };
  for (let i = 0; i < result.toolCalls.length; i++) {
    const t = result.toolCalls[i]!;
    yield { type: "tool_call", index: i, id: t.id, name: t.function.name, argsDelta: t.function.arguments };
  }
  yield { type: "finish", reason: result.finishReason };
  if (result.usage) yield { type: "usage", usage: result.usage };
}

export class CachingDriver implements LlmDriver {
  constructor(
    private readonly inner: LlmDriver,
    private readonly cache: LlmCache,
  ) {}

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const hit = this.cache.get(req);
    if (hit) {
      yield* replay(hit); // served from cache — the underlying driver is NOT called
      return;
    }
    const events: StreamEvent[] = [];
    for await (const ev of this.inner.streamChat(req)) {
      events.push(ev);
      yield ev;
    }
    this.cache.put(req, accumulate(events));
  }
}
