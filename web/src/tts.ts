/**
 * Speech: the one channel, and what auto-read says on it (X-13, H-07).
 *
 * Two halves that have to live together.
 *
 * **The channel** (`createSpeaker`) owns `window.speechSynthesis` for the whole
 * client. Both callers go through it — the per-message 🔊 button and auto-read —
 * so there is exactly one utterance in flight and exactly one place that knows
 * what is being spoken. That is not tidiness: the jam in H-07 is precisely what
 * happens when the *UI's* idea of "speaking" and the *engine's* can drift apart,
 * and the only way they cannot drift is if one object owns both.
 *
 * **The script** (`speechFor`) turns a settled session slice into the thing to
 * say. It is pure and slice-shaped, like `attention.ts`, so every rule about
 * *what* gets read — a finished answer, the question a pause is asking, the tool
 * an approval is about, and never the 300-line file body it would write — is
 * Tier-0 testable without a browser or a voice.
 *
 * ## What the engine actually does (measured, VISUAL-LOG "X-13")
 *
 * Chrome's `speechSynthesis` is not the tidy queue its API implies, and three of
 * its behaviours are load-bearing here — each measured in a real Chrome rather
 * than assumed:
 *
 * 1. **`error` is a normal outcome, and it fires *instead of* `end`.** Replacing
 *    a reply that is still being read ends the old utterance with
 *    `error: "interrupted"` and **no `end` at all** — 19 times out of 20 in the
 *    repro. A cold engine can also fail an utterance outright
 *    (`synthesis-failed`), and a `speak()` with no prior user gesture fails with
 *    `not-allowed`. A caller that registers only `onend` therefore has states it
 *    can enter and never leave.
 * 2. **`cancel()` immediately followed by `speak()` can drop the new utterance.**
 *    Same repro, run 16 of 20: `speak()` was accepted, `start` never fired, and
 *    the utterance died `interrupted`. ~5% — which is exactly what "jams
 *    intermittently" feels like from the outside.
 * 3. **`start` is asynchronous** (130–620 ms after `speak()` here), so "did it
 *    begin?" cannot be answered in the calling task, and the previous
 *    utterance's terminal event can — and does — arrive *after* the replacement
 *    has already been registered.
 *
 * So: every terminal event is handled, our own cancels are told apart from real
 * failures by their error code, a generation counter makes a late callback from
 * the utterance you just replaced unable to touch the one that replaced it,
 * `cancel()` and `speak()` never share a task, and two watchdogs guarantee the
 * channel resets even when the engine says nothing at all. The state the UI
 * renders is this module's, never the engine's `speaking` flag — which was
 * observed to be `true` for an utterance that had already failed.
 */
import type { SessionSlice } from "./session-state";
import { pathToLeaf } from "./tree";

// ---------------------------------------------------------------------------
// The engine, narrowed to what is used (and therefore to what a test must fake)
// ---------------------------------------------------------------------------

export interface SpeechUtteranceLike {
  text: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
}

export interface SpeechEngine {
  readonly speaking: boolean;
  readonly pending: boolean;
  readonly paused: boolean;
  speak(u: SpeechUtteranceLike): void;
  cancel(): void;
  resume(): void;
}

/** Everything the speaker touches outside itself. Injectable so the whole of
 *  the below — including both watchdogs and the post-cancel settle — runs under
 *  fake timers at Tier-0. */
