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
