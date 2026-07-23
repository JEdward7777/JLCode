/**
 * Vite build for the P5 browser frontend (D-39). The client lives in `web/` and
 * builds to `dist/web/` as **pre-built static assets** — React/Vite are
 * build-time devDependencies, so the shipped `npx jlcode` runtime stays
 * native-free (D-25's intent). The Hono server serves `dist/web/` (see
 * serve-command.ts); this config is never imported at runtime.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  plugins: [react()],
});
