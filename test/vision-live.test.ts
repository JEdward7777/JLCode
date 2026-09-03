/**
 * P8f — the model actually looks at a picture (Tier 3, live Fable).
 *
 * Everything else in Phase 8 is asserted against the fake driver and the wire
 * shape: that a `tool` message stays text, that a `user` message follows it
 * carrying `data:image/...;base64,…`, that the breakpoints still land. All of
 * that can be true of a request no model has ever accepted. This is the one test
 * where a **real vision model is handed a real photograph** and has to say what
 * is in it — the end of the chain P8a and P8b built, and the only assertion that
 * fails if the whole idea is wrong rather than if a detail drifted.
 *
 * Joshua's design, 2026-09-03: a cat, and the reply has to contain the word.
 * A keyword on a photograph is a deliberately blunt assertion — it cannot pass
 * by accident (the fake driver's stand-in reply says "I can see the image", not
 * "cat"), and it cannot fail for a reason that isn't the feature.
 *
 * ## Two things this test has to get right to stay free (D-24)
 *
 * **1. Nothing in the request may vary with the clock.** X-25 stamps each user
 * turn with a wall clock, which changes the cache key on every run — so, exactly
 * as the Fable-safety suite does, this replays with `turnTimestamps: false`
 * (TESTING.md, Joshua 2026-08-09: a test that must re-spend to stay true is
 * worse than a narrower test that stays free).
 *
 * **2. Nothing may vary with the machine.** The path is what makes this test
 * different from the others here, because it appears three times in the request
 * — in the tool-call arguments, in the tool result, and as the label on the
 * attachment — so it is a **relative** name against a sandbox fenced to this
 * directory. An absolute temp path would key the cache to one checkout.
 *
 * And the fixture image itself is part of the key: `requestSignature` hashes the
 * messages, base64 included. **`test/fixtures/cat.jpg` must never be re-encoded**
 * — not optimised, not resized, not passed through a converter. The bytes are
 * the cache key. (What is *stored* is only the response, so the committed cache
 * stays small; the picture lives in the repo once.)
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { ModeApprovalGate } from "../src/tools/mode-gate";
import { buildWireMessages } from "../src/conversation/wire";
import type { ModelConfig } from "../src/config/types";
import { liveDriver, FABLE_MODEL, LIVE, CACHE_DIR } from "./helpers/live";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
/** Relative on purpose — see the header. The sandbox below is the fence. */
const IMAGE = "cat.jpg";

/** Any recorded fixtures present → the suite can replay for free. */
function fixturesExist(): boolean {
  try {
    return fs
      .readdirSync(CACHE_DIR, { recursive: true } as { recursive: true })
      .some((f) => String(f).endsWith(".json"));
  } catch {
    return false;
  }
}

const RUN = LIVE || fixturesExist();
const SYS = "You are JLCode, a concise coding assistant. Keep replies short.";

function visionConfig(): ModelConfig {
  return {
    id: "cfg_fable_vision",
    name: "Fable — Vision",
    openRouterKey: "unused-through-caching",
    model: FABLE_MODEL,
    // No `reasoningEffort`: thinking is not what is under test, and omitting it
    // keeps `reasoning` out of the request (and off the cache key) entirely.
    sampling: { maxTokens: 300 },
    defaultMode: "code",
    defaultApproval: "full-auto",
    compaction: { auto: false, contextLength: 1_000_000 },
    // See the header — the one setting that makes a recorded replay possible.
    environment: { turnTimestamps: false },
    createdAt: "",
    updatedAt: "",
  };
}

describe.skipIf(!RUN)("a live model reads an image (Tier 3, P8f)", () => {
  it("describes a photograph handed to it through read_file", { timeout: 180_000 }, async () => {
    expect(fs.existsSync(path.join(FIXTURES, IMAGE))).toBe(true);
    const session = new Session({
      config: visionConfig(),
      driver: liveDriver(),
      systemPrompt: SYS,
      tools: new ToolRegistry(fileTools({ acceptsImages: true })),
      sandbox: new Sandbox([FIXTURES]),
      gate: new ModeApprovalGate("code", "full-auto"), // no pause: the point is the round trip
      acceptsImages: true,
    });

    await session.send(`Use read_file to look at ${IMAGE}, then tell me in one short sentence what animal it shows.`);

    const tool = session.conversation.entries.find((e) => e.type === "tool");
    if (!tool || tool.type !== "tool") throw new Error("the model never called read_file");

    // The old bug, asserted as an absence: a JPEG used to come back as a run of
    // replacement characters through `ok()` — a successful read of nothing.
    expect(tool.content).not.toMatch(/�/);
    expect(tool.name).toBe("read_file");
    expect(tool.attachments).toHaveLength(1);
    expect(tool.attachments![0]!.mime).toBe("image/jpeg");

    // The bytes really were in the request: a text-only `tool` message, and a
    // `user` message after it holding the data URI (D-78a).
    const wire = buildWireMessages(session.conversation);
    expect(typeof wire.find((m) => m.role === "tool")!.content).toBe("string");
    const parts = wire.find((m) => m.role === "user" && Array.isArray(m.content))!.content as {
      type: string;
      image_url?: { url: string };
    }[];
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(1);
    expect(parts.find((p) => p.type === "image_url")!.image_url!.url).toMatch(/^data:image\/jpeg;base64,/);

    // …and the model looked at it. Blunt on purpose (Joshua): a real vision call
    // is the only way this sentence can contain the word.
    const reply = [...session.conversation.entries].reverse().find((e) => e.type === "assistant" && e.text);
    if (!reply || reply.type !== "assistant") throw new Error("no assistant reply");
    expect(reply.text).toMatch(/\bcats?\b|kitten|feline/i);
  });
});
