import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { CachingDriver } from "../src/llm/caching-driver";
import { LlmCache } from "../src/llm/cache";
import { accumulate } from "../src/llm/stream";
import { scriptedDriver, throwingDriver } from "../src/session/fake";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";

let dir: string;
let cache: LlmCache;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-cachedrv-"));
  cache = new LlmCache(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hello" }] };

async function collect(driver: LlmDriver, request: ChatRequest) {
  const events: StreamEvent[] = [];
  for await (const ev of driver.streamChat(request)) events.push(ev);
  return accumulate(events);
}

/** A driver that counts how many times it was actually invoked. */
function countingDriver(text: string): { driver: LlmDriver; calls: () => number } {
  let calls = 0;
  const driver: LlmDriver = {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      calls++;
      yield { type: "text", delta: text };
      yield { type: "finish", reason: "stop" };
    },
  };
  return { driver, calls: () => calls };
}

describe("CachingDriver", () => {
  it("records on a miss, then a HIT is served without calling the model", async () => {
    // 1) Record: real driver runs and the result is cached.
    const rec = await collect(new CachingDriver(scriptedDriver([
      { type: "text", delta: "Hi from the model" },
      { type: "finish", reason: "stop" },
    ]), cache), req);
    expect(rec.text).toBe("Hi from the model");

    // 2) Prove the hit: underlying driver THROWS if called — but we still get
    //    the cached result, so the model was never invoked.
    const cachedOnly = new CachingDriver(throwingDriver("LLM was called — cache MISS!"), cache);
    const hit = await collect(cachedOnly, req);
    expect(hit.text).toBe("Hi from the model"); // no throw → served from cache
  });

  it("a cache MISS does call through (guards the test above)", async () => {
    const cachedOnly = new CachingDriver(throwingDriver("called"), cache);
    const other: ChatRequest = { model: "m", messages: [{ role: "user", content: "different" }] };
    await expect(collect(cachedOnly, other)).rejects.toThrow(/called/);
  });

  it("calls the model exactly once across two identical requests", async () => {
    const { driver, calls } = countingDriver("cached");
    const cd = new CachingDriver(driver, cache);
    await collect(cd, req);
    await collect(cd, req);
    expect(calls()).toBe(1); // second request served from cache
  });

  it("round-trips reasoning and tool calls through the cache", async () => {
    const recording = scriptedDriver([
      { type: "reasoning", delta: "thinking" },
      { type: "reasoning_details", value: { sig: "abc" } },
      { type: "tool_call", index: 0, id: "c1", name: "write_file", argsDelta: '{"path":"a"}' },
      { type: "finish", reason: "tool_calls" },
    ]);
    await collect(new CachingDriver(recording, cache), req);
    const hit = await collect(new CachingDriver(throwingDriver(), cache), req);
    expect(hit.reasoning).toEqual([{ sig: "abc" }]);
    expect(hit.reasoningText).toBe("thinking");
    expect(hit.toolCalls[0]!.function).toEqual({ name: "write_file", arguments: '{"path":"a"}' });
    expect(hit.finishReason).toBe("tool_calls");
  });
});
