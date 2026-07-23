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
