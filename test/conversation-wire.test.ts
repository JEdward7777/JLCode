import { describe, it, expect } from "vitest";
import { newConversation, appendEntry } from "../src/conversation/tree";
import { buildWireMessages } from "../src/conversation/wire";

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