export interface SpeakerHost {
  engine(): SpeechEngine | null;
  utterance(text: string): SpeechUtteranceLike;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** No `start` within this long means the engine took the utterance and did
 *  nothing with it. Measured latency here was 130–620 ms; 4 s is a wide margin
 *  around a cold engine and still short enough that a wedged read clears itself
 *  before the user reaches for the mouse. */
export const START_TIMEOUT_MS = 4000;
/** Slack on top of the estimated duration before a started-but-silent utterance
 *  is called jammed. Deliberately generous: cutting a real reply short is worse
 *  than a stuck button, and the *start* watchdog is what catches the common
 *  failure. */
export const PROGRESS_GRACE_MS = 8000;
/** Roughly how fast the engine gets through text at rate 1 — used only to size
 *  the progress watchdog, never to decide anything the user hears. (~14
 *  chars/second measured; 12 is the conservative side of it.) */
export const CHARS_PER_SECOND = 12;
/** Chrome has a long-standing habit of pausing its own queue partway through a
 *  long utterance. A periodic `resume()` is the standard hedge and is a no-op on
 *  a healthy engine, which is why it is preferred here over splitting the reply
 *  into chunks: chunking would pay a *certain* ~300 ms gap at every sentence
 *  boundary (the measured `start` latency) against a cutoff this container could
 *  not be made to reproduce. */
export const KEEPALIVE_MS = 10000;
/** After `cancel()`, how long to let the engine drain before speaking again, and
 *  how many times to look. `speak()` in the same task as `cancel()` is the
 *  measured ~5% dropped-utterance case. */
export const CANCEL_SETTLE_MS = 60;
export const CANCEL_SETTLE_TRIES = 16;

export interface Speaker {
  /** Record that a user gesture has happened. Browsers gate the first `speak()`
   *  of a document on user activation — measured: no gesture at all fails with
   *  `not-allowed`, while **sticky** activation is enough, so a `speak()` from a
   *  timer 14 s after an ordinary click works fine. That is what makes auto-read
   *  possible at all: it fires from a wire event, never from a click. */
  arm(): void;
  armed(): boolean;
  /** Speak `text`, replacing anything in flight. `key` is what `speaking()`
   *  reports and what the UI renders against. Returns false when nothing could
   *  be said (no engine, not armed, nothing to read). */
  speak(key: string, text: string): boolean;
  /** Stop. Idempotent, and safe to call when nothing is speaking. */
  cancel(): void;
  /** What is being spoken, as far as *this module* is concerned — never the
   *  engine's `speaking` flag, which was observed reading `true` for an
   *  utterance that had already errored. */
  speaking(): string | null;
  /** Told whenever `speaking()` changes, including when a watchdog clears it. */
  onChange(fn: (key: string | null) => void): void;
}

function browserHost(): SpeakerHost {
  return {
    engine: () => (window.speechSynthesis ?? null) as SpeechEngine | null,
    utterance: (text: string) => new SpeechSynthesisUtterance(text) as unknown as SpeechUtteranceLike,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h),
  };
}

