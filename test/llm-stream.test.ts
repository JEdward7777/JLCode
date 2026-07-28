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

/**
 * H-04: OpenRouter streams `reasoning_details` as deltas keyed by `index` — the
 * text arrives in pieces and the signature lands in a final fragment with no
 * text. Appending them stores N partial thinking blocks plus an orphan
 * signature, and the provider rejects the replay with
 * `Invalid signature in thinking block`. Shapes below are taken verbatim from a
 * real failing conversation (anthropic/claude-opus-5 via Amazon Bedrock).
 */
describe("reasoning_details assembly", () => {
  const fragments = [
    { type: "reasoning.text", text: "I", format: "anthropic-claude-v1", index: 0 },
    { type: "reasoning.text", text: " should just confirm", format: "anthropic-claude-v1", index: 0 },
    { type: "reasoning.text", text: " being asked.", format: "anthropic-claude-v1", index: 0 },
    { type: "reasoning.text", signature: "CAISlQIKhwEIEBgC", format: "anthropic-claude-v1", index: 0 },
  ];

  it("merges fragments sharing an index into one signed block", () => {
    const result = accumulate(fragments.map((f) => ({ type: "reasoning_details", value: [f] }) as StreamEvent));
    expect(result.reasoning).toEqual([
      {
        type: "reasoning.text",
        text: "I should just confirm being asked.",
        signature: "CAISlQIKhwEIEBgC",
        format: "anthropic-claude-v1",
        index: 0,
      },
    ]);
  });

  it("keeps distinct indices as separate blocks, in first-seen order", () => {
    const result = accumulate([
      { type: "reasoning_details", value: [{ type: "reasoning.text", text: "a", index: 0 }] },
      { type: "reasoning_details", value: [{ type: "reasoning.text", text: "x", index: 1 }] },
      { type: "reasoning_details", value: [{ type: "reasoning.text", text: "b", index: 0 }] },
      { type: "reasoning_details", value: [{ type: "reasoning.text", signature: "s1", index: 1 }] },
    ] as StreamEvent[]);
    expect(result.reasoning).toEqual([
      { type: "reasoning.text", text: "ab", index: 0 },
      { type: "reasoning.text", text: "x", signature: "s1", index: 1 },
    ]);
  });

  it("concatenates encrypted payloads too, not just text", () => {
    const result = accumulate([
      { type: "reasoning_details", value: [{ type: "reasoning.encrypted", data: "AAA", index: 0 }] },
      { type: "reasoning_details", value: [{ type: "reasoning.encrypted", data: "BBB", index: 0 }] },
    ] as StreamEvent[]);
    expect(result.reasoning).toEqual([{ type: "reasoning.encrypted", data: "AAABBB", index: 0 }]);
  });

  it("leaves un-indexed details appended, one entry each (other providers)", () => {
    const result = accumulate([
      { type: "reasoning_details", value: [{ type: "reasoning.text", text: "one" }] },
      { type: "reasoning_details", value: [{ type: "reasoning.text", text: "two" }] },
    ] as StreamEvent[]);
    expect(result.reasoning).toEqual([
      { type: "reasoning.text", text: "one" },
      { type: "reasoning.text", text: "two" },
    ]);
  });

  it("passes non-object details through untouched (stays opaque)", () => {
    const result = accumulate([
      { type: "reasoning_details", value: "opaque-blob" },
      { type: "reasoning_details", value: "another" },
    ] as StreamEvent[]);
    expect(result.reasoning).toEqual(["opaque-blob", "another"]);
  });

  it("does not merge across a whole-array delta either", () => {
    // Some chunks carry several fragments at once; they must still fold by index.
    const result = accumulate([
      { type: "reasoning_details", value: fragments },
    ] as StreamEvent[]);
    expect(result.reasoning).toHaveLength(1);
    expect((result.reasoning as Record<string, unknown>[])[0]!.signature).toBe("CAISlQIKhwEIEBgC");
  });
});
