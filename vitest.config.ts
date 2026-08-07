/**
 * Vitest config, kept separate from vite.config.ts (which sets root: web for the
 * client build). Tests live in test/ and exercise the Node server/core, so the
 * root stays the project directory — not the browser client root.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    /**
     * 20s, not vitest's 5s. These are not unit tests in the mocked sense — the
     * store tests fsync real files (~140ms a record, D-46), and a case like
     * X-17's "however far the thread runs" drives a dozen turns through the real
     * append path. At 5s those pass alone and fail on a loaded machine, which is
     * the worst kind of red: it points at the test that was slowest, not at
     * anything that is wrong. Measured: several suites running at once (parallel
     * worktrees are a normal workflow now) pushed a 12-turn test to 5.04s.
     * A longer ceiling weakens no assertion — a hang still fails, just later.
     */
    testTimeout: 20_000,
  },
});
