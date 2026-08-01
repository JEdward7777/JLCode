import { describe, it, expect } from "vitest";
import { newConversation, appendEntry, pathToLeaf, setActiveLeaf, childrenOf } from "../src/conversation/tree";

describe("conversation tree", () => {
  it("appends along the active branch and advances the leaf", () => {
    let conv = newConversation();
    expect(conv.activeLeaf).toBeNull();
    const a = appendEntry(conv, { type: "user", text: "hi" });
    conv = a.conv;
    expect(a.entry.parent).toBeNull();
    expect(conv.activeLeaf).toBe(a.entry.id);
    const b = appendEntry(conv, { type: "assistant", text: "hello" });
    conv = b.conv;
    expect(b.entry.parent).toBe(a.entry.id);
    expect(pathToLeaf(conv).map((e) => e.id)).toEqual([a.entry.id, b.entry.id]);
  });

  it("forks a sibling branch when a parent is given explicitly, leaving the leaf put", () => {
    let conv = newConversation();
    const u = appendEntry(conv, { type: "user", text: "q" });
    conv = u.conv;
    const a1 = appendEntry(conv, { type: "assistant", text: "branch A" });
    conv = a1.conv;
    // Fork off the user node instead of continuing from a1.
    const a2 = appendEntry(conv, { type: "assistant", text: "branch B" }, u.entry.id);
    conv = a2.conv;

    expect(childrenOf(conv, u.entry.id)).toHaveLength(2);
    // Both branches exist, but the *reader's* pointer only follows an append
    // that continues the branch it points at (H-05) — this one didn't.
    expect(conv.activeLeaf).toBe(a1.entry.id);
    expect(pathToLeaf(conv).map((e) => e.id)).toEqual([u.entry.id, a1.entry.id]);
    expect(pathToLeaf(conv, a2.entry.id).map((e) => e.id)).toEqual([u.entry.id, a2.entry.id]);
  });

  it("rewinds by moving the active leaf up", () => {
    let conv = newConversation();
    const u = appendEntry(conv, { type: "user", text: "q" });
    conv = u.conv;
    const a = appendEntry(conv, { type: "assistant", text: "a" });
    conv = a.conv;
    conv = setActiveLeaf(conv, u.entry.id);
    expect(pathToLeaf(conv).map((e) => e.id)).toEqual([u.entry.id]);
  });
});
