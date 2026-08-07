/**
 * The blip itself (X-26a/b) — a two-note chirp, synthesized, no asset.
 *
 * **Why generated and not a `.wav`:** the sound is 150ms of two sine notes. A
 * file would have to be encoded, committed, bundled through Vite and fetched
 * over the same connection the SSE bus is holding open, all to say something an
 * oscillator says in twenty lines. Nothing else in the client ships a binary
 * asset and this is not the feature to start with one.
 *
 * **Why it has to be armed (X-26b):** browsers gate audio behind a user gesture
 * exactly as they gate `speechSynthesis`. An `AudioContext` constructed on page
 * load starts `suspended` and stays that way, so a "silently restore the
 * preference on load" design is a feature that never once makes a sound. So the
 * context is **only ever created inside a gesture handler** — the toggle's own
 * click, or the first click/keypress of the session for a preference remembered
 * from last time — and `blip()` is a no-op until then rather than an error.
 */

/** Exactly the slice of WebAudio this uses. Narrow on purpose: it is the whole
 *  contract a test has to fake, and it keeps the module honest about how little
 *  of the API is in play. */
export interface BlipAudio {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { value: number };
    connect(to: unknown): void;
    start(at: number): void;
    stop(at: number): void;
  };
  createGain(): {
    gain: {
      value: number;
      setValueAtTime(v: number, at: number): void;
      linearRampToValueAtTime(v: number, at: number): void;
    };
    connect(to: unknown): void;
  };
}

/** Peak gain of one note. Quiet by design — this is a notification, not an
 *  alert, and it competes with whatever else the machine is playing. */
const PEAK = 0.07;
/** Two ascending notes (A5 → E6). Ascending reads as "done/ready"; descending
 *  reads as "failed", which is not what any of the trigger states mean. */
const NOTES = [880, 1318.5];
const NOTE_MS = 70;
const GAP_MS = 20;
/** A few ms of ramp at each end: a sine started and stopped at full gain clicks,
 *  and the click is louder than the note. */
const EDGE_MS = 6;

export interface Blipper {
  /** Create/resume the context. **Must be called from a real user gesture.** */
  arm(): void;
  /** Play, if armed and running. Returns whether anything was actually
   *  scheduled, so a caller can tell "made a noise" from "would have". */
  blip(): boolean;
  /** Is the context up and running (i.e. would `blip()` be heard)? */
  armed(): boolean;
}

/** `factory` is injectable for tests; in the browser it is the real thing. */
export function createBlipper(factory?: () => BlipAudio): Blipper {
  const make =
    factory ??
    (() => {
      const Ctor = (window as unknown as { AudioContext?: new () => BlipAudio; webkitAudioContext?: new () => BlipAudio })
        .AudioContext ??
        (window as unknown as { webkitAudioContext?: new () => BlipAudio }).webkitAudioContext;
      if (!Ctor) throw new Error("no WebAudio");
      return new Ctor();
    });
  let ctx: BlipAudio | null = null;
  let broken = false; // no WebAudio at all — stop trying, stay silent

  const arm = (): void => {
    if (broken) return;
    try {
      if (!ctx) ctx = make();
      // A context created inside a gesture is usually already `running`; one
      // that was suspended by a background tab needs the nudge. The promise is
      // deliberately unawaited — the arming click must not block on the audio
      // device, and a rejection here is simply "no sound", not an error worth
      // surfacing to someone who just ticked a checkbox.
      if (ctx.state !== "running") void ctx.resume().catch(() => {});
    } catch {
      broken = true; // no WebAudio (old browser, hardened profile) — the tab
      ctx = null; //   title marker is still the silent half of this feature
    }
  };

  const blip = (): boolean => {
    if (!ctx || ctx.state !== "running") return false;
    try {
      const t0 = ctx.currentTime;
      NOTES.forEach((freq, i) => {
        const start = t0 + (i * (NOTE_MS + GAP_MS)) / 1000;
        const end = start + NOTE_MS / 1000;
        const osc = ctx!.createOscillator();
        const gain = ctx!.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.value = 0;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(PEAK, start + EDGE_MS / 1000);
        gain.gain.linearRampToValueAtTime(0, end);
        osc.connect(gain);
        gain.connect(ctx!.destination);
        osc.start(start);
        osc.stop(end + 0.01);
      });
      return true;
    } catch {
      return false; // a device that vanished mid-session; never worth throwing
    }
  };

  return { arm, blip, armed: () => ctx !== null && ctx.state === "running" };
}
