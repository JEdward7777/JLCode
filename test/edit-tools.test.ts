/**
 * `apply_edits` — anchor-based multi-edit across multiple files (D-53).
 *
 * The shape under test is the one recovered from the throwaway Python the agent
 * was writing into /tmp to work around whole-file writes: verify every anchor
 * (with an expected occurrence count) *before* writing anything, apply many
 * edits to many files in one shot, and report which lines moved.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { planFileEdits, renderDiff } from "../src/tools/edit-tools";

let root: string;
let ctx: { sandbox: Sandbox };
let reg: ToolRegistry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-edit-"));
  ctx = { sandbox: new Sandbox([root]) };
  reg = new ToolRegistry(fileTools());
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, body: string) => fs.writeFileSync(path.join(root, rel), body);
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const apply = (args: Record<string, unknown>) => reg.get("apply_edits")!.execute(args, ctx);

describe("planFileEdits (pure)", () => {
  it("applies edits in order against the running buffer", () => {
    const plan = planFileEdits("alpha\nbeta\ngamma\n", [
      { old_string: "beta", new_string: "BETA" },
      { old_string: "BETA\ngamma", new_string: "BETA\nGAMMA" }, // matches what edit 1 produced
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.output).toBe("alpha\nBETA\nGAMMA\n");
  });

  it("reports 1-based line numbers of each site", () => {
    const plan = planFileEdits("a\nb\nc\nd\n", [{ old_string: "c", new_string: "C" }]);
    expect(plan.ok && plan.edits[0]!.lines).toEqual([3]);
  });

  it("rejects an ambiguous anchor instead of guessing — the rail the model built for itself", () => {
    const plan = planFileEdits("x\nsame\ny\nsame\n", [{ old_string: "same", new_string: "other" }]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("found 2 time(s), expected 1");
  });

  it("honors an explicit expected_count for deliberate multi-site edits", () => {
    const src = "a\nsame\nb\nsame\nc\nsame\n";
    const plan = planFileEdits(src, [{ old_string: "same", new_string: "done", expected_count: 3 }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.output).toBe("a\ndone\nb\ndone\nc\ndone\n");
    expect(plan.edits[0]!.lines).toEqual([2, 4, 6]);
  });

  it("fails when the file disagrees with expected_count — drift surfaces, never absorbed", () => {
    const plan = planFileEdits("same\nsame\n", [
      { old_string: "same", new_string: "x", expected_count: 3 },
    ]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("found 2 time(s), expected 3");
  });

  it("rejects a missing anchor with a whitespace hint", () => {
    const plan = planFileEdits("hello\n", [{ old_string: "  hello", new_string: "hi" }]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("found 0 time(s)");
    expect(plan.reason).toContain("whitespace");
  });

  it("rejects empty, identical, and malformed edits", () => {
    expect(planFileEdits("a", [{ old_string: "", new_string: "x" }]).ok).toBe(false);
    expect(planFileEdits("a", [{ old_string: "a", new_string: "a" }]).ok).toBe(false);
    expect(planFileEdits("a", [{ old_string: "a", new_string: "b", expected_count: 0 }]).ok).toBe(false);
    expect(planFileEdits("a", [] as never).ok).toBe(false);
    expect(planFileEdits("a", [{ old_string: "a" } as never]).ok).toBe(false);
  });

  it("stops at the first bad edit and names which one it was", () => {
    const plan = planFileEdits("a\nb\n", [
      { old_string: "a", new_string: "A" },
      { old_string: "zzz", new_string: "Z" },
    ]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason.startsWith("edit 2:")).toBe(true);
  });
});

describe("renderDiff", () => {
  it("produces a unified diff body with add/remove counts", () => {
    const d = renderDiff("f.txt", "x\ny\nz\n", "x\nY\nz\n");
    expect(d.patch).toContain("@@");
    expect(d.patch).toContain("-y");
    expect(d.patch).toContain("+Y");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });
});

describe("apply_edits tool", () => {
  it("edits many anchors across many files in one call", async () => {
    write("code.py", "def a():\n    pass\n\ndef b():\n    pass\n");
    write("NOTES.md", "# Notes\n\n- nothing yet\n");

    const res = await apply({
      files: [
        {
          path: "code.py",
          edits: [
            { old_string: "def a():\n    pass", new_string: "def a():\n    return 1" },
            { old_string: "def b():\n    pass", new_string: "def b():\n    return 2" },
          ],
        },
        { path: "NOTES.md", edits: [{ old_string: "- nothing yet", new_string: "- a and b return" }] },
      ],
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("applied 3 edit(s) across 2 file(s)");
    expect(read("code.py")).toBe("def a():\n    return 1\n\ndef b():\n    return 2\n");
    expect(read("NOTES.md")).toContain("- a and b return");
  });

  it("is all-or-nothing: a bad anchor in the LAST file leaves the first untouched", async () => {
    write("one.txt", "keep me\n");
    write("two.txt", "other\n");

    const res = await apply({
      files: [
        { path: "one.txt", edits: [{ old_string: "keep me", new_string: "CHANGED" }] },
        { path: "two.txt", edits: [{ old_string: "not present", new_string: "x" }] },
      ],
    });

    expect(res.isError).toBe(true);
    expect(res.content).toContain("no edits applied");
    expect(res.content).toContain("two.txt");
    expect(read("one.txt")).toBe("keep me\n"); // the whole point
  });

  it("reports the lines it changed", async () => {
    write("f.txt", "a\nb\nc\nd\ne\n");
    const res = await apply({ files: [{ path: "f.txt", edits: [{ old_string: "d", new_string: "D" }] }] });
    expect(res.content).toContain("line 4");
  });

  it("refuses the same path twice rather than reading a stale buffer", async () => {
    write("f.txt", "a\n");
    const res = await apply({
      files: [
        { path: "f.txt", edits: [{ old_string: "a", new_string: "b" }] },
        { path: "f.txt", edits: [{ old_string: "b", new_string: "c" }] },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("appears twice");
    expect(read("f.txt")).toBe("a\n");
  });

  it("will not create a file — that is write_file's job", async () => {
    const res = await apply({
      files: [{ path: "nope.txt", edits: [{ old_string: "a", new_string: "b" }] }],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no edits applied");
  });

  it("rejects a malformed 'files' argument", async () => {
    expect((await apply({})).isError).toBe(true);
    expect((await apply({ files: [] })).isError).toBe(true);
    expect((await apply({ files: [{ edits: [] }] })).isError).toBe(true);
  });

  it("fences nested files[].path through classifyPaths", () => {
    const tool = reg.get("apply_edits")!;
    const classified = tool.classifyPaths!({
      files: [{ path: "a.txt", edits: [] }, { path: "/etc/passwd", edits: [] }],
    });
    expect(classified.paths.map((p) => p.value)).toEqual(["a.txt", "/etc/passwd"]);
    expect(classified.paths[0]!.field).toBe("files[].path");
    // Native tool: nothing about it is a guess, so nothing is ever asked (D-48).
    expect(classified.unknown).toEqual([]);
  });

  it("previews the batch as a unified diff before it is approved", () => {
    write("f.txt", "one\ntwo\nthree\n");
    const preview = reg.get("apply_edits")!.preview!(
      { files: [{ path: "f.txt", edits: [{ old_string: "two", new_string: "TWO" }] }] },
      ctx as never,
    );
    expect(preview!.kind).toBe("diff");
    expect(preview!.files[0]!.path).toBe("f.txt");
    expect(preview!.files[0]!.patch).toContain("+TWO");
    expect(preview!.files[0]!.added).toBe(1);
    expect(preview!.files[0]!.sites).toBe(1);
    // A preview must not touch disk — it runs on an unapproved call.
    expect(read("f.txt")).toBe("one\ntwo\nthree\n");
  });

  it("shows the failure on the card rather than after approval", () => {
    write("f.txt", "one\n");
    const preview = reg.get("apply_edits")!.preview!(
      { files: [{ path: "f.txt", edits: [{ old_string: "missing", new_string: "x" }] }] },
      ctx as never,
    );
    expect(preview!.files[0]!.error).toContain("found 0 time(s)");
    expect(preview!.files[0]!.patch).toBe("");
  });
});

describe("read_file paging (D-53)", () => {
  const run = (args: Record<string, unknown>) => reg.get("read_file")!.execute(args, ctx);

  it("returns the file verbatim when it fits and no window is asked for", async () => {
    write("s.txt", "a\nb\nc\n");
    expect((await run({ path: "s.txt" })).content).toBe("a\nb\nc\n");
  });

  it("windows by 1-based line offset and limit", async () => {
    write("s.txt", "l1\nl2\nl3\nl4\nl5\n");
    const res = await run({ path: "s.txt", offset: 2, limit: 2 });
    expect(res.content.startsWith("l2\nl3\n")).toBe(true);
    expect(res.content).toContain("[lines 2-3 of 6");
  });

  it("says how to reach the tail — the gap that left the agent anchoring blind", async () => {
    write("s.txt", "l1\nl2\nl3\nl4\n");
    const res = await run({ path: "s.txt", offset: 1, limit: 2 });
    expect(res.content).toContain("continue with offset 3");
  });

  it("omits the continue hint at the end of the file", async () => {
    write("s.txt", "l1\nl2\n");
    const res = await run({ path: "s.txt", offset: 1, limit: 99 });
    expect(res.content).not.toContain("continue with offset");
    expect(res.content).toContain("of 3]");
  });

  it("pages a file past the 100K char cap all the way to its last line", async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`);
    write("big.txt", lines.join("\n"));
    expect(fs.statSync(path.join(root, "big.txt")).size).toBeGreaterThan(100_000);

    // An unwindowed read is capped and says where it stopped. Following the
    // hint repeatedly must terminate at the tail — the old cap had no such
    // path, so everything past ~100K chars was simply unreachable.
    let res = await run({ path: "big.txt" });
    let pages = 1;
    for (;;) {
      const hint = /continue with offset (\d+)/.exec(res.content);
      if (!hint) break;
      expect(pages++).toBeLessThan(20); // must converge, not loop
      res = await run({ path: "big.txt", offset: Number(hint[1]!) });
    }
    expect(pages).toBeGreaterThan(1);
    expect(res.content).toContain("line 4000");
  });

  it("rejects a nonsense window", async () => {
    write("s.txt", "a\n");
    expect((await run({ path: "s.txt", offset: 0 })).isError).toBe(true);
    expect((await run({ path: "s.txt", limit: 0 })).isError).toBe(true);
    expect((await run({ path: "s.txt", offset: 99 })).isError).toBe(true);
  });

  it("accepts a stringified integer, as models sometimes send", async () => {
    write("s.txt", "l1\nl2\nl3\n");
    const res = await run({ path: "s.txt", offset: "2", limit: "1" });
    expect(res.content.startsWith("l2\n")).toBe(true);
  });
});
