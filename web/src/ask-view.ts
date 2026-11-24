/**
 * The answered `ask` call, read back as questions and answers (X-61).
 *
 * While a question is pending, the person sees the ask card. Once it is
 * answered, that card is gone, and the transcript holds only two strings: the
 * call's arguments (the questions) and the tool result (the answer text the
 * model read). Shown raw, that is pretty-printed JSON above a block of prose
 * written for the model, which is hard for a person to read. This module turns
 * the pair back into question → answer, so the history block can draw it the
 * way the card drew it.
 *
 * **Nothing new is stored.** The result string is produced by the session's
 * `formatAnswers` (src/session/session.ts), and its shape is regular enough to
 * read back: each line starts with the question's own text, which we already
 * hold from the args. Reading what is stored, rather than adding a field, means
 * every conversation ever saved renders the same way. The test round-trips
 * through the real `formatAnswers`, so a change to that format fails here and
 * not silently in the browser.
 *
 * Anything that does not read back cleanly falls back to the result's plain
 * text under the questions. The questions are still shown; nothing is hidden.
 *
 * Pure (no DOM, no React), like `tool-view.ts` and `ask-form.ts`.
 */

/** One question as the model posed it (mirrors the session's `parseAskQuestions`). */
export interface AskedQuestion {
  header?: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  required: boolean;
}

/** How one question was answered. */
export type AnswerShape =
  /** Picked from the options, possibly with typed text as well. */
  | { kind: "chose"; chosen: string[]; typed?: string }
  /** Typed in the person's own words. `instead` = options were offered and passed over. */
  | { kind: "typed"; text: string; instead: boolean }
  /** Left blank on purpose: the person declined (D-72). */
  | { kind: "declined" };

export interface AskRecord {
  questions: AskedQuestion[];
  /** Who the model addressed, when it said (P9d). */
  to?: "user" | "parent";
  /**
   * One answer per question, in order — or `null` when the result could not be
   * read back per question (an error, a stop, an unfamiliar shape). The view then
   * shows `fallback` instead.
   */
  answers: AnswerShape[] | null;
  /** The answering agent's name, when its parent answered rather than the person. */
  answeredBy?: string;
  /** The result text to show when `answers` is null (or a parent's free-form reply). */
  fallback?: string;
  /** The call never got an answer: stopped, skipped, or failed. */
  unanswered: boolean;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The questions out of the call's args — the same normalization the session
 *  applies, because the result's lines are indexed against *that* list. */
export function askedQuestions(args: Record<string, unknown>): AskedQuestion[] {
  if (Array.isArray(args["questions"])) {
    const out: AskedQuestion[] = [];
    for (const raw of args["questions"]) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o["question"] !== "string") continue;
      out.push({
        ...(typeof o["header"] === "string" ? { header: o["header"] } : {}),
        question: o["question"],
        options: strings(o["options"]),
        multiSelect: o["multiSelect"] === true,
        required: o["required"] === true,
      });
    }
    if (out.length > 0) return out;
  }
  return [
    {
      question: typeof args["question"] === "string" ? args["question"] : "(no question provided)",
      options: strings(args["options"]),
      multiSelect: false,
      required: args["required"] === true,
    },
  ];
}

const DECLINED = "declined — the user did not answer this";
const HEADS = [
  "The user answered:",
  "The user declined to answer any of these questions:",
  "The user declined to answer:",
];
/** The note that follows a decline; it starts after a blank line. */
const NOTE_START = "\n\nA declined question is information";
const PARENT = /^\[Answer from your parent agent "([^"]*)"\]\n\n/;

/**
 * Split `"a", "b"` back into options. Matching against the offered options (not
 * splitting on commas) keeps an option that itself contains `", "` whole.
 */
function splitChosen(list: string, options: string[]): string[] | null {
  const byLength = [...options].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let rest = list;
  while (rest !== "") {
    const hit = byLength.find((o) => rest.startsWith(`"${o}"`));
    if (hit === undefined) return null;
    out.push(hit);
    rest = rest.slice(hit.length + 2);
    if (rest === "") break;
    if (!rest.startsWith(", ")) return null;
    rest = rest.slice(2);
  }
  return out.length > 0 ? out : null;
}