export function createSpeaker(host: SpeakerHost = browserHost()): Speaker {
  /** Bumped by every `speak()` and every `cancel()`. Every callback and every
   *  timer carries the generation it was armed under and does nothing if it has
   *  been superseded — this is what makes the *previous* utterance's late
   *  `interrupted` (which arrives ~1 ms after the cancel, i.e. after the
   *  replacement is already registered) harmless. */
  let gen = 0;
  let current: string | null = null;
  let gesture = false;
  const timers = new Set<number>();
  let listener: (key: string | null) => void = () => {};

  const clearTimers = (): void => {
    for (const t of timers) host.clearTimeout(t);
    timers.clear();
  };

  const after = (ms: number, fn: () => void): void => {
    const mine = gen;
    const h = host.setTimeout(() => {
      timers.delete(h);
      if (mine === gen) fn();
    }, ms);
    timers.add(h);
  };

  const settle = (key: string | null): void => {
    if (current === key) return;
    current = key;
    listener(key);
  };

  /** Give up on whatever is in flight and put the UI back to "nothing is being
   *  spoken". Every exit from a read goes through here — a clean `end`, a real
   *  error, either watchdog, and an explicit cancel — because the failure this
   *  module exists to prevent is a UI that believes it is still speaking. */
  const stop = (engine: SpeechEngine | null): void => {
    gen++;
    clearTimers();
    try {
      engine?.cancel();
    } catch {
      /* an engine that threw on cancel has nothing left to tell us */
    }
    settle(null);
  };

  /** Speak once the engine reports it has drained, never in the same task as the
   *  `cancel()` above (measured: ~5% of same-task speaks are dropped outright). */
  const speakWhenDrained = (mine: number, key: string, text: string, tries: number): void => {
    const engine = host.engine();
    if (!engine || mine !== gen) return;
    if ((engine.speaking || engine.pending) && tries > 0) {
      const h = host.setTimeout(() => {
        timers.delete(h);
        speakWhenDrained(mine, key, text, tries - 1);
      }, CANCEL_SETTLE_MS);
      timers.add(h);
      return;
    }
    // Out of patience is not a reason to stay silent — an engine that never
    // drains is exactly the state the watchdogs below exist for.
    const u = host.utterance(text);
    let started = false;
    u.onstart = () => {
      if (mine !== gen) return;
      started = true;
    };
    u.onend = () => {
      if (mine !== gen) return;
      stop(null); // it finished on its own; nothing to cancel
    };
    // The handler the shipped code did not have, and the whole of H-07's first
    // half. No error code needs telling apart here: a cancel of ours already
    // bumped the generation, so its `interrupted` is filtered out one line above
    // and anything that reaches this point — `synthesis-failed`, `not-allowed`,
    // `audio-busy`, or an interruption from outside the tab — means the read is
    // over and the UI must stop claiming otherwise.
    u.onerror = () => {
      if (mine !== gen) return;
      stop(null);
    };
    try {
      engine.speak(u);
    } catch {
      stop(null);
      return;
    }
    // Watchdog 1: taken but never begun.
    after(START_TIMEOUT_MS, () => {
      if (!started) stop(host.engine());
    });
    // Watchdog 2: begun but never finished. Deliberately blunt — the keepalive
    // below has already been nudging a paused queue every ten seconds by the
    // time this fires, so there is no recovery left to attempt, only a UI to put
    // back. Generous by design: cutting a real reply short is worse than a
    // button that stays lit a while, and watchdog 1 is what catches the common
    // failure.
    after(PROGRESS_GRACE_MS + (text.length / CHARS_PER_SECOND) * 1000 * 2, () => stop(host.engine()));
    keepalive(mine);
  };

  /** The zero-cost half of the long-utterance hedge: nudge a queue that has
   *  paused itself, forever, until this read ends. */
  const keepalive = (mine: number): void => {
    after(KEEPALIVE_MS, () => {
      if (mine !== gen) return;
      try {
        host.engine()?.resume();
      } catch {
        /* nothing to do about an engine that will not be nudged */
      }
      keepalive(mine);
    });
  };

  return {
    arm: () => {
      gesture = true;
    },
    armed: () => gesture,
    speak(key, text) {
      const engine = host.engine();
      const body = text.trim();
      if (!engine || !gesture || body === "") return false;
      stop(engine); // bumps the generation, so nothing from the old read lands
      const mine = ++gen; // and a fresh one for this read
      settle(key);
      // **Never in the same task as the cancel above**, even when the engine
      // claims to be idle — whether `cancel()` clears `speaking` synchronously is
      // not something the spec says and not something worth betting a 5% failure
      // rate on. One turn of the timer queue costs less than the engine's own
      // start latency (130–620 ms measured) and buys the whole hazard away.
      after(CANCEL_SETTLE_MS, () => speakWhenDrained(mine, key, body, CANCEL_SETTLE_TRIES));
      return true;
    },
    cancel() {
      stop(host.engine());
    },
    speaking: () => current,
    onChange(fn) {
      listener = fn;
    },
  };
}

// ---------------------------------------------------------------------------
// The script: what a settled session says
// ---------------------------------------------------------------------------

/** Strip the loudest markdown so text-to-speech doesn't read `##`/`*`/backticks.
 *  Moved here from `App.tsx` unchanged when auto-read gained a second caller. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

/** One thing that could be read, and the identity that decides whether it
 *  already has been. The **key is content-shaped, not a counter** — an entry id,
 *  a request id, the notice's own text — which is what lets auto-read ignore
 *  React batching for free: a turn that arrives in a single render still changes
 *  the key, where X-26 needed `settleSeq` because it was watching a *level*. */
