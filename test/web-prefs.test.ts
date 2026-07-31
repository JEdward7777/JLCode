/**
 * The browser-side UI preference helper (X-12) — the one mechanism X-16's
 * default-open reasoning notes and X-13's auto-read toggle are meant to reuse.
 *
 * The contract worth pinning is that **every read is total**: a corrupt value, a
 * value outside the range the UI can render, or a `localStorage` that throws
 * (private mode, storage disabled) must all yield the default rather than
 * wedging the layout.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readBoolPref, readNumberPref, readPref, writePref } from "../web/src/prefs";

function fakeStorage(initial: Record<string, string> = {}, throws = false) {
  const map = new Map(Object.entries(initial));
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => {
        if (throws) throw new Error("storage disabled");
        return map.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (throws) throw new Error("storage disabled");
        map.set(k, v);
      },
    },
  };
  return map;
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe("web prefs", () => {
  it("round-trips a value under a namespaced key", () => {
    const map = fakeStorage();
    writePref("rail.liveHeight", "260");
    expect(map.get("jlcode.rail.liveHeight")).toBe("260");
    expect(readNumberPref("rail.liveHeight", 240, 80, 900)).toBe(260);
  });

  it("falls back when nothing is stored", () => {
    fakeStorage();
    expect(readBoolPref("history.allDirs", false)).toBe(false);
    expect(readNumberPref("rail.liveHeight", 240, 80, 900)).toBe(240);
  });

  it("falls back on a corrupt value rather than propagating NaN", () => {
    fakeStorage({ "jlcode.rail.liveHeight": "banana", "jlcode.history.allDirs": "yes" });
    expect(readNumberPref("rail.liveHeight", 240, 80, 900)).toBe(240);
    expect(readBoolPref("history.allDirs", false)).toBe(false);
  });

  it("clamps a stored number into range", () => {
    // An old build, a hand-edit, or a since-shrunk window must not be able to
    // drag a section out of existence.
    fakeStorage({ "jlcode.rail.liveHeight": "99999" });
    expect(readNumberPref("rail.liveHeight", 240, 80, 900)).toBe(900);
    fakeStorage({ "jlcode.rail.liveHeight": "-40" });
    expect(readNumberPref("rail.liveHeight", 240, 80, 900)).toBe(80);
  });

  it("survives storage that throws, in both directions", () => {
    fakeStorage({}, true);
    expect(readBoolPref("history.allDirs", true)).toBe(true);
    expect(() => writePref("history.allDirs", "false")).not.toThrow();
  });

  it("survives no window at all (SSR / a test env without a DOM)", () => {
    expect(readPref("anything", "default", (raw) => raw)).toBe("default");
    expect(() => writePref("anything", "x")).not.toThrow();
  });
});
