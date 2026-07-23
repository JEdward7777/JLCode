/**
 * Vitest config, kept separate from vite.config.ts (which sets root: web for the
 * client build). Tests live in test/ and exercise the Node server/core, so the
 * root stays the project directory — not the browser client root.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