export interface Utterable {
  key: string;
  text: string;
}

/** How much of a tool's argument is worth hearing. An approval says *what is
 *  about to happen*; the file body it would write is emphatically not that. */
const ARG_SPOKEN_CHARS = 120;
/** Args worth naming aloud, most-identifying first. `content` is deliberately
 *  absent — a 300-line write read out loud is the failure this list prevents. */
const SPOKEN_ARGS = ["command", "path", "file", "pattern", "query", "url"];

function argHint(args: Record<string, unknown>): string {
  for (const k of SPOKEN_ARGS) {
    const v = args[k];
    if (typeof v === "string" && v.trim() !== "") {
      const s = v.trim();
      return s.length > ARG_SPOKEN_CHARS ? `${s.slice(0, ARG_SPOKEN_CHARS)}…` : s;
    }
  }
  return "";
}

/** The last assistant turn **on the branch in view**, if it actually said
 *  something. Walked with the same `pathToLeaf` the transcript renders, not the
 *  raw entry list — a sibling branch's reply is on screen nowhere and reading it
 *  aloud would be a lie about what just happened (H-05's hazard, in audio).
 *
 *  A tool-only turn has no text and is skipped (X-13 (d)) — there is nothing to
 *  read, and "the agent did something" is what the blip is for. */
function lastSpokenReply(s: SessionSlice): Utterable | null {
  const path = pathToLeaf(s.entries, s.activeLeaf);
  for (let i = path.length - 1; i >= 0; i--) {
    const e = path[i]!;
    if (e.type !== "assistant") continue;
    const body = plainText(e.text ?? "");
    return body === "" ? null : { key: e.id, text: body };
  }
  return null;
}

/**
 * Everything this session could say right now, most important first.
 *
 * The order is X-26's attention precedence, because it is the same judgment:
 * a stalled write outranks a pause, a pause outranks a finished answer. The
 * caller speaks the first one it has not already spoken, which is what makes a
 * failed turn read its error rather than re-reading the reply before it.
 *
 * **A pause reads the reason it stopped, not the reply before it** (X-13 (b)):
 * being told "I need approval to run npm install" is the entire value; being
 * told the paragraph that preceded it is not.
 *
 * Returns nothing at all while the session is working — half a sentence is
 * worse than silence, which is why the trigger is settle, never stream.
 */
