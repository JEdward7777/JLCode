/**
 * How the served workspace is written on screen (web/src/workspace.ts, X-10).
 * With two projects open, the tab strip and the rail are the only way to tell
 * one JLCode instance from another — so the folder name has to be right, and a
 * long path has to shorten without losing the part that identifies it.
 */
import { describe, it, expect } from "vitest";
import { abbreviatePath, folderName, tabTitle } from "../web/src/workspace";

describe("folder name (the tab title, X-10)", () => {
  it("is the last segment — the project folder, not the tool", () => {
    expect(folderName("/home/lansford/work2/general/JLCode")).toBe("JLCode");
    expect(folderName("/home/lansford/work2/file_utils")).toBe("file_utils");
  });

  it("ignores a trailing slash", () => {
    expect(folderName("/home/lansford/work2/general/JLCode/")).toBe("JLCode");
  });

  it("survives the root", () => {
    expect(folderName("/")).toBe("/");
  });
});

describe("abbreviated path (the rail header)", () => {
  const home = "/home/lansford";

  it("shortens home to ~ and elides the middle", () => {
    expect(abbreviatePath("/home/lansford/work2/general/JLCode", home)).toBe("~/work2/…/JLCode");
  });

  it("leaves a short path alone", () => {
    expect(abbreviatePath("/home/lansford/work2", home)).toBe("~/work2");
    expect(abbreviatePath("/home/lansford", home)).toBe("~");
    expect(abbreviatePath("/srv/app", undefined)).toBe("/srv/app");
  });

  it("elides a long path outside home too, keeping the leading slash", () => {
    expect(abbreviatePath("/srv/deploy/apps/checkout", home)).toBe("/srv/…/checkout");
  });

  it("does not treat a same-prefixed sibling as home (/home/lansford2)", () => {
    expect(abbreviatePath("/home/lansford2/work/thing", home)).toBe("/home/…/thing");
  });

  it("works with no home known (the server didn't say)", () => {
    expect(abbreviatePath("/home/lansford/work2/general/JLCode")).toBe("/home/…/JLCode");
  });
});

describe("tab title", () => {
  it("is the workspace folder on its own", () => {
    expect(tabTitle("JLCode")).toBe("JLCode");
  });

  it("puts a conversation label first when there is one (X-09 composes here)", () => {
    expect(tabTitle("JLCode", "Fix the SSE hang")).toBe("Fix the SSE hang — JLCode");
  });

  it("falls back to the product name before anything has loaded", () => {
    expect(tabTitle(null)).toBe("JLCode");
    expect(tabTitle(null, "  ")).toBe("JLCode");
  });
});
