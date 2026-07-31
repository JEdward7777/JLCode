/**
 * Browser-side UI preferences (X-12).
 *
 * These are *viewing* preferences, not client config: how the rail is split, and
 * later whether reasoning notes open by default (X-16) or replies auto-read
 * (X-13). D-50 keeps config editing manual and on disk; nothing here belongs in
 * `config.json`, and nothing here is worth a server round trip — it is per
 * browser, per person, and losing it costs a drag of a divider.
 *
 * **This is the one mechanism** — X-16 and X-13 add keys here rather than
 * growing a second path. Every read is total: a missing, corrupt, or
 * out-of-range value yields the default, and `localStorage` itself may throw
 * (private mode, a disabled store), so both directions swallow.
 */

const NS = "jlcode.";

export function readPref<T>(key: string, fallback: T, parse: (raw: string) => T | undefined): T {
  try {
    const raw = window.localStorage.getItem(NS + key);
    if (raw === null) return fallback;
    const parsed = parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback; // storage unavailable — defaults are a fine answer
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(NS + key, value);
  } catch {
    /* full or unavailable; a lost preference is not worth surfacing */
  }
}

/** A number pref clamped to a sane range — an out-of-range stored value (an old
 *  build, a hand-edit, a since-shrunk window) must not wedge the layout. */
export function readNumberPref(key: string, fallback: number, min: number, max: number): number {
  return readPref(key, fallback, (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
  });
}

export function readBoolPref(key: string, fallback: boolean): boolean {
  return readPref(key, fallback, (raw) => (raw === "true" ? true : raw === "false" ? false : undefined));
}