/** One line's answer part (the session's `describeAnswer`, read backwards). */
function readDescription(desc: string, q: AskedQuestion): AnswerShape | null {
  if (desc === DECLINED) return { kind: "declined" };
  const none = "picked none of the offered options and typed: ";
  if (desc.startsWith(none)) return { kind: "typed", text: desc.slice(none.length), instead: true };
  if (desc.startsWith("chose ")) {
    const body = desc.slice("chose ".length);
    const also = ", and also typed: ";
    const cut = body.indexOf(also);
    const list = cut < 0 ? body : body.slice(0, cut);
    const chosen = splitChosen(list, q.options);
    if (chosen === null) return null;
    return cut < 0 ? { kind: "chose", chosen } : { kind: "chose", chosen, typed: body.slice(cut + also.length) };
  }
  return { kind: "typed", text: desc, instead: false };
}

/** The labeled block (multi-question, or a single answer whose shape mattered). */
function readBlock(content: string, questions: AskedQuestion[]): AnswerShape[] | null {
  const head = HEADS.find((h) => content.startsWith(`${h}\n`));
  if (head === undefined) return null;
  const noteAt = content.indexOf(NOTE_START);
  let rest = (noteAt < 0 ? content : content.slice(0, noteAt)).slice(head.length + 1);
  const answers: AnswerShape[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const prefix = `- ${q.header ? `${q.header} — ` : ""}${q.question}: `;
    if (!rest.startsWith(prefix)) return null;
    rest = rest.slice(prefix.length);
    // The answer runs to the next question's line — found by its known prefix,
    // so a typed answer with newlines in it stays whole.
    const next = questions[i + 1];
    let end = rest.length;
    if (next) {
      end = rest.indexOf(`\n- ${next.header ? `${next.header} — ` : ""}${next.question}: `);
      if (end < 0) return null;
    }
    const shape = readDescription(rest.slice(0, end), q);
    if (shape === null) return null;
    answers.push(shape);
    rest = rest.slice(end + 1);
  }
  return answers;
}

/** A one-question answer passed through verbatim: an option, several, or typed. */
function readPlain(content: string, q: AskedQuestion): AnswerShape {
  if (q.options.includes(content)) return { kind: "chose", chosen: [content] };
  // A multi-select answer arrives flattened as "a, b" (ask-form's `flatten`).
  const parts = content.split(", ");
  if (parts.length > 1 && parts.every((p) => q.options.includes(p))) return { kind: "chose", chosen: parts };
  return { kind: "typed", text: content, instead: false };
}

/**
 * Read an `ask` call and its result back into questions and answers. `raw` is
 * the call's JSON args; `content`/`isError` are the tool result. Returns `null`
 * only when the args are unreadable, and the caller then falls back to the plain
 * tool block.
 */
export function readAsk(raw: string | undefined, content: string, isError: boolean): AskRecord | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const args = parsed as Record<string, unknown>;
  const questions = askedQuestions(args);
  const to: AskRecord["to"] = args["to"] === "user" || args["to"] === "parent" ? args["to"] : undefined;
  const base = { questions, ...(to ? { to } : {}) };

  if (isError) return { ...base, answers: null, fallback: content, unanswered: true };

  const parent = PARENT.exec(content);
  if (parent) {
    // A parent agent answers in free prose, not per question — show it as written.
    return { ...base, answers: null, answeredBy: parent[1]!, fallback: content.slice(parent[0].length), unanswered: false };
  }

  const block = readBlock(content, questions);
  if (block) return { ...base, answers: block, unanswered: false };
  if (questions.length === 1) return { ...base, answers: [readPlain(content, questions[0]!)], unanswered: false };
  return { ...base, answers: null, fallback: content, unanswered: false };
}

/** The collapsed header's gist: the question itself, not its JSON. */
export function askGist(record: AskRecord): string {
  const first = record.questions[0]!;
  if (record.questions.length === 1) return first.question;
  return `${record.questions.length} questions — ${first.header ?? first.question}…`;
}

/** The collapsed header's right-hand hint, in place of the output size. */
export function askStatus(record: AskRecord): string {
  if (record.unanswered) return "not answered";
  if (record.answeredBy !== undefined) return `answered by ${record.answeredBy}`;
  if (record.answers === null) return "answered";
  const n = record.answers.length;
  const declined = record.answers.filter((a) => a.kind === "declined").length;
  if (declined === 0) return n === 1 ? "answered" : `${n} answered`;
  if (declined === n) return n === 1 ? "declined" : "all declined";
  return `${n - declined} of ${n} answered`;
}
