import { describe, it, expect } from "vitest";
import { newConversation, appendEntry } from "../src/conversation/tree";
import { buildWireMessages, pinnedProvider } from "../src/conversation/wire";

describe("buildWireMessages", () => {
  it("maps user/assistant/tool entries and round-trips reasoning verbatim", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "hi" }).conv;
    conv = appendEntry(conv, {
      type: "assistant",
      text: "hello",
      reasoning: [{ type: "reasoning.encrypted", data: "abc", signature: "sig" }],
      reasoningText: "thinking…",
    }).conv;

    const msgs = buildWireMessages(conv, { system: "SYS" });
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
    expect(msgs[2]!.role).toBe("assistant");
    expect(msgs[2]!.content).toBe("hello");
    // Opaque reasoning is replayed verbatim (D-14); reasoningText is NOT sent.
    expect(msgs[2]!.reasoning_details).toEqual([
      { type: "reasoning.encrypted", data: "abc", signature: "sig" },
    ]);
    expect("reasoningText" in msgs[2]!).toBe(false);
  });

  it("applies compaction overlay: drops earlier turns, injects the summary", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "old q" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "old a" }).conv;
    conv = appendEntry(conv, { type: "compaction", summary: "SUMMARY", replayCut: true }).conv;
    conv = appendEntry(conv, { type: "user", text: "new q" }).conv;

    const msgs = buildWireMessages(conv, { system: "SYS" });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(msgs[1]!.content).toContain("SUMMARY");
    expect(msgs[2]!.content).toBe("new q");
    // The pre-compaction "old q"/"old a" are not sent.
    expect(JSON.stringify(msgs)).not.toContain("old a");
  });
});

/**
 * Provider pinning (D-49/H-02). Reasoning signatures are only verifiable by the
 * backend that minted them, so the replayed window decides where the next turn
 * must go. Derived from entries, not stored separately — hence the fold tests.
 */
describe("pinnedProvider", () => {
  it("returns undefined with no assistant turns, so routing stays free", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "hi" }).conv;
    expect(pinnedProvider(conv)).toBeUndefined();
  });

  it("pins to the first assistant turn's provider, not the most recent", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "q1" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "a1", provider: "Anthropic" }).conv;
    conv = appendEntry(conv, { type: "user", text: "q2" }).conv;
    // A later turn served elsewhere must not move the pin: the signatures from
    // a1 are still in the replayed history and only Anthropic can verify them.
    conv = appendEntry(conv, { type: "assistant", text: "a2", provider: "Amazon Bedrock" }).conv;
    expect(pinnedProvider(conv)).toBe("Anthropic");
  });

  it("does not pin for logs written before providers were recorded", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "q" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "a" }).conv; // no provider
    expect(pinnedProvider(conv)).toBeUndefined();
  });

  it("releases the pin at a compaction cut, where no signatures survive", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "q1" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "a1", provider: "Anthropic" }).conv;
    conv = appendEntry(conv, { type: "compaction", summary: "S", replayCut: true }).conv;
    conv = appendEntry(conv, { type: "user", text: "q2" }).conv;
    // The summary drops reasoning_details, so there is nothing left to verify
    // and OpenRouter may route freely again.
    expect(pinnedProvider(conv)).toBeUndefined();
  });

  it("re-pins to the first turn served after the cut", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "assistant", text: "a1", provider: "Anthropic" }).conv;
    conv = appendEntry(conv, { type: "compaction", summary: "S", replayCut: true }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "a2", provider: "Google Vertex" }).conv;
    expect(pinnedProvider(conv)).toBe("Google Vertex");
  });

  it("follows the active branch, so a fork inherits its own path's pin", () => {
    let conv = newConversation();
    const root = appendEntry(conv, { type: "user", text: "q" });
    conv = root.conv;
    const a = appendEntry(conv, { type: "assistant", text: "a1", provider: "Anthropic" });
    conv = a.conv;
    // Sibling branch off the same parent, served by a different backend.
    const b = appendEntry(conv, { type: "assistant", text: "a2", provider: "Amazon Bedrock" }, root.entry.id);
    conv = b.conv;
    expect(pinnedProvider(conv, a.entry.id)).toBe("Anthropic");
    expect(pinnedProvider(conv, b.entry.id)).toBe("Amazon Bedrock");
  });
});
