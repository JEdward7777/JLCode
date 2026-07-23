/** The package version, read from package.json (works from both src and dist). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cached: string | undefined;

export function getVersion(): string {
  if (cached !== undefined) return cached;
  // Both src/version.ts and dist/version.js sit one level below package.json.
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
    version?: string;
  };
  cached = pkg.version ?? "0.0.0";
  return cached;
}
