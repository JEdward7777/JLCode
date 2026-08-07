/**
 * The ask_user card's decision logic, kept out of the component so it can be
 * tested (the pattern `tool-view.ts` / `attention.ts` / `prefs.ts` already set —
 * there is no DOM harness in this repo).
 *
 * The rule the whole module exists to enforce (D-72): **a person asked a
 * question can always answer it in their own words, and can always decline.**
 * Options are suggestions. The only thing that removes the decline is the
 * model marking a question `required`, and even then a typed answer satisfies
 * it — `required` can compel an answer, never the picking of an option.
 */
import type { AskQuestion, AskAnswer } from "./api";

/** One question's local state in the card. */
export interface QState {
  selected: string[];
  text: string;
}

export const emptyQState = (): QState => ({ selected: [], text: "" });

/** Click an option: radio-like by default (clicking the chosen one clears it,
 *  which is itself an escape), additive when `multiSelect`. */
export function toggleOption(q: QState, opt: string, multi: boolean): QState {
  if (multi) {
    return q.selected.includes(opt)
      ? { ...q, selected: q.selected.filter((o) => o !== opt) }
      : { ...q, selected: [...q.selected, opt] };
  }
  return { ...q, selected: q.selected[0] === opt ? [] : [opt] };
}

/** Nothing picked and nothing typed — this question is being declined. */
export const isBlank = (q: QState): boolean => q.selected.length === 0 && q.text.trim() === "";

/** The flat human rendering of one answer; also what a plain-text frontend
 *  would post on its own. Empty for a declined question. */
export const flatten = (q: QState): string => [...q.selected, q.text.trim()].filter(Boolean).join(", ");

/** The POST body for the whole form. A blank question is sent as an explicit
 *  `declined`, never as an empty string that reads like an answer. */
export function buildAnswers(questions: AskQuestion[], state: QState[]): AskAnswer[] {
  return questions.map((def, i) => {
    const q = state[i] ?? emptyQState();
    const typed = q.text.trim();
    return {
      question: def.question,
      ...(def.header ? { header: def.header } : {}),
      answer: flatten(q),
      ...(q.selected.length > 0 ? { chosen: [...q.selected] } : {}),
      ...(typed ? { typed } : {}),
      ...(isBlank(q) ? { declined: true } : {}),
    };
  });
}

/** How the card's two buttons should read and behave.
 *
 *  Submit sends what was filled in; Skip sends the same payload with the blanks
 *  declined. They differ only in what they *say* — and that is the point: the
 *  way out has to be visible, not inferred from an empty form. Neither can get
 *  past a blank `required` question. */
export interface AskActions {
  /** Submit is offered only when there is something to submit. */
  canSubmit: boolean;
  submitLabel: string;
  /** Skip is offered only when there is something left blank. */
  showSkip: boolean;
  canSkip: boolean;
  skipLabel: string;
  /** How many questions would go back as declines. */
  blanks: number;
  /** Set when a required question is still blank — shown, not just implied. */
  blocked?: string;
}

export function askActions(questions: AskQuestion[], state: QState[]): AskActions {
  const blankAt = questions.map((_, i) => isBlank(state[i] ?? emptyQState()));
  const blanks = blankAt.filter(Boolean).length;
  const missing = questions.find((q, i) => q.required === true && blankAt[i]);
  const multi = questions.length > 1;
  const answered = questions.length - blanks;
  return {
    canSubmit: !missing && answered > 0,
    submitLabel: multi && blanks > 0 && answered > 0 ? `Submit ${answered} of ${questions.length}` : "Submit",
    showSkip: blanks > 0,
    canSkip: !missing,
    skipLabel: multi ? (answered > 0 ? "Skip the rest" : "Skip all") : "Skip this question",
    blanks,
    ...(missing ? { blocked: `An answer is required: ${missing.question}` } : {}),
  };
}
