/**
 * Provider-side prompt-cache breakpoints (D-26).
 *
 * The regression these guard is expensive and *silent*: JLCode declared a
 * `cache_control` field, never set it, and shipped ~24M full-price prompt tokens
 * across one 60-call conversation ($120, `cachedTokens: 0` on every single call).
 * Nothing failed — it just cost 8x more than it had to. So these assert on the
 * exact wire shape the provider needs, not merely that "a marker exists".
 */
import { describe, it, expect } from "vitest";
import { applyCacheBreakpoints, supportsCacheControl } from "../src/llm/cache-breakpoints";
import { OpenRouterClient } from "../src/llm/client";
import { requestSignature } from "../src/llm/cache";
import type { ChatMessage } from "../src/llm/types";

/** Indices carrying a breakpoint, in order. */
function marked(msgs: ReturnType<typeof applyCacheBreakpoints>): number[] {
  const out: number[] = [];
  msgs.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some((p) => p.cache_control)) out.push(i);
  });
  return out;
}

const CLAUDE = "anthropic/claude-opus-5";

describe("cache breakpoint placement (D-26)", () => {
  it("marks the stable system prefix and the last message", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "you are a coding agent" },
      { role: "user", content: "hello" },
    ];
    expect(marked(applyCacheBreakpoints(msgs, CLAUDE))).toEqual([0, 1]);
  });

  it("puts cache_control on the content part, not the message", () => {
    // The whole original bug: a message-level field is silently ignored by the
    // provider. Only a content-block marker actually buys the discount.
    const out = applyCacheBreakpoints([{ role: "system", content: "sys" }], CLAUDE);
    expect(out[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    });
    expect((out[0] as Record<string, unknown>).cache_control).toBeUndefined();
  });

  it("anchors a turn back, not one message back, when a turn ends in tool results", () => {
    // The regression that motivated the turn-aligned anchor: picking the
    // "second-to-last markable message" lands on an adjacent tool result, so the
    // anchor covers a near-identical prefix and is a wasted breakpoint.
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "find the TTS code" }, // 1 — the turn boundary
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", name: "grep", content: "match one" }, // 3
      { role: "tool", tool_call_id: "b", name: "grep", content: "match two" }, // 4
    ];
    expect(marked(applyCacheBreakpoints(msgs, CLAUDE))).toEqual([0, 1, 4]);
  });

  it("never exceeds the provider's 4-breakpoint limit", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 50; i++) {
      msgs.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
    }
    expect(marked(applyCacheBreakpoints(msgs, CLAUDE)).length).toBeLessThanOrEqual(4);
  });

  it("skips messages with no markable content", () => {
    // A pure tool-call assistant turn has `content: null` — marking it would
    // spend a breakpoint on a block the provider has nothing to hash.
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: "{}" } }] },
    ];
    expect(marked(applyCacheBreakpoints(msgs, CLAUDE))).toEqual([0, 1]);
  });

  it("leaves non-Anthropic models untouched", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const out = applyCacheBreakpoints(msgs, "openai/gpt-5");
    expect(marked(out)).toEqual([]);
    expect(out.every((m) => typeof m.content === "string" || m.content === null)).toBe(true);
    expect(supportsCacheControl("openai/gpt-5")).toBe(false);
    expect(supportsCacheControl("anthropic/claude-opus-5")).toBe(true);
  });

  it("does not mutate the caller's transcript or its D-24 signature", () => {
    // Breakpoints are a billing directive that cannot change model output, so
    // they must not leak into the local response cache key (D-24).
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const before = requestSignature({ model: CLAUDE, messages: msgs });
    applyCacheBreakpoints(msgs, CLAUDE);
    expect(requestSignature({ model: CLAUDE, messages: msgs })).toBe(before);
    expect(msgs[0]!.content).toBe("sys");
  });
});

describe("OpenRouterClient sends breakpoints on the wire", () => {
  it("marks content blocks in the POST body for a Claude model", async () => {
    let body: any;
    const fakeFetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body as string);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient({ apiKey: "sk-test", fetch: fakeFetch });
    for await (const _ of client.streamChat({
      model: CLAUDE,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    })) {
      /* drain */
    }

    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
