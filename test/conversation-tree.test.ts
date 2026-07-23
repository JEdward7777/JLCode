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

  it("forks a sibling branch when a parent is given explicitly", () => {
    let conv = newConversation();
    const u = appendEntry(conv, { type: "user", text: "q" });
    conv = u.conv;
    const a1 = appendEntry(conv, { type: "assistant", text: "branch A" });
    conv = a1.conv;
    // Fork off the user node instead of continuing from a1.
    const a2 = appendEntry(conv, { type: "assistant", text: "branch B" }, u.entry.id);
    conv = a2.conv;

    expect(childrenOf(conv, u.entry.id)).toHaveLength(2);
    expect(pathToLeaf(conv).map((e) => e.id)).toEqual([u.entry.id, a2.entry.id]);
    expect(pathToLeaf(conv, a1.entry.id).map((e) => e.id)).toEqual([u.entry.id, a1.entry.id]);
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
