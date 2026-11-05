/**
 * The per-thread model picker's decisions (web/src/model-picker.ts, X-56/D-87,
 * P9b) — Tier-0, no DOM. The rulings these hold in place: groups by key with the
 * thread's group first; same key = one click; another key = an inline confirm
 * naming **both** fingerprints, every time; an unknown thread key always
 * confirms; the transcript marker reads the entry's snapshot.
 */
import { describe, it, expect } from "vitest";
import {
  confirmFromRefusal,
  crossKeyQuestion,
  editRefusalNotice,
  refusalBlocksView,
  restoredInput,
  groupHeading,
  isCurrentRow,
  keyLabel,
  missingNotice,
  pendingLabel,
  planPick,
  switchMarker,
} from "../web/src/model-picker";
import { ApiError, modelMissingOf, type ConfigGroup } from "../web/src/api";

const GROUPS: ConfigGroup[] = [
  {
    fingerprint: "aaaa",
    current: true,
    configs: [
      { id: "opus", name: "Opus", model: "anthropic/claude-opus-5" },
      { id: "sonnet", name: "Sonnet", model: "anthropic/claude-sonnet-5" },
    ],
  },
  { fingerprint: "bbbb", current: false, configs: [{ id: "sol", name: "Sol", model: "openai/gpt-5.6-sol" }] },
];

describe("planPick — what a click on a config row does", () => {
  it("the config already in force does nothing", () => {
    expect(planPick(GROUPS, "opus", "opus")).toEqual({ kind: "current" });
  });

  it("a same-key pick is one click — no confirm", () => {
    expect(planPick(GROUPS, "sonnet", "opus")).toEqual({ kind: "switch", configId: "sonnet" });
  });

  it("a cross-key pick confirms, naming both fingerprints", () => {
    expect(planPick(GROUPS, "sol", "opus")).toEqual({ kind: "confirm", configId: "sol", name: "Sol", from: "aaaa", to: "bbbb" });
  });

  it("asks again every time — nothing about a past confirm is remembered", () => {
    const first = planPick(GROUPS, "sol", "opus");
    const second = planPick(GROUPS, "sol", "opus");
    expect(first.kind).toBe("confirm");
    expect(second.kind).toBe("confirm");
  });

  it("with no group marked current (the thread's key is unknown) every pick confirms, from an unknown key", () => {
    const unknown = GROUPS.map((g) => ({ ...g, current: false }));
    expect(planPick(unknown, "opus", null)).toMatchObject({ kind: "confirm", from: null, to: "aaaa" });
    expect(planPick(unknown, "sol", null)).toMatchObject({ kind: "confirm", from: null, to: "bbbb" });
  });

  it("a deleted-config thread has no current row: re-picking the old config's id is a real switch", () => {
    expect(planPick(GROUPS, "opus", null)).toEqual({ kind: "switch", configId: "opus" });
  });

  it("a config that left the list is not guessed at", () => {
    expect(planPick(GROUPS, "gone", "opus")).toEqual({ kind: "unknown" });
  });
});

