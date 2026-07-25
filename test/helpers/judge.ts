/**
 * LLM-as-judge (TESTING.md): call a model as a correctness judge for semantic
 * checks that exact-match assertions can't express ("did the reply actually
 * preserve X?"). Judge calls go through the same request-keyed cache as any live
 * call (pay-once), and run at temperature 0 so the recorded verdict is stable.
 */
import { accumulate } from "../../src/llm/stream.js";
import type { LlmDriver, StreamEvent } from "../../src/llm/types.js";
import { JUDGE_MODEL } from "./live.js";

export interface Verdict {
  pass: boolean;
  reason: string;
}

/** Ask the judge model whether `candidate` satisfies `criteria`. Returns a
 *  parsed PASS/FAIL verdict; a first-token PASS/FAIL keeps parsing trivial and
 *  robust to the model's trailing prose. */
export async function judge(
  driver: LlmDriver,
  opts: { criteria: string; candidate: string; context?: string },
): Promise<Verdict> {
  const system =
    "You are a strict evaluator. Decide whether the CANDIDATE text satisfies the CRITERIA. " +
    "Reply with exactly one word first — PASS or FAIL — then a space and a one-sentence reason.";
  const user =
    (opts.context ? `CONTEXT:\n${opts.context}\n\n` : "") +
    `CRITERIA:\n${opts.criteria}\n\nCANDIDATE:\n${opts.candidate}`;
  const events: StreamEvent[] = [];
  for await (const ev of driver.streamChat({
    model: JUDGE_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: 200,
  })) {
    events.push(ev);
  }
  const text = accumulate(events).text.trim();
  const pass = /^\s*pass\b/i.test(text);
  return { pass, reason: text };
}
