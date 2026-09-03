/**
 * P8a (D-78b) — `read_file` stops lying about binaries.
 *
 * The defect this closes: `read_file` decoded every path as UTF-8, so a `.png`
 * came back as a run of U+FFFD through `ok()` — a *successful* read of mush.
 * The two properties that matter are the refusals being honest and the text
 * path being byte-for-byte what it always was.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { classifySample, looksBinary, humanBytes } from "../src/tools/media";

let root: string;
let ctx: { sandbox: Sandbox };
let reg: ToolRegistry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-media-"));
  ctx = { sandbox: new Sandbox([root]) };
  reg = new ToolRegistry(fileTools());
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(name: string, args: Record<string, unknown>) {
  return reg.get(name)!.execute(args, ctx);
}

/** A real 1x1 PNG — header, IHDR, IDAT and IEND, so `file-type` sees a true signature. */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da63fcffff3f0300050001ff9c5c" +
    "5d5a0000000049454e44ae426082",
  "hex",
);
const GIF_HEADER = Buffer.from("474946383961", "hex"); // GIF89a
const JPEG_HEADER = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
const GZIP_HEADER = Buffer.from("1f8b0800000000000003", "hex");

describe("classifySample — magic bytes decide, never the filename", () => {
  it("names the four image types a vision model accepts", async () => {
    expect(await classifySample(PNG_1X1)).toMatchObject({ kind: "image", mime: "image/png" });
    expect(await classifySample(GIF_HEADER)).toMatchObject({ kind: "image", mime: "image/gif" });
    expect(await classifySample(JPEG_HEADER)).toMatchObject({ kind: "image", mime: "image/jpeg" });
  });

  it("calls a non-image binary binary, and names it when it can", async () => {
    expect(await classifySample(GZIP_HEADER)).toMatchObject({
      kind: "binary",
      mime: "application/gzip",
    });
  });

  it("calls a signature-less blob of NULs binary even though nothing named it", async () => {
    const found = await classifySample(Buffer.alloc(64));
    expect(found).toEqual({ kind: "binary" });
  });

  it("reads ordinary text, an empty file, and UTF-8 beyond ASCII as text", async () => {
    expect(await classifySample(Buffer.from("const x = 1;\n"))).toEqual({ kind: "text" });
    expect(await classifySample(Buffer.alloc(0))).toEqual({ kind: "text" });
    expect(await classifySample(Buffer.from("héllo — ünïcode ✓\n"))).toEqual({ kind: "text" });
  });

  /**
   * SVG is the sharp edge: an image MIME that is also source the model should be
   * able to read *and edit*. Diverting it would be a regression in ability, so it
   * must stay on the text path. KiloCode draws the same line.
   */
  it("keeps SVG on the text path", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    expect(await classifySample(Buffer.from(svg))).toEqual({ kind: "text" });
  });

  it("ignores the extension in both directions", async () => {
    // A .png holding text is text...
    expect(await classifySample(Buffer.from("I am not really a PNG\n"))).toEqual({ kind: "text" });
    // ...and a screenshot saved as .txt is still an image.
    expect(await classifySample(PNG_1X1)).toMatchObject({ kind: "image" });
  });
});

describe("read_file — the honest refusal", () => {
  it("refuses an image, names the format and the size, and says why", async () => {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_1X1);
    const res = await run("read_file", { path: "shot.png" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("PNG");
    expect(res.content).toContain("image/png");
    // The old behaviour: a successful read full of replacement characters.
    expect(res.content).not.toContain("�");
  });

  it("catches a PNG whose extension claims it is text", async () => {
    fs.writeFileSync(path.join(root, "notes.txt"), PNG_1X1);
    const res = await run("read_file", { path: "notes.txt" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("image/png");
  });

  it("refuses a non-image binary and names it", async () => {
    fs.writeFileSync(path.join(root, "blob.gz"), GZIP_HEADER);
    const res = await run("read_file", { path: "blob.gz" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("application/gzip");
  });

  it("refuses an unnamed binary without pretending to know what it is", async () => {
    fs.writeFileSync(path.join(root, "junk.bin"), Buffer.alloc(64));
    const res = await run("read_file", { path: "junk.bin" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not UTF-8 text");
  });
});

describe("read_file — the text path is unchanged", () => {
  it("still returns a whole small file byte-for-byte", async () => {
    const body = "line one\nline two\nline three\n";
    fs.writeFileSync(path.join(root, "a.txt"), body);
    const res = await run("read_file", { path: "a.txt" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe(body);
  });

  it("still pages with offset and limit, footer intact", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join("\n"));
    const res = await run("read_file", { path: "big.txt", offset: 10, limit: 3 });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("L10\nL11\nL12");
    expect(res.content).toContain("[lines 10-12 of 50 — continue with offset 13]");
  });

  it("still reads an empty file as empty, not as a binary", async () => {
    fs.writeFileSync(path.join(root, "empty.txt"), "");
    const res = await run("read_file", { path: "empty.txt" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("");
  });

  it("still reads a file whose extension is an image but whose bytes are source", async () => {
    fs.writeFileSync(path.join(root, "diagram.svg"), "<svg><g/></svg>");
    const res = await run("read_file", { path: "diagram.svg" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("<svg><g/></svg>");
  });

  it("still reports a missing file the way it always did", async () => {
    const res = await run("read_file", { path: "nope.txt" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("read failed");
  });

  it("still refuses a path outside the fence before ever touching disk", async () => {
    const res = await run("read_file", { path: "/etc/hostname" });
    expect(res.isError).toBe(true);
    expect(res.content).not.toContain("read failed");
  });
});

describe("helpers", () => {
  it("looksBinary catches NUL and the replacement character", () => {
    expect(looksBinary("clean text")).toBe(false);
    expect(looksBinary("has\u0000nul")).toBe(true);
    expect(looksBinary("has�mush")).toBe(true);
  });

  it("humanBytes scales", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
