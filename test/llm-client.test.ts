import { describe, it, expect } from "vitest";
import { OpenRouterClient } from "../src/llm/client";
import { accumulate } from "../src/llm/stream";
import type { StreamEvent } from "../src/llm/types";

function sseResponse(chunks: string[], init?: ResponseInit): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

describe("OpenRouterClient", () => {
  it("streams events and sends a well-formed request", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: any, init: any) => {
      captured = { url: String(url), init };
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient({ apiKey: "sk-test", fetch: fakeFetch });
    const events: StreamEvent[] = [];
    for await (const ev of client.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      events.push(ev);
    }

    expect(accumulate(events).text).toBe("Hi");
    expect(captured!.url).toContain("/chat/completions");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("throws on a non-ok response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "bad", fetch: fakeFetch });
    await expect(async () => {
      for await (const _ of client.streamChat({ model: "m", messages: [] })) void _;
    }).rejects.toThrow(/401/);
  });
});
