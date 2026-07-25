/**
 * Live-tier test plumbing (TESTING.md Tiers 2/3). A live model call goes through
 * the request-keyed cache (D-24) committed under `test/fixtures/llm-cache/`: the
 * FIRST run with `JLCODE_LIVE=1` + a key makes a real call and records it; every
 * run after replays for free (CI included), and the git diff shows when a recorded
 * response changes. A cache **miss without** `JLCODE_LIVE` throws loudly rather
 * than silently spending — the signal to re-record after our request changed.
 *
 * Targets are per-model (TESTING.md): the Fable tier is aimed straight at the
 * Fable×compaction boundary (O-02 / D-38). Key + model slugs come from the
 * environment, falling back to the local config store's first stored key and the
 * known OpenRouter slugs so a developer with JLCode already configured can run it.
 */
import { fileURLToPath } from "node:url";
import { CachingDriver } from "../../src/llm/caching-driver.js";
import { LlmCache } from "../../src/llm/cache.js";
import { OpenRouterClient } from "../../src/llm/client.js";
import type { LlmDriver } from "../../src/llm/types.js";
import { loadConfig } from "../../src/config/store.js";
import { resolvePaths } from "../../src/paths.js";

/** Whether live calls may actually fire (a cache miss). Replays are always free. */
export const LIVE = process.env.JLCODE_LIVE === "1";

/** The committed Tier-1/3 fixture cache (kept in-repo, never gitignored). */
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/llm-cache/", import.meta.url));

export const FABLE_MODEL = process.env.JLCODE_FABLE_MODEL ?? "anthropic/claude-fable-5";
export const JUDGE_MODEL = process.env.JLCODE_JUDGE_MODEL ?? "anthropic/claude-haiku-4.5";

/** Resolve the OpenRouter key: explicit env wins, else the first stored config's
 *  key (a developer with JLCode configured). Undefined → live calls can't fire. */
export function liveKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const cfg = loadConfig(resolvePaths());
    return cfg.modelConfigs.find((m) => m.openRouterKey)?.openRouterKey;
  } catch {
    return undefined;
  }
}

/** A driver that replays from the committed cache and only calls the real model
 *  on a miss (and only when `JLCODE_LIVE=1`); a miss without live throws. */
export function liveDriver(): LlmDriver {
  const cache = new LlmCache(FIXTURE_DIR);
  const inner: LlmDriver = {
    // eslint-disable-next-line require-yield
    async *streamChat(req, opts) {
      if (!LIVE) {
        throw new Error(
          "live-cache MISS with JLCODE_LIVE unset — the request changed; re-record with JLCODE_LIVE=1 and a key.",
        );
      }
      const key = liveKey();
      if (!key) throw new Error("JLCODE_LIVE=1 but no OpenRouter key (set OPENROUTER_API_KEY or configure JLCode).");
      const client = new OpenRouterClient({ apiKey: key, referer: "https://github.com/JEL-LL/JLCode", title: "JLCode tests" });
      yield* client.streamChat(req, opts);
    },
  };
  return new CachingDriver(inner, cache);
}

/** True when the Fable live tier is runnable now (live enabled + a key present).
 *  When false but a fixture exists the test still replays; use `hasFixture` to
 *  decide whether to run at all in a keyless environment. */
export const FABLE_RUNNABLE = LIVE && Boolean(liveKey());

/** The fixture cache directory (exported for a has-fixture probe). */
export const CACHE_DIR = FIXTURE_DIR;
