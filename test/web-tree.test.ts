/**
 * The browser's read helpers over the conversation tree (web/src/tree.ts) mirror
 * the server-side ops (src/conversation/tree.ts) that drive branch navigation
 * (D-10/D-17). This guards the client copy against drift: active-path walking,
 * sibling enumeration (the ‹i/n› arrows), and descending to a branch tip.
 */
import { describe, it, expect } from "vitest";
import { pathToLeaf, childrenOf, leafOf } from "../web/src/tree";
import type { EntryView } from "../web/src/api";

/** A tiny tree: u1→a1 (branch A) and a sibling u2→a2 (branch B) off the root. */
const entries: EntryView[] = [
  { id: "u1", parent: null, type: "user", text: "q1" },
  { id: "a1", parent: "u1", type: "assistant", text: "answer 1" },
  { id: "u2", parent: null, type: "user", text: "q2" }, // edit-fork sibling of u1
  { id: "a2", parent: "u2", type: "assistant", text: "answer 2" },
];

describe("web tree helpers (branch nav, P5d)", () => {
  it("walks the active branch root→leaf", () => {
    expect(pathToLeaf(entries, "a1").map((e) => e.id)).toEqual(["u1", "a1"]);
    expect(pathToLeaf(entries, "a2").map((e) => e.id)).toEqual(["u2", "a2"]);
  });

  it("enumerates siblings for the ‹i/n› arrows", () => {
    expect(childrenOf(entries, null).map((e) => e.id)).toEqual(["u1", "u2"]);
    expect(childrenOf(entries, "u1").map((e) => e.id)).toEqual(["a1"]);
  });

  it("descends a sibling to its branch tip (rewind target)", () => {
    expect(leafOf(entries, "u2")).toBe("a2");
    expect(leafOf(entries, "u1")).toBe("a1");
  });

  it("tolerates an unknown leaf and a malformed cycle without hanging", () => {
    expect(pathToLeaf(entries, "nope")).toEqual([]);
    const cyclic: EntryView[] = [
      { id: "x", parent: "y", type: "user", text: "" },
      { id: "y", parent: "x", type: "user", text: "" },
    ];
    expect(pathToLeaf(cyclic, "x").length).toBeLessThanOrEqual(2);
  });
});
