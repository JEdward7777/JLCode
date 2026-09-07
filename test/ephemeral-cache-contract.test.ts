/**
 * D-81 — the cache contract for **ephemeral asks**: the title question
 * (X-09/X-17) and the same-model compaction summary (D-29).
 *
 * Both append one instruction to the exact live transcript so the provider can
 * serve the prefix from prompt cache. That only works if the ask matches the
 * live request on every field the cache keys on. Anthropic renders
 * `tools -> system -> messages` and invalidates top-down, so dropping the tools
 * changes the prompt at byte zero; a `tool_choice` or `reasoning` change
 * invalidates the messages cache; and an unpinned route can land on a backend
 * that never saw the prefix.
 *
 * The original defect was invisible because every ephemeral-ask test built a
 * session with **no tools** — so "same tools as the live turn" was trivially
 * true. These tests give the session real tools and a provider pin, then assert
 * the ephemeral request against the live request that preceded it.
 *
 * Tier-1 (offline scripted driver — no live spend).
 */
import { describe, it, expect } from "vitest";
import { Session } from "../src/session/session";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { Sandbox } from "../src/tools/sandbox";
import type { ModelConfig } from "../src/config/types";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";

const SYS = "SYS";

const config: ModelConfig = {
  id: "cfg",
  name: "Test",
  openRouterKey: "sk",
  model: "work-model",
  defaultMode: "code",
  defaultApproval: "manual",
  reasoningEffort: "high", // so `reasoning` is actually on the live request
  createdAt: "",
  updatedAt: "",
};

/** A turn that reports which backend served it, so the conversation pins. */
function turn(text: string): StreamEvent[] {
  return [
    { type: "provider", name: "Anthropic" },
    { type: "text", delta: text },
    { type: "finish", reason: "stop" },
    { type: "usage", usage: { promptTokens: 50, completionTokens: 10 } },
  ];
}

function sequenceDriver(steps: StreamEvent[][]) {
  const requests: ChatRequest[] = [];
  let i = 0;
  const driver: LlmDriver = {
    // eslint-disable-next-line require-yield
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      requests.push(req);
      const step = steps[i++];
      if (!step) throw new Error(`sequenceDriver: script exhausted at #${i - 1}`);
      for (const ev of step) yield ev;
    },
  };
  return { driver, requests };
}

function newSession(driver: LlmDriver, opts: { autoTitle?: boolean } = {}) {
  return new Session({
    config,
    driver,
    systemPrompt: SYS,
    contextWindow: 200_000,
    tools: new ToolRegistry(fileTools()),
    sandbox: new Sandbox([process.cwd()]),
    ...opts,
  });
}

/** Everything the provider's cache keys on, ahead of the instruction. */
function cacheKeyedFields(req: ChatRequest) {
  return {
    model: req.model,
    tools: (req.tools ?? []).map((t) => t.function.name),
    provider: req.provider,
    reasoning: req.reasoning,
    tool_choice: req.tool_choice,
  };
}

describe("ephemeral asks ride the live prefix (D-81)", () => {
  it("compaction sends the live turn's tools, pin and reasoning — and no tool_choice", async () => {
    const { driver, requests } = sequenceDriver([turn("first answer"), turn("## Goal\nShip it.\n")]);
    const session = newSession(driver);

    await session.send("original request");
    // What a live turn would send *right now* — the prefix the ask must ride.
    // (Taken before the fold: compaction itself releases the pin, D-49/H-02.)
    const live = session.buildRequest();
    expect(await session.compact()).toBe(true);

    // The reference really does carry the things that matter — otherwise this
    // test would pass for the wrong reason, which is how D-81 survived.
    expect(live.tools?.length).toBeGreaterThan(0);
    expect(live.provider).toEqual({ order: ["Anthropic"], allow_fallbacks: false });
    expect(live.reasoning).toEqual({ effort: "high" });

    const ask = requests[1]!;
    expect(cacheKeyedFields(ask)).toEqual(cacheKeyedFields(live));
    expect(ask.tool_choice).toBeUndefined();
  });

  it("the title ask does the same", async () => {
    const { driver, requests } = sequenceDriver([turn("first answer"), turn("A Good Name")]);
    const session = newSession(driver, { autoTitle: true });

    await session.send("original request");
    expect(session.conversation.title).toBe("A Good Name");

    // The title fires mid-run, so state the contract explicitly rather than
    // against a snapshot: same model, same tools, the pin the answered turn
    // established, the same reasoning — and no `tool_choice`.
    const ask = requests[1]!;
    expect(requests[0]!.tools?.length).toBeGreaterThan(0);
    expect(cacheKeyedFields(ask)).toEqual({
      model: "work-model",
      tools: (requests[0]!.tools ?? []).map((t) => t.function.name),
      provider: { order: ["Anthropic"], allow_fallbacks: false },
      reasoning: { effort: "high" },
      tool_choice: undefined,
    });
  });

  it("a cross-model compactor inherits neither the pin nor the tools", async () => {
    // Caches are model-scoped, so there is no prefix to ride — and the working
    // model's pin would point the compactor at the wrong backend entirely.
    const { driver, requests } = sequenceDriver([turn("first answer"), turn("## Goal\nShip it.\n")]);
    const session = new Session({
      config: { ...config, compaction: { auto: false, model: "cheap-model" } },
      driver,
      systemPrompt: SYS,
      contextWindow: 200_000,
      tools: new ToolRegistry(fileTools()),
      sandbox: new Sandbox([process.cwd()]),
    });

    await session.send("original request");
    expect(await session.compact()).toBe(true);

    const ask = requests[1]!;
    expect(ask.model).toBe("cheap-model");
    expect(ask.tools).toBeUndefined();
    expect(ask.provider).toBeUndefined();
    expect(ask.reasoning).toBeUndefined();
    // …and with no cache at stake, the hard prose guarantee is free.
    expect(ask.tool_choice).toBe("none");
  });
});
