/**
 * The transcript's tool-block presentation helpers (web/src/tool-view.ts, X-11).
 * The collapsed header is all you see until you ask for more, so the argument
 * gist and the size hint have to stay honest — and never collapse to nothing
 * when there *was* something to show, which is the whole point of keeping tool
 * output in the transcript instead of only in the journal.
 */
import { describe, it, expect } from "vitest";
import { formatBytes, outputStats, prettyArgs, summarizeArgs } from "../web/src/tool-view";

describe("output stats (the size hint, X-11)", () => {
  it("reports lines and bytes", () => {
    const stats = outputStats("a\nb\nc");
    expect(stats.lines).toBe(3);
    expect(stats.bytes).toBe(5);
    expect(stats.label).toBe("3 lines · 5 B");
  });

  it("says 'no output' for an empty result rather than '0 lines · 0 B'", () => {
    expect(outputStats("")).toEqual({ lines: 0, bytes: 0, label: "no output" });
  });

  it("singularizes one line", () => {
    expect(outputStats("just this").label).toBe("1 line · 9 B");
  });

  it("does not count a trailing newline as another line (a 2-line file reads as 2)", () => {
    expect(outputStats("a\nb\n").lines).toBe(2);
    expect(outputStats("a\nb\n\n").lines).toBe(3); // a genuine blank last line still counts
  });

  it("counts UTF-8 bytes, not code units", () => {
    expect(outputStats("é→").bytes).toBe(5); // 2 + 3
  });

  it("scales to KB/MB", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(outputStats("x".repeat(2048)).label).toBe("1 line · 2.0 KB");
  });
});

describe("argument gist (the collapsed header, X-11)", () => {
  it("shows a single-field call as its bare value — `ls -la`, not `command: ls -la`", () => {
    expect(summarizeArgs(JSON.stringify({ command: "ls -la" }))).toBe("ls -la");
  });

  it("labels the fields of a multi-field call", () => {
    expect(summarizeArgs(JSON.stringify({ path: "src/a.ts", content: "hi" }))).toBe("path: src/a.ts · content: hi");
  });

  it("collapses newlines so the header stays one line", () => {
    expect(summarizeArgs(JSON.stringify({ command: "echo one\necho two" }))).toBe("echo one echo two");
  });

  it("clamps long values with an ellipsis", () => {
    const gist = summarizeArgs(JSON.stringify({ command: "x".repeat(200) }), 20);
    expect(gist).toHaveLength(20);
    expect(gist.endsWith("…")).toBe(true);
  });

  it("is empty for no arguments at all", () => {
    expect(summarizeArgs(undefined)).toBe("");
    expect(summarizeArgs("{}")).toBe("");
    expect(summarizeArgs("  ")).toBe("");
  });

  it("still shows something when the args never parsed (a repaired/partial call, D-31)", () => {
    expect(summarizeArgs('{"command": "ls -l')).toBe('{"command": "ls -l');
  });

  it("handles non-object JSON args", () => {
    expect(summarizeArgs('"just a string"')).toBe("just a string");
    expect(summarizeArgs("[1,2]")).toBe("[1,2]");
  });
});

describe("expanded arguments", () => {
  it("pretty-prints parsable JSON", () => {
    expect(prettyArgs('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("passes unparsable args through verbatim — better raw than hidden", () => {
    expect(prettyArgs("{oops")).toBe("{oops");
    expect(prettyArgs(undefined)).toBe("");
  });
});