export function speechFor(s: SessionSlice): Utterable[] {
  if (s.persistenceFault) {
    return [
      {
        key: `fault:${s.persistenceFault.id}`,
        text: `Stopped: a write failed. ${s.persistenceFault.message}`,
      },
    ];
  }
  if (s.pendingApproval) {
    const a = s.pendingApproval;
    const hint = argHint(a.args ?? {});
    return [{ key: `approval:${a.id}`, text: `Approval needed to run ${a.tool}${hint ? `: ${hint}` : ""}.` }];
  }
  if (s.pendingAsk) {
    const q = s.pendingAsk;
    const parts = q.questions.map((question, i) => {
      const label = q.questions.length > 1 ? `Question ${i + 1} of ${q.questions.length}. ` : "";
      const head = question.header ? `${question.header}. ` : "";
      const options = question.options?.length ? ` Options: ${question.options.join(", ")}.` : "";
      return `${label}${head}${plainText(question.question)}${options}`;
    });
    return [{ key: `ask:${q.id}`, text: `A question for you. ${parts.join(" ")}` }];
  }
  if (s.pendingCompaction) {
    return [
      {
        key: `compaction:${s.pendingCompaction.id}`,
        text: "The context window is nearly full. Waiting on you to compact or carry on.",
      },
    ];
  }
  if (s.capReached) {
    return [{ key: `cap:${s.spendUsd.toFixed(4)}`, text: "The spend cap has been reached." }];
  }
  if (s.working) return [];
  const out: Utterable[] = [];
  const reply = lastSpokenReply(s);
  if (reply) out.push(reply);
  // A failed turn appends no assistant entry, so the reply above is one the user
  // has already heard and falls through to here. `stopped` and `retrying` are
  // excluded at the source: you pressed Stop, and a backoff is not a settle.
  if (s.notice && (s.noticeKind === "error" || s.noticeKind === "halted")) {
    out.push({ key: `notice:${s.notice}`, text: `The turn failed. ${s.notice}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The trigger: when auto-read speaks
// ---------------------------------------------------------------------------

/** How many keys per session are remembered. Long enough that nothing within
 *  sight can be re-read, short enough that a thousand-turn thread does not carry
 *  a thousand strings around. */
export const MEMORY_KEYS = 64;

/** What the watcher remembers between folds. Hold it in a ref and hand it back,
 *  exactly like `AttentionMemory`. */
export interface AutoReadMemory {
  said: Record<
    string,
    {
      /** Candidate keys already dealt with — spoken, or adopted in silence.
       *  **Accumulated, not replaced**: while a turn is running there are no
       *  candidates at all, and a memory that simply took the current list would
       *  forget the previous reply and read it again the moment a tool-only turn
       *  settled with nothing new to say. */
      keys: string[];
      /** Whether this session's tree had loaded on the previous fold. A session
       *  in the roster that has never been focused carries no entries, so its
       *  whole history arrives in one go on first focus — and every word of it
       *  would look brand new. Nothing is read out of a tree that has only just
       *  appeared. */
      loaded: boolean;
    }
  >;
}

export function newAutoReadMemory(): AutoReadMemory {
  return { said: {} };
}

export interface AutoReadStep {
  memory: AutoReadMemory;
  /** What to say now, or null. At most one — there is one voice. */
  speak: (Utterable & { id: string }) | null;
}

/**
 * Fold the slices and report the one thing to read aloud.
 *
 * **Only the focused session speaks** (X-13 (a)). Speech is serial and
 * unattributable: two sessions reading at once is unintelligible, and a voice
 * that starts talking gives no clue which of four panes it came from. So the two
 * notifications divide the work exactly: a **background** session that settles
 * gets X-26's blip and its rail dot, and the **focused** one gets read aloud.
 * That also disposes of X-13's queue question — with one speaker there is
 * nothing to queue, and a newer reply simply replaces an older one mid-sentence,
 * which is the "newest reply wins" the row asked for.
 *
 * Every session's keys are remembered on every fold, focused or not, so the
 * background ones are continuously primed: **switching to a session never reads
 * out what it said while you were away.** It has already blipped; it is history
 * by the time you are looking at it.
 *
 * `document.hidden` is deliberately **not** consulted, and neither is X-26(e)'s
 * "you caused it and are watching it" suppression. Both are right for a chirp
 * that means *look over here* and wrong for speech that means *here is what it
 * said*: the whole point is ears free of the screen, and the screen may well be
 * right in front of you.
 */
export function stepAutoRead(
  prev: AutoReadMemory,
  slices: SessionSlice[],
  ctx: { focusedId: string | null; enabled: boolean },
): AutoReadStep {
  const said: AutoReadMemory["said"] = {};
  let speak: (Utterable & { id: string }) | null = null;
  for (const s of slices) {
    const candidates = speechFor(s);
    const before = prev.said[s.id];
    const keys = [...(before?.keys ?? [])];
    for (const c of candidates) if (!keys.includes(c.key)) keys.push(c.key);
    said[s.id] = { keys: keys.slice(-MEMORY_KEYS), loaded: s.treeLoaded };
    // Sessions that closed simply drop out, as in `stepAttention` — a re-opened
    // id is a new session and is primed again, which is the honest reading of
    // "never seen".
    if (!before || !before.loaded) continue;
    if (!ctx.enabled || s.id !== ctx.focusedId || speak) continue;
    const fresh = candidates.find((c) => !before.keys.includes(c.key));
    if (fresh) speak = { ...fresh, id: s.id };
  }
  return { memory: { said }, speak };
}
