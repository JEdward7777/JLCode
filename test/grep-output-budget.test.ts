/**
 * grep bounds its *output*, not just its match count (D-59).
 *
 * The regression, from a real $120 conversation: `grep "TTS|tts|..."` matched 15 lines,
 * three of which were single-line `.js.map` files inside `node_modules` at ~236KB each.
 * The 200-match cap never engaged. Result: one 706KB tool message — ~347k tokens — which
 * then rode every one of the 58 later requests in that conversation.
 *
 * D-55 still governs: grep may decline to look, but it may never let that read as a
 * verified absence. So every default skip has to be stated in the result.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";

let root: string;
let ctx: { sandbox: Sandbox };
let reg: ToolRegistry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-grep-"));
  ctx = { sandbox: new Sandbox([root]) };
  reg = new ToolRegistry(fileTools());
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function grep(args: Record<string, unknown>) {
  return reg.get("grep")!.execute(args, ctx);
}

describe("grep output budget (D-59)", () => {
  it("truncates a single enormous matched line", async () => {
    // The shape that caused it: one line holding an entire generated file.
    fs.writeFileSync(path.join(root, "big.txt"), `prefix ${"x".repeat(200_000)} TTS\n`);
    const res = await grep({ pattern: "TTS" });
    expect(res.isError).toBeUndefined();
    expect(res.content.length).toBeLessThan(5_000);
    expect(res.content).toContain("line truncated");
  });

  it("reproduces the real blowup and keeps it bounded", async () => {
    // Three ~236KB single-line source maps in node_modules, as in the actual run.
    const nm = path.join(root, "node_modules", "@pkg");
    fs.mkdirSync(nm, { recursive: true });
    for (const n of ["a", "b", "c"]) {
      fs.writeFileSync(path.join(nm, `${n}.js.map`), `{"mappings":"${"A".repeat(236_000)}TTS"}\n`);
    }
    fs.writeFileSync(path.join(root, "real.ts"), "export const TTS = 1;\n");

    const res = await grep({ pattern: "TTS" });
    expect(res.isError).toBeUndefined();
    // Before this change the same tree returned ~706KB.
    expect(res.content.length).toBeLessThan(10_000);
    // The match that actually mattered still surfaces.
    expect(res.content).toContain("real.ts");
  });

  it("skips dependency/build dirs by default and says so", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "const TTS = 1;\n");
    fs.writeFileSync(path.join(root, "app.ts"), "const TTS = 2;\n");

    const res = await grep({ pattern: "TTS" });
    expect(res.content).toContain("app.ts");
    expect(res.content).not.toContain("node_modules");
    // D-55: the skip is reported, and names the flag that undoes it.
    expect(res.content).toContain("NOT searched");
    expect(res.content).toContain("include_ignored");
  });

  it("searches ignored trees when include_ignored is set", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "const TTS = 1;\n");

    const res = await grep({ pattern: "TTS", include_ignored: true });
    expect(res.content).toContain("node_modules");
    expect(res.content).not.toContain("NOT searched");
  });

  it("still searches an ignored file when the path names it directly", async () => {
    // Declining to *wander* into generated trees must not become refusing what was asked for.
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const f = path.join(root, "node_modules", "thing.min.js");
    fs.writeFileSync(f, "const TTS = 1;\n");

    const res = await grep({ pattern: "TTS", path: "node_modules/thing.min.js" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("TTS");
  });

  it("a clean 'no matches' is still unqualified when nothing was skipped", async () => {
    // The D-55 invariant: silence is only allowed after a complete search.
    fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
    const res = await grep({ pattern: "TTS" });
    expect(res.content).toContain("no matches");
    expect(res.content).not.toContain("NOT searched");
    expect(res.content).not.toContain("truncated");
  });
});