describe("what the picker says", () => {
  it("heads a group with its fingerprint and the config names in it", () => {
    expect(groupHeading(GROUPS[0]!)).toBe("key …aaaa — Opus, Sonnet");
    expect(groupHeading({ fingerprint: "", configs: [{ id: "x", name: "Bare", model: "m" }] })).toBe("no key — Bare");
  });

  it("labels masked and unknown keys honestly", () => {
    expect(keyLabel("****")).toBe("key ****");
    expect(keyLabel(null)).toBe("an unknown key");
  });

  it("the cross-key question names both keys and carries no cost or fit line", () => {
    const q = crossKeyQuestion({ name: "Sol", from: "aaaa", to: "bbbb" });
    expect(q).toContain("…aaaa");
    expect(q).toContain("…bbbb");
    expect(q).not.toMatch(/\$|cost|window|token/i);
  });

  it("with the thread's key unknown, it still names the target key and says why it is asking", () => {
    const q = crossKeyQuestion({ name: "Sol", from: null, to: "bbbb" });
    expect(q).toContain("…bbbb");
    expect(q).toMatch(/can't be confirmed/);
  });

  it("the chip's pending suffix names the pick, not a model it is not yet running", () => {
    expect(pendingLabel({ configId: "sol", name: "Sol", model: "openai/gpt-5.6-sol" })).toBe("→ Sol · pending");
  });

  it("the deleted-config notice asks for a pick and names what was lost", () => {
    const text = missingNotice({
      code: "model-config-missing",
      configId: "sonnet",
      snapshot: { name: "Sonnet", model: "anthropic/claude-sonnet-5" },
      message: "",
    });
    expect(text).toMatch(/no longer exists/);
    expect(text).toMatch(/pick one/);
    expect(text).toContain("anthropic/claude-sonnet-5");
  });
});

describe("the transcript marker reads the switch entry's snapshot", () => {
  it("name + model", () => {
    expect(switchMarker({ snapshot: { name: "Sol", model: "gpt-5.6-sol" } })).toBe("switched to Sol (gpt-5.6-sol)");
  });
  it("a config named after its model is not said twice", () => {
    expect(switchMarker({ snapshot: { name: "gpt-5.6-sol", model: "gpt-5.6-sol" } })).toBe("switched to gpt-5.6-sol");
  });
  it("no snapshot still marks the switch", () => {
    expect(switchMarker({})).toBe("switched model");
  });
});

describe("server refusals the picker acts on, by code", () => {
  it("a cross-key 409 becomes the confirm, using the server's fingerprints", () => {
    expect(confirmFromRefusal({ code: "cross-key", from: "aaaa", to: "bbbb", error: "…" }, "sol", "Sol")).toEqual({
      kind: "confirm",
      configId: "sol",
      name: "Sol",
      from: "aaaa",
      to: "bbbb",
    });
    expect(confirmFromRefusal({ code: "cross-key", from: null, to: "bbbb" }, "sol", "Sol")?.from).toBeNull();
    expect(confirmFromRefusal({ error: "no such model config" }, "sol", "Sol")).toBeNull();
  });

  it("a model-config-missing 409 is recognized by its code, not its wording", () => {
    const body = {
      error: "whatever the server says",
      code: "model-config-missing",
      configId: "sonnet",
      snapshot: { name: "Sonnet", model: "anthropic/claude-sonnet-5" },
      message: "This thread's model config…",
    };
    expect(modelMissingOf(new ApiError("x", 409, body))).toMatchObject({ configId: "sonnet", snapshot: body.snapshot });
    expect(modelMissingOf(new ApiError("no such model config", 409, { error: "no such model config" }))).toBeNull();
    expect(modelMissingOf(new Error("model-config-missing"))).toBeNull();
  });
});

describe("which refusals may block the pane (P9b round 1)", () => {
  it("send, retry and compact refuse for the branch in view; an edit does not", () => {
    expect(refusalBlocksView("send")).toBe(true);
    expect(refusalBlocksView("retry")).toBe(true);
    expect(refusalBlocksView("compact")).toBe(true);
    expect(refusalBlocksView("edit")).toBe(false);
  });

  it("an edit refusal is said as a notice naming the lost config", () => {
    const text = editRefusalNotice({ snapshot: { name: "Sonnet", model: "anthropic/claude-sonnet-5" } });
    expect(text).toContain("Sonnet (anthropic/claude-sonnet-5)");
    expect(text).toMatch(/no longer exists/);
  });
});

describe("handing refused text back to the composer", () => {
  it("fills an empty composer", () => {
    expect(restoredInput("", "carry on")).toBe("carry on");
    expect(restoredInput("   ", "carry on")).toBe("carry on");
  });
  it("never clobbers anything typed since", () => {
    expect(restoredInput("a newer thought", "carry on")).toBe("a newer thought");
  });
});

describe("a row is current only in the server's current group (P9b round 3)", () => {
  // An unswitched thread still holds Opus (key A) while its folder was re-bound
  // to Sol (key B): `/configs` marks B current, `inViewConfigId` says Opus.
  const rebound: ConfigGroup[] = GROUPS.map((g) => ({ ...g, current: !g.current }));

  it("the held config's row is not tagged current outside the current group", () => {
    expect(isCurrentRow(rebound[0]!, "opus", "opus")).toBe(false);
    expect(isCurrentRow(GROUPS[0]!, "opus", "opus")).toBe(true);
  });

  it("clicking it is a real pick — confirmed against the current group's key — never a no-op", () => {
    expect(planPick(rebound, "opus", "opus")).toEqual({ kind: "confirm", configId: "opus", name: "Opus", from: "bbbb", to: "aaaa" });
    expect(planPick(rebound, "sol", "opus")).toEqual({ kind: "switch", configId: "sol" });
  });
});
