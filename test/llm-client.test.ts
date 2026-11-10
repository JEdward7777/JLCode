import { describe, it, expect } from "vitest";
import { OpenRouterClient, midStreamError } from "../src/llm/client";
import { HttpError } from "../src/llm/errors";
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

  it("sends a provider block verbatim, keys JLCode does not name included — D-86", async () => {
    let body: Record<string, unknown> | undefined;
    const fakeFetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body as string);
      return sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "sk-test", fetch: fakeFetch });
    const provider = { only: ["openai/flex"], allow_fallbacks: false, sort: "price" };
    for await (const _ of client.streamChat({ model: "m", messages: [], provider })) void _;
    expect(body!.provider).toEqual(provider);
  });

  it("throws on a non-ok response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "bad", fetch: fakeFetch });
    await expect(async () => {
      for await (const _ of client.streamChat({ model: "m", messages: [] })) void _;
    }).rejects.toThrow(/401/);
  });

  it("raises an error OpenRouter sends inside a 200 stream as an HttpError — D-95", async () => {
    const fakeFetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
        'data: {"choices":[],"error":{"code":429,"message":"rate-limited upstream"}}\n\n',
        "data: [DONE]\n\n",
      ])) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "sk", fetch: fakeFetch });
    const seen: StreamEvent[] = [];
    let thrown: unknown;
    try {
      for await (const ev of client.streamChat({ model: "m", messages: [] })) seen.push(ev);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(429);
    expect((thrown as Error).message).toMatch(/rate-limited upstream/);
    expect(accumulate(seen).text).toBe("par"); // what came before still streamed
  });

  it("maps a mid-stream error without an HTTP code to 502", () => {
    expect(midStreamError({ choices: [] })).toBeUndefined();
    expect(midStreamError({ error: { code: "server_error", message: "boom" } })?.status).toBe(502);
    expect(midStreamError({ error: "plain string" })?.message).toMatch(/plain string/);
    expect(midStreamError({ error: { code: 503, message: "busy" } })?.status).toBe(503);
  });
});
