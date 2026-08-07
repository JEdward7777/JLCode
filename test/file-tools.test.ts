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

/**
 * The approval-pause previews (X-23). `write_file` used to render as one
 * escaped JSON string, so a 300-line file showed *that* it was long and never
 * *what* it said; `delete_file` showed a bare path for the most destructive
 * tool there is. These run on an **unapproved** call, so they must read only.
 */
describe("write_file / delete_file previews (X-23)", () => {
  const preview = (name: string, args: Record<string, unknown>) =>
    reg.get(name)!.preview!(args, ctx as never);

  it("shows an overwrite as a diff against what is on disk, not the whole body", () => {
    fs.writeFileSync(path.join(root, "f.txt"), "one\ntwo\nthree\n");
    const p = preview("write_file", { path: "f.txt", content: "one\nTWO\nthree\n" });
    expect(p!.kind).toBe("diff");
    const file = (p as { files: { patch: string; added: number; removed: number; sites?: number }[] }).files[0]!;
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
    expect(file.patch).toContain("+TWO");
    expect(file.patch).toContain("-two");
    // `sites` is an apply_edits notion; a whole-file write has no anchors.
    expect(file.sites).toBeUndefined();
    // A preview never touches disk — the call is still unapproved.
    expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("reports a rewrite that changes nothing as an empty diff, not as content", () => {
    fs.writeFileSync(path.join(root, "same.txt"), "hello\n");
    const p = preview("write_file", { path: "same.txt", content: "hello\n" });
    expect(p!.kind).toBe("diff");
    const file = (p as { files: { patch: string; added: number; removed: number }[] }).files[0]!;
    expect(file.added).toBe(0);
    expect(file.removed).toBe(0);
    expect(file.patch).toBe("");
  });

  it("shows a new file as its body with a size, not as an all-green wall", () => {
    const p = preview("write_file", { path: "new.txt", content: "alpha\nbeta\n" }) as {
      kind: string;
      action: string;
      path: string;
      body: string;
      lines: number;
      bytes: number;
    };
    expect(p.kind).toBe("file");
    expect(p.action).toBe("create");
    expect(p.path).toBe("new.txt");
    expect(p.body).toBe("alpha\nbeta");
    expect(p.lines).toBe(2);
    expect(p.bytes).toBe(11);
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  it("caps a long new file and says how much it withheld", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    const p = preview("write_file", { path: "big.txt", content }) as {
      body: string;
      lines: number;
      omitted: number;
    };
    expect(p.lines).toBe(500);
    expect(p.body.split("\n")).toHaveLength(400);
    expect(p.omitted).toBe(100);
  });

  it("keeps the head of a single enormous line rather than showing an empty box", () => {
    const p = preview("write_file", { path: "min.js", content: "x".repeat(50_000) }) as { body: string };
    expect(p.body.length).toBe(20_001); // 20k chars + the ellipsis
    expect(p.body.endsWith("…")).toBe(true);
  });

  it("says so when the target is not a regular file, instead of previewing a create", () => {
    fs.mkdirSync(path.join(root, "adir"));
    const p = preview("write_file", { path: "adir", content: "x" }) as { action: string; error: string };
    expect(p.action).toBe("overwrite");
    expect(p.error).toContain("not a regular file");
  });

  it("falls back to the new body when the existing file is not UTF-8 text", () => {
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    const p = preview("write_file", { path: "bin.dat", content: "now text\n" }) as {
      kind: string;
      action: string;
      body: string;
      note: string;
    };
    expect(p.kind).toBe("file");
    expect(p.action).toBe("overwrite");
    expect(p.body).toBe("now text");
    expect(p.note).toContain("nothing to diff against");
  });

  it("previews nothing out of fence — reading it is what the fence exists to stop", () => {
    expect(preview("write_file", { path: "../../etc/passwd", content: "x" })).toBeUndefined();
    expect(preview("delete_file", { path: "../../etc/passwd" })).toBeUndefined();
  });

  it("previews nothing when the args aren't the right shape", () => {
    expect(preview("write_file", { path: "a.txt" })).toBeUndefined();
    expect(preview("delete_file", {})).toBeUndefined();
  });

  it("shows a delete as the file's size plus enough of its head to recognize it", () => {
    const body = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(root, "doomed.txt"), body);
    const p = preview("delete_file", { path: "doomed.txt" }) as {
      kind: string;
      action: string;
      body: string;
      lines: number;
      bytes: number;
      omitted: number;
    };
    expect(p.kind).toBe("file");
    expect(p.action).toBe("delete");
    expect(p.lines).toBe(100);
    expect(p.bytes).toBe(Buffer.byteLength(body));
    // Identification, not a last read: a much shorter head than a create shows.
    expect(p.body.split("\n")).toHaveLength(40);
    expect(p.body.startsWith("row 1\n")).toBe(true);
    expect(p.omitted).toBe(60);
    expect(fs.existsSync(path.join(root, "doomed.txt"))).toBe(true);
  });

  it("says a delete will fail rather than showing an empty file", () => {
    const p = preview("delete_file", { path: "gone.txt" }) as { error: string; body: string };
    expect(p.error).toContain("no such file");
    expect(p.body).toBe("");
  });

  it("shows only the size for a binary file about to be deleted", () => {
    fs.writeFileSync(path.join(root, "b.bin"), Buffer.from([0x00, 0xff, 0x00, 0xff]));
    const p = preview("delete_file", { path: "b.bin" }) as { body: string; bytes: number; note: string };
    expect(p.body).toBe("");
    expect(p.bytes).toBe(4);
    expect(p.note).toContain("not UTF-8 text");
  });
});
