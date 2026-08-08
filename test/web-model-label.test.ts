/**
 * The header model chip's elision rule (D-71) — `web/src/model-label.ts`.
 *
 * The defect this locks down was a one-line CSS default: `text-overflow:
 * ellipsis` cuts the **end**, so the chip rendered `openai/gpt-4o-mi…` — vendor
 * kept, model hidden. Everything asserted here is a variation on "the tail
 * survives", because the tail is where the part you cannot infer lives:
 * `anthropic/claude-opus-5:online` and `anthropic/claude-opus-5` differ only in
 * their last seven characters, and that difference decides whether the model
 * gets web search.
 *
 * Tier-0: a pure string function, no DOM, no React.
 */
import { describe, it, expect } from "vitest";
import { fitModelLabel, MODEL_CHIP_CHARS } from "../web/src/model-label";

/** The ids Joshua actually runs — the set the budget was chosen against. */
const REAL_IDS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5:online",
  "deepseek/deepseek-r1",
  "peek/model",
];

describe("what the chip shows when everything fits", () => {
  it("shows the id untouched — no cleverness in the common case", () => {
    expect(fitModelLabel("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(fitModelLabel("peek/model")).toBe("peek/model");
  });

  it("keeps the vendor when there is room for it", () => {
    // The vendor is dropped because it is the *inferable* part, not because it
    // is unwanted; at 23 characters `anthropic/` costs nothing.
    expect(fitModelLabel("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
  });

  it("has an empty answer for an empty id — the caller supplies the word", () => {
    expect(fitModelLabel("")).toBe("");
    expect(fitModelLabel("   ")).toBe("");
  });
});

describe("what it drops first: the vendor, never the model", () => {
  it("keeps the variant suffix that lives at the end", () => {
    // 30 characters against a 28-character budget. The old behaviour cut
    // `:online` off; this cuts `anthropic/`.
    expect(fitModelLabel("anthropic/claude-opus-5:online")).toBe("…/claude-opus-5:online");
  });

  it("says a vendor was dropped rather than pretending there was none", () => {
    const short = fitModelLabel("openai/gpt-4o-mini", 14);
    expect(short).toBe("…/gpt-4o-mini");
    expect(short.startsWith("…/")).toBe(true);
  });

  it("peels further namespace segments before touching the model name", () => {
    // OpenRouter ids are `vendor/model`, but a proxied one can be deeper.
    expect(fitModelLabel("openrouter/anthropic/claude-opus-5:online", 28)).toBe("…/claude-opus-5:online");
  });

  it("never truncates from the end — the failure mode being fixed", () => {
    for (const id of REAL_IDS) {
      const label = fitModelLabel(id);
      const tail = id.slice(-7); // `:online` is exactly this long
      expect(label.endsWith(tail), `${id} → ${label} lost its tail`).toBe(true);
      expect(label.endsWith("…"), `${id} → ${label} ends in an ellipsis`).toBe(false);
    }
  });
});

describe("when even the model name will not fit", () => {
  it("elides the middle, keeping both ends", () => {
    const label = fitModelLabel("anthropic/claude-opus-5:online", 16);
    expect(label).toBe("…/claud…5:online");
    expect(label.length).toBe(16);
    // Both the family and the variant are still readable.
    expect(label).toContain("claud");
    expect(label).toContain(":online");
  });

  it("elides the middle of a vendorless id too", () => {
    const label = fitModelLabel("some-extremely-long-model-name-v2", 12);
    expect(label.length).toBe(12);
    expect(label).toContain("…");
    expect(label.endsWith("name-v2")).toBe(true);
  });

  it("degrades to a bare ellipsis rather than throwing at absurd budgets", () => {
    expect(fitModelLabel("anthropic/claude-opus-5", 1)).toBe("…");
    expect(fitModelLabel("anthropic/claude-opus-5", 0)).toBe("…");
  });
});

describe("the budget is honoured, whatever the id", () => {
  it("never exceeds the requested width", () => {
    const ids = [...REAL_IDS, "a", "a/b", "x".repeat(300), `${"v".repeat(80)}/${"m".repeat(80)}:beta`];
    for (const id of ids) {
      for (const max of [4, 8, 12, 16, 22, MODEL_CHIP_CHARS, 60]) {
        const label = fitModelLabel(id, max);
        expect(label.length, `${id} @ ${max} → "${label}"`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("fits every real id inside the shipped budget without a middle cut", () => {
    // The chosen 28 is not arbitrary: it is the width at which the longest id in
    // real use still shows its model name whole, losing at most the vendor. If
    // someone lowers it, this fails loudly.
    for (const id of REAL_IDS) {
      const model = id.slice(id.indexOf("/") + 1);
      expect(fitModelLabel(id).endsWith(model), `${id} → ${fitModelLabel(id)}`).toBe(true);
    }
  });
});
