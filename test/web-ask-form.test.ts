/**
 * The ask_user card's gating logic (D-72). Extracted from `App.tsx` into
 * `web/src/ask-form.ts` precisely so it can be asserted — the defect was a
 * *rendering* decision (`allowFreeText` gating the text box, Submit disabled
 * until an option was picked), and rendering decisions were the one part of the
 * pause with no test at all.
 *
 * The invariant every case here defends: a person asked a question can always
 * answer in their own words, and can always decline — and the payload says
 * which of those they did.
 */
import { describe, it, expect } from "vitest";
import {
  askActions,
  buildAnswers,
  emptyQState,
  flatten,
  isBlank,
  toggleOption,
  type QState,
} from "../web/src/ask-form";
import type { AskQuestion } from "../web/src/api";

const st = (selected: string[] = [], text = ""): QState => ({ selected, text });

describe("option toggling", () => {
  it("is radio-like by default, and clicking the chosen option clears it", () => {
    let q = emptyQState();
    q = toggleOption(q, "red", false);
    expect(q.selected).toEqual(["red"]);
    q = toggleOption(q, "blue", false);
    expect(q.selected).toEqual(["blue"]);
    // Un-picking is itself an escape: you can get back to "I said nothing".
    q = toggleOption(q, "blue", false);
    expect(q.selected).toEqual([]);
  });

  it("accumulates when multiSelect", () => {
    let q = emptyQState();
    q = toggleOption(q, "dev", true);
    q = toggleOption(q, "prod", true);
    expect(q.selected).toEqual(["dev", "prod"]);
    q = toggleOption(q, "dev", true);
    expect(q.selected).toEqual(["prod"]);
  });
});

describe("blankness and flattening", () => {
  it("counts whitespace-only text as blank", () => {
    expect(isBlank(st([], "   "))).toBe(true);
    expect(isBlank(st([], "x"))).toBe(false);
    expect(isBlank(st(["red"]))).toBe(false);
  });

  it("joins picks and typed text into the flat answer", () => {
    expect(flatten(st(["dev", "prod"], " staging "))).toBe("dev, prod, staging");
    expect(flatten(emptyQState())).toBe("");
  });
});

describe("the payload keeps the shape of each answer", () => {
  const qs: AskQuestion[] = [
    { header: "Store", question: "Which store?", options: ["sqlite", "postgres"] },
    { header: "Env", question: "Which envs?", options: ["dev", "prod"], multiSelect: true },
    { question: "Anything else?" },
  ];

  it("marks a blank question declined rather than sending an empty string", () => {
    const out = buildAnswers(qs, [st(["sqlite"]), st([], "just dev for now"), emptyQState()]);
    expect(out[0]).toEqual({ header: "Store", question: "Which store?", answer: "sqlite", chosen: ["sqlite"] });
    expect(out[1]).toEqual({
      header: "Env",
      question: "Which envs?",
      answer: "just dev for now",
      typed: "just dev for now",
    });
    expect(out[2]).toEqual({ question: "Anything else?", answer: "", declined: true });
  });

  it("carries both when the user picks and types", () => {
    const out = buildAnswers(qs.slice(1, 2), [st(["dev"], "and the box under my desk")]);
    expect(out[0]!.chosen).toEqual(["dev"]);
    expect(out[0]!.typed).toBe("and the box under my desk");
    expect(out[0]!.declined).toBeUndefined();
  });
});

describe("what the buttons offer", () => {
  const one: AskQuestion[] = [{ question: "Which color?", options: ["red", "blue"] }];

  it("offers Skip on an untouched single question — the defect, directly", () => {
    const a = askActions(one, [emptyQState()]);
    expect(a.canSubmit).toBe(false); // nothing to submit yet…
    expect(a.showSkip).toBe(true); // …but there is always a way out
    expect(a.canSkip).toBe(true);
    expect(a.skipLabel).toBe("Skip this question");
  });

  it("lets a typed answer submit even though no option was picked", () => {
    const a = askActions(one, [st([], "teal")]);
    expect(a.canSubmit).toBe(true);
    expect(a.showSkip).toBe(false);
  });

  it("withholds the skip only where the model marked the question required", () => {
    const req: AskQuestion[] = [{ question: "Which ticket?", required: true }];
    const blank = askActions(req, [emptyQState()]);
    expect(blank.canSkip).toBe(false);
    expect(blank.canSubmit).toBe(false);
    expect(blank.blocked).toContain("Which ticket?");

    // …and typing satisfies it. `required` never forces one of the options.
    const typed = askActions([{ ...req[0]!, options: ["JL-1", "JL-2"] }], [st([], "JL-411")]);
    expect(typed.canSubmit).toBe(true);
    expect(typed.blocked).toBeUndefined();
  });

  it("counts what a partly filled form would send", () => {
    const three: AskQuestion[] = [{ question: "a" }, { question: "b" }, { question: "c" }];
    const a = askActions(three, [st([], "yes"), emptyQState(), emptyQState()]);
    expect(a.canSubmit).toBe(true);
    expect(a.submitLabel).toBe("Submit 1 of 3");
    expect(a.skipLabel).toBe("Skip the rest");
    expect(a.blanks).toBe(2);
  });

  it("a wholly untouched multi-question form offers Skip all", () => {
    const two: AskQuestion[] = [{ question: "a" }, { question: "b" }];
    const a = askActions(two, [emptyQState(), emptyQState()]);
    expect(a.skipLabel).toBe("Skip all");
    expect(a.submitLabel).toBe("Submit");
    expect(a.canSubmit).toBe(false);
  });

  it("one blank required question blocks the whole form, answered or not", () => {
    const mixed: AskQuestion[] = [{ question: "a" }, { question: "b", required: true }];
    const a = askActions(mixed, [st([], "yes"), emptyQState()]);
    expect(a.canSubmit).toBe(false);
    expect(a.canSkip).toBe(false);
    expect(a.blocked).toContain("b");
  });

  it("is total against short state — never throws on a form it has not seen filled", () => {
    const two: AskQuestion[] = [{ question: "a" }, { question: "b" }];
    expect(() => askActions(two, [])).not.toThrow();
    expect(buildAnswers(two, [])).toHaveLength(2);
    expect(buildAnswers(two, [])[0]!.declined).toBe(true);
  });
});
