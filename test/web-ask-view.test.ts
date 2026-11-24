/**
 * The answered `ask` read back from history (X-61). The history block has only
 * the call's args and the result string the session wrote. These tests produce
 * that string with the session's **real** `formatAnswers` and the frontend's
 * real `buildAnswers`, the same path a live answer takes, so a change to either
 * format fails here instead of quietly turning the history view back into prose.
 */
import { describe, it, expect } from "vitest";
import { readAsk, askGist, askStatus } from "../web/src/ask-view";
import { buildAnswers, type QState } from "../web/src/ask-form";
import { formatAnswers } from "../src/session/session";
import type { AskQuestion } from "../web/src/api";

/** What the session stores for an answered form: the args, and the result. */
function answered(args: Record<string, unknown>, questions: AskQuestion[], state: QState[]) {
  const content = formatAnswers(buildAnswers(questions, state), questions);
  return readAsk(JSON.stringify(args), content, false)!;
}

const FORM: AskQuestion[] = [
  { header: "Store", question: "Which store should I use?", options: ["sqlite", "postgres"] },
  { header: "Targets", question: "Which environments?", options: ["dev", "staging", "prod"], multiSelect: true },
  { header: "Ticket", question: "Which ticket is this for?", required: true },
  { header: "Notes", question: "Anything else I should know?" },
];

describe("readAsk — a multi-question form", () => {
  const rec = answered({ questions: FORM }, FORM, [
    { selected: ["sqlite"], text: "" },
    { selected: ["dev", "prod"], text: "" },
    { selected: [], text: "JL-42\nand JL-43: the follow-up" },
    { selected: [], text: "" },
  ]);

  it("pairs every answer with its question, in order", () => {
    expect(rec.questions.map((q) => q.header)).toEqual(["Store", "Targets", "Ticket", "Notes"]);
    expect(rec.answers).toEqual([
      { kind: "chose", chosen: ["sqlite"] },
      { kind: "chose", chosen: ["dev", "prod"] },
      // A typed answer with a newline and a colon in it stays whole.
      { kind: "typed", text: "JL-42\nand JL-43: the follow-up", instead: false },
      { kind: "declined" },
    ]);
  });

  it("says how much was answered, in the collapsed header", () => {
    expect(askStatus(rec)).toBe("3 of 4 answered");
    expect(askGist(rec)).toBe("4 questions — Store…");
  });

  it("shows a typed answer that passed over the options, and one typed alongside a pick", () => {
    const r = answered({ questions: FORM.slice(0, 2) }, FORM.slice(0, 2), [
      { selected: [], text: "duckdb" },
      { selected: ["staging"], text: "but only on Fridays" },
    ]);
    expect(r.answers).toEqual([
      { kind: "typed", text: "duckdb", instead: true },
      { kind: "chose", chosen: ["staging"], typed: "but only on Fridays" },
    ]);
  });

  it("reads a form with every question declined", () => {
    const r = answered({ questions: FORM.slice(0, 2) }, FORM.slice(0, 2), [
      { selected: [], text: "" },
      { selected: [], text: "" },
    ]);
    expect(r.answers).toEqual([{ kind: "declined" }, { kind: "declined" }]);
    expect(askStatus(r)).toBe("all declined");
  });

  it("keeps an option that itself contains a comma whole", () => {
    const qs: AskQuestion[] = [{ question: "Pick", options: ["a, b", "c"], multiSelect: true }, { question: "Other?" }];
    const r = answered({ questions: qs }, qs, [{ selected: ["a, b", "c"], text: "" }, { selected: [], text: "x" }]);
    expect(r.answers![0]).toEqual({ kind: "chose", chosen: ["a, b", "c"] });
  });
});

describe("readAsk — the single question", () => {
  const Q: AskQuestion[] = [{ question: "Ship it today?", options: ["Yes", "No"] }];
  const ARGS = { question: "Ship it today?", options: ["Yes", "No"] };

  it("reads a plain pick, which the session passes through verbatim", () => {
    const r = answered(ARGS, Q, [{ selected: ["Yes"], text: "" }]);
    expect(r.answers).toEqual([{ kind: "chose", chosen: ["Yes"] }]);
    expect(askGist(r)).toBe("Ship it today?");
    expect(askStatus(r)).toBe("answered");
  });

  it("reads a decline as a decline, not as an empty answer", () => {
    const r = answered(ARGS, Q, [{ selected: [], text: "" }]);
    expect(r.answers).toEqual([{ kind: "declined" }]);
    expect(askStatus(r)).toBe("declined");
  });

  it("reads text typed in place of the options", () => {
    const r = answered(ARGS, Q, [{ selected: [], text: "tomorrow" }]);
    expect(r.answers).toEqual([{ kind: "typed", text: "tomorrow", instead: true }]);
  });

  it("reads a plain-text answer (the bare-string payload) with no options", () => {
    const r = readAsk(JSON.stringify({ question: "Name?" }), formatAnswers("Ada"), false)!;
    expect(r.answers).toEqual([{ kind: "typed", text: "Ada", instead: false }]);
  });
});

describe("readAsk — results that aren't per-question answers", () => {
  it("shows a parent agent's reply as written, and who sent it", () => {
    const r = readAsk(
      JSON.stringify({ to: "parent", question: "Which file?" }),
      '[Answer from your parent agent "root"]\n\nUse src/a.ts.',
      false,
    )!;
    expect(r.to).toBe("parent");
    expect(r.answers).toBeNull();
    expect(r.answeredBy).toBe("root");
    expect(r.fallback).toBe("Use src/a.ts.");
    expect(askStatus(r)).toBe("answered by root");
  });

  it("marks a stopped call as not answered and keeps its reason", () => {
    const r = readAsk(JSON.stringify({ question: "Go?" }), "stopped by the user — this call was not run", true)!;
    expect(r.unanswered).toBe(true);
    expect(r.fallback).toContain("stopped by the user");
    expect(askStatus(r)).toBe("not answered");
  });

  it("falls back to the text, with the questions still shown, when a form's result is unfamiliar", () => {
    const r = readAsk(JSON.stringify({ questions: FORM }), "something else entirely", false)!;
    expect(r.questions).toHaveLength(4);
    expect(r.answers).toBeNull();
    expect(r.fallback).toBe("something else entirely");
  });

  it("gives up (plain tool block) only when the args themselves are unreadable", () => {
    expect(readAsk('{"question": "trunc', "x", false)).toBeNull();
  });
});
