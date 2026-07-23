import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { LlmCache, hashRequest, requestSignature, stableStringify } from "../src/llm/cache";
import type { AssistantResult, ChatRequest } from "../src/llm/types";

describe("stable signature + hashing", () => {
  it("stableStringify sorts object keys", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("is invariant to key order but sensitive to content", () => {
    const a: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.5 };
    const b: ChatRequest = { messages: [{ content: "hi", role: "user" }], model: "m", temperature: 0.5 };
    expect(requestSignature(a)).toBe(requestSignature(b));
    const c: ChatRequest = { model: "m", messages: [{ role: "user", content: "HI" }] };
    expect(hashRequest(a)).not.toBe(hashRequest(c));
  });
});

describe("LlmCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "jlcode-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const result: AssistantResult = { text: "cached", toolCalls: [], finishReason: "stop" };

  it("round-trips and uses a sharded, hash-named path", () => {
    const cache = new LlmCache(dir);
    expect(cache.get(req)).toBeUndefined();
    cache.put(req, result);
    expect(cache.get(req)).toEqual(result);

    const hash = hashRequest(req);
    expect(cache.pathFor(hash)).toBe(path.join(dir, hash.slice(0, 2), `${hash}.json`));
  });

  it("misses when the request changes", () => {
    const cache = new LlmCache(dir);
    cache.put(req, result);
    const changed: ChatRequest = { model: "m", messages: [{ role: "user", content: "different" }] };
    expect(cache.get(changed)).toBeUndefined();
  });
});
