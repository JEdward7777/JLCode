import { describe, it, expect } from "vitest";
import { streamSSE, chunkToEvents, accumulate } from "../src/llm/stream";
import type { StreamEvent } from "../src/llm/types";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("streamSSE", () => {
  it("parses data lines and stops at [DONE]", async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const parsed: any[] = [];
    for await (const obj of streamSSE(body)) parsed.push(obj);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].choices[0].delta.content).toBe("He");
  });
});

describe("chunkToEvents + accumulate", () => {
  it("emits normalized events and folds them into a result", () => {
    const chunks = [
      { choices: [{ delta: { reasoning: "hmm" } }] },
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
    const events: StreamEvent[] = chunks.flatMap(chunkToEvents);
    const result = accumulate(events);
    expect(result.text).toBe("Hello");
    expect(result.reasoningText).toBe("hmm");
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.totalTokens).toBe(7);
  });

  it("assembles streamed tool-call arguments by index", () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write", arguments: '{"p' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ath":"a"}' } }] }, finish_reason: "tool_calls" }] },
    ];
    const result = accumulate(chunks.flatMap(chunkToEvents));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.function.name).toBe("write");
    expect(result.toolCalls[0]!.function.arguments).toBe('{"path":"a"}');
    expect(result.finishReason).toBe("tool_calls");
  });
});

/**
 * OpenRouter names the backend it routed to on every chunk. We capture it so a
 * conversation can pin later turns to the provider that minted its reasoning
 * signatures (D-49/H-02).
 */
describe("provider capture", () => {
  it("emits a provider event from a chunk's top-level field", () => {
    const events = chunkToEvents({ provider: "Anthropic", choices: [{ delta: { content: "hi" } }] });
    expect(events).toContainEqual({ type: "provider", name: "Anthropic" });
  });

  it("ignores a missing or empty provider rather than pinning to nothing", () => {
    expect(chunkToEvents({ choices: [{ delta: { content: "hi" } }] })).not.toContainEqual(
      expect.objectContaining({ type: "provider" }),
    );
    expect(chunkToEvents({ provider: "", choices: [{ delta: {} }] })).not.toContainEqual(
      expect.objectContaining({ type: "provider" }),
    );
  });

  it("keeps the first provider seen across a multi-chunk response", () => {
    const events: StreamEvent[] = [
      { type: "provider", name: "Anthropic" },
      { type: "text", delta: "hi" },
      { type: "provider", name: "Amazon Bedrock" },
    ];
    expect(accumulate(events).provider).toBe("Anthropic");
  });

  it("leaves provider undefined when none was reported", () => {
    expect(accumulate([{ type: "text", delta: "hi" }]).provider).toBeUndefined();
  });
});
