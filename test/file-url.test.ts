/**
 * `file_url` (X-43, D-83) — the tool half. It mints a fenced, token-addressed
 * URL for a file the *user* should see and the model never reads, so the two
 * things worth pinning are what it refuses and that the URL it returns actually
 * addresses the file it recorded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Sandbox } from "../src/tools/sandbox";
import { fileUrlTool, MAX_SHARE_BYTES, textMimeFor } from "../src/tools/file-url";
import type { ToolContext } from "../src/tools/types";

// A one-pixel PNG: enough of a signature for `file-type` to name it, which is
// the whole point — the classification must come from bytes, not the extension.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

let root: string;
let ctx: ToolContext;
const tool = fileUrlTool();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-fu-"));
  ctx = { sandbox: new Sandbox([root]), conversationId: "cv_test123" };
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (args: Record<string, unknown>) => tool.execute(args, ctx);

describe("file_url", () => {
  it("mints one URL per file, indexed in order", async () => {
    fs.writeFileSync(path.join(root, "shot.png"), PNG);
    fs.writeFileSync(path.join(root, "notes.md"), "# hi");

    const res = await run({ paths: ["shot.png", "notes.md"] });

    expect(res.isError).toBeUndefined();
    expect(res.files).toHaveLength(2);
    const [png, md] = res.files!;
    expect(png!.mime).toBe("image/png");
    expect(md!.mime).toBe("text/markdown");
    // One token for the call; the index picks the file within it.
    expect(md!.token).toBe(png!.token);
    expect(res.content).toContain(`/conversation/cv_test123/file/${png!.token}/0`);
    expect(res.content).toContain(`/conversation/cv_test123/file/${png!.token}/1`);
  });

  it("records the fence it was validated against, and the bytes it saw", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    const file = (await run({ paths: ["a.txt"] })).files![0]!;

    expect(file.fenceRoot).toBe(new Sandbox([root]).primary);
    expect(file.resolved).toBe(path.join(root, "a.txt"));
    expect(file.bytes).toBe(5);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.mime).toBe("text/plain");
  });

  it("never returns the file's contents to the model", async () => {
    fs.writeFileSync(path.join(root, "secret.txt"), "PASSWORD=hunter2");
    const res = await run({ paths: ["secret.txt"] });

    // The whole point of the tool: the agent gets an address, not the bytes.
    expect(res.content).not.toContain("hunter2");
    expect(res.attachments).toBeUndefined();
  });

  it("refuses a path outside the fence", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-out-"));
    fs.writeFileSync(path.join(outside, "x.txt"), "nope");
    try {
      const res = await run({ paths: [path.join(outside, "x.txt")] });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("outside the workspace");
      expect(res.files).toBeUndefined();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a binary by name, and says which it was", async () => {
    // A PDF signature: classified, not an image, not text.
    fs.writeFileSync(path.join(root, "doc.pdf"), Buffer.from("255044462d312e340a25", "hex"));
    const res = await run({ paths: ["doc.pdf"] });

    expect(res.isError).toBe(true);
    expect(res.content).toContain("doc.pdf");
    expect(res.content).toMatch(/binary|only images and text/);
  });

  it("keeps the files it could share when one path fails", async () => {
    fs.writeFileSync(path.join(root, "ok.txt"), "fine");
    const res = await run({ paths: ["ok.txt", "missing.txt"] });

    expect(res.isError).toBeUndefined();
    expect(res.files).toHaveLength(1);
    expect(res.content).toContain("no such file");
    // The index must follow the *kept* files, not the input list, or the URL
    // would address a hole.
    expect(res.content).toContain(`/${res.files![0]!.token}/0`);
  });

  it("refuses a file over the share cap", async () => {
    const big = path.join(root, "big.txt");
    fs.writeFileSync(big, Buffer.alloc(1024));
    const original = fs.statSync;
    // Cheaper than writing 25 MB to a temp dir on every run.
    const spy = (p: fs.PathLike) => {
      const s = original(p);
      if (String(p) === big) Object.defineProperty(s, "size", { value: MAX_SHARE_BYTES + 1 });
      return s;
    };
    (fs as unknown as { statSync: unknown }).statSync = spy;
    try {
      const res = await run({ paths: ["big.txt"] });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("limit");
    } finally {
      (fs as unknown as { statSync: unknown }).statSync = original;
    }
  });

  it("has no URL to mint outside a conversation", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "hi");
    const res = await tool.execute({ paths: ["a.txt"] }, { sandbox: new Sandbox([root]) });

    expect(res.isError).toBe(true);
    expect(res.content).toContain("no conversation");
  });

  it("serves markdown as markdown and everything else textual as plain", () => {
    expect(textMimeFor("/x/notes.md")).toBe("text/markdown");
    expect(textMimeFor("/x/NOTES.MARKDOWN")).toBe("text/markdown");
    expect(textMimeFor("/x/data.csv")).toBe("text/plain");
    // SVG is text (D-78b), so it can never be served as active content.
    expect(textMimeFor("/x/icon.svg")).toBe("text/plain");
  });

  it("is a read tool, so Ask and Plan mode can show a file", () => {
    expect(tool.kind).toBe("read");
    expect(tool.mutates).toBe(false);
    expect(tool.pathArgs).toEqual(["paths"]);
  });
});
