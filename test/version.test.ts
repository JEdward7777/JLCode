import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getVersion } from "../src/version";

describe("getVersion", () => {
  it("matches package.json and looks like a version", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(getVersion()).toBe(pkg.version);
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
