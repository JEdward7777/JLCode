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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-ft-"));
  ctx = { sandbox: new Sandbox([root]) };
  reg = new ToolRegistry(fileTools());
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(name: string, args: Record<string, unknown>) {
  return reg.get(name)!.execute(args, ctx);
}

describe("file tools", () => {
  it("writes, reads, lists, and deletes", async () => {
    expect((await run("write_file", { path: "a.txt", content: "hello" })).isError).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("hello");

    expect((await run("read_file", { path: "a.txt" })).content).toBe("hello");

    const list = await run("list_dir", { path: "." });
    expect(list.content).toContain("a.txt");

    expect((await run("delete_file", { path: "a.txt" })).content).toContain("deleted");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("globs and greps", async () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "x.ts"), "const foo = 1;\nconst bar = 2;\n");
    fs.writeFileSync(path.join(root, "src", "y.ts"), "const baz = 3;\n");

    const g = await run("glob", { pattern: "src/**/*.ts" });
    expect(g.content.split("\n").sort()).toEqual([path.join("src", "x.ts"), path.join("src", "y.ts")]);

    const grep = await run("grep", { pattern: "foo", path: "src" });
    expect(grep.content).toContain("x.ts");
    expect(grep.content).toContain("foo = 1");
  });

  // grep's cardinal rule: "no matches" must mean the target was searched and holds nothing.
  // Anything it could not search is an error or a stated caveat — never silence, because a
  // caller reads silence as a verified absence and reports it to the user as fact.
  describe("grep never reports a silent false negative", () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(root, "models"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "models", "product.py"),
        "class Product:\n    needs_bc_update = False\n",
      );
    });

    it("searches a single file when path names one", async () => {
      const res = await run("grep", { pattern: "needs_bc_update", path: "models/product.py" });
      expect(res.isError).toBeUndefined();
      expect(res.content).toContain("needs_bc_update");
      expect(res.content).toContain("models/product.py:2");
    });

    it("agrees with the directory search that found the match", async () => {
      const viaFile = await run("grep", { pattern: "needs_bc_update", path: "models/product.py" });
      const viaDir = await run("grep", { pattern: "needs_bc_update", path: "models" });
      expect(viaFile.content).toContain("needs_bc_update");
      expect(viaDir.content).toContain("needs_bc_update");
    });

    it("errors on a path that does not exist instead of reporting no matches", async () => {
      const res = await run("grep", { pattern: "anything", path: "models/nope.py" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("does not exist");
      expect(res.content).not.toContain("no matches");
    });

    it("says how many files it read when it finds nothing", async () => {
      const res = await run("grep", { pattern: "absent_symbol", path: "models" });
      expect(res.isError).toBeUndefined();
      expect(res.content).toContain("no matches");
      expect(res.content).toContain("searched 1 file");
    });

    it("searches inside dot-directories", async () => {
      fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "runs-on: ubuntu\n");

      const res = await run("grep", { pattern: "runs-on", path: "." });
      expect(res.content).toContain("ci.yml");
    });

    it("does not walk into .git", async () => {
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "COMMIT_EDITMSG"), "needs_bc_update\n");

      const res = await run("grep", { pattern: "needs_bc_update", path: "." });
      expect(res.content).not.toContain("COMMIT_EDITMSG");
      expect(res.content).toContain("product.py");
    });

    it("keeps searching past the old 2000-file cap", async () => {
      // A non-matching file costs no output, so there is no honest reason to stop reading. The
      // needle sits well beyond the cap that used to end the scan; before this, the tool reported
      // "(no matches)" for a corpus it had simply stopped looking at.
      const many = path.join(root, "many");
      fs.mkdirSync(many, { recursive: true });
      for (let i = 0; i < 2600; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), "nothing\n");
      fs.writeFileSync(path.join(many, "zz-last.txt"), "the needle is here\n");

      const res = await run("grep", { pattern: "needle", path: "many" });
      expect(res.content).toContain("zz-last.txt");
      expect(res.content).not.toContain("INCOMPLETE");
    });

    it("stops at the match cap and says so", async () => {
      const noisy = path.join(root, "noisy");
      fs.mkdirSync(noisy, { recursive: true });
      for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(noisy, `f${i}.txt`), "needle\n");

      const res = await run("grep", { pattern: "needle", path: "noisy" });
      expect(res.content).toContain("stopped at 200 matches");
      expect(res.content.split("\n").filter((l) => l.includes("needle")).length).toBeLessThanOrEqual(201);
    });

    it("reports skipped oversized files", async () => {
      fs.writeFileSync(path.join(root, "models", "big.txt"), "x".repeat(600 * 1024));

      const res = await run("grep", { pattern: "absent_symbol", path: "models" });
      expect(res.content).toContain("larger than");
    });

    it("still reports a clean miss without caveats", async () => {
      const res = await run("grep", { pattern: "absent_symbol", path: "models/product.py" });
      expect(res.content).toContain("no matches");
      expect(res.content).not.toContain("[grep:");
    });
  });

  it("refuses paths outside the fence (until widened)", async () => {
    const res = await run("read_file", { path: "../../etc/passwd" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("outside the workspace");
  });

  it("write is atomic: no temp file left behind", async () => {
    await run("write_file", { path: "b.txt", content: "x" });
    const leftover = fs.readdirSync(root).filter((f) => f.includes(".tmp"));
    expect(leftover).toEqual([]);
  });
});
