/**
 * P8b (D-78) — bytes to the model.
 *
 * The load-bearing fact this whole slice is shaped around: the OpenAI/OpenRouter
 * wire **rejects** image content inside a `role:"tool"` message. So the tool
 * answers its `tool_call_id` with text and the picture rides in a following
 * `user` message, which is why `ToolResult.content`, `ToolEntry.content` and
 * every `system`/`assistant`/`tool` message stay `string`.
 *
 * Two of these describes guard *silent* failures rather than visible ones, and
 * they are the reason the file exists:
 *
 *   - cache breakpoints on a parts message. `markable()` used to test
 *     `typeof content === "string"`, which was true of every message JLCode had
 *     ever built. A request carrying an image would have got **zero**
 *     breakpoints, with no error — D-58's measured 12.3x wearing a new hat.
 *   - the text-only transcript, byte for byte. Attachments must be additive:
 *     a conversation with no images has to build the identical request it always
 *     did, or the committed Tier-3 replay cache (keyed on `requestSignature`)
 *     is thrown away.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { newConversation, appendEntry } from "../src/conversation/tree";
import { attachmentsMessage, buildWireMessages } from "../src/conversation/wire";
import { applyCacheBreakpoints } from "../src/llm/cache-breakpoints";
import { requestSignature } from "../src/llm/cache";
import { Session } from "../src/session/session";
import { Sandbox } from "../src/tools/sandbox";
import { ToolRegistry, defaultTools } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { MAX_IMAGE_BYTES } from "../src/tools/media";
import { resolveImages } from "../src/server/session-factory";
import { ModelCatalog } from "../src/llm/models";
import type { ChatMessage, ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";
import type { Attachment } from "../src/conversation/types";
import type { ModelConfig } from "../src/config/types";

/** A real 1x1 PNG — a true signature, so `file-type` classifies it for real. */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da63fcffff3f0300050001ff9c5c" +
    "5d5a0000000049454e44ae426082",
  "hex",
);
const PNG_B64 = PNG_1X1.toString("base64");

let root: string;
let ctx: { sandbox: Sandbox };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p8b-"));
  ctx = { sandbox: new Sandbox([root]) };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const readFile = (opts: { acceptsImages?: boolean } = {}) => new ToolRegistry(fileTools(opts)).get("read_file")!;

describe("read_file hands over the bytes — when the model can see them (P8b)", () => {
  it("answers with text and attaches the image beside it", async () => {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_1X1);
    const res = await readFile({ acceptsImages: true }).execute({ path: "shot.png" }, ctx);

    // The tool message itself is text — the wire takes nothing else (D-78a).
    expect(res.isError).toBeUndefined();
    expect(typeof res.content).toBe("string");
    expect(res.content).toContain("shot.png");
    expect(res.content).toContain("image/png");
    expect(res.content).not.toContain("�");
    // …and the bytes ride alongside, base64, unmangled.
    expect(res.attachments).toEqual([{ mime: "image/png", data: PNG_B64, name: "shot.png" }]);
  });

  it("catches a screenshot saved as .txt here too — magic bytes, not the name", async () => {
    fs.writeFileSync(path.join(root, "notes.txt"), PNG_1X1);
    const res = await readFile({ acceptsImages: true }).execute({ path: "notes.txt" }, ctx);
    expect(res.attachments?.[0]?.mime).toBe("image/png");
  });

  it("still reads text as text, with nothing attached", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "line one\nline two\n");
    const res = await readFile({ acceptsImages: true }).execute({ path: "a.txt" }, ctx);
    expect(res.content).toBe("line one\nline two\n");
    expect(res.attachments).toBeUndefined();
  });

  it("still refuses a non-image binary — seeing is not the same as decoding", async () => {
    fs.writeFileSync(path.join(root, "blob.gz"), Buffer.from("1f8b0800000000000003", "hex"));
    const res = await readFile({ acceptsImages: true }).execute({ path: "blob.gz" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("application/gzip");
    expect(res.attachments).toBeUndefined();
  });

  it("refuses an image past the size cap, and sends nothing", async () => {
    // Oversized on two counts: the provider's own per-image limit, and the
    // inline base64 that P8c has not yet moved to a sidecar.
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(MAX_IMAGE_BYTES)]);
    fs.writeFileSync(path.join(root, "huge.png"), big);
    const res = await readFile({ acceptsImages: true }).execute({ path: "huge.png" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("image/png");
    expect(res.content).toContain("Nothing was sent");
    expect(res.attachments).toBeUndefined();
  });
});

describe("a model that cannot see is never told it can (D-78c)", () => {
  it("refuses the image naming the model, not the file", async () => {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_1X1);
    const res = await readFile().execute({ path: "shot.png" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("does not accept images");
    expect(res.attachments).toBeUndefined();
  });

  it("keeps images out of the tool description, so the model never tries", () => {
    // The failure has to be *absence*, not a 400 mid-turn: what is advertised
    // and what the tool does come off the same flag (X-33's lesson).
    expect(readFile().def.function.description).not.toMatch(/image|PNG/i);
    expect(readFile({ acceptsImages: true }).def.function.description).toMatch(/PNG, JPEG, GIF and WebP/);
  });
});

/** A `tool` entry carrying `n` attachments, chained onto `conv`. */
function withImages(conv: ReturnType<typeof newConversation>, id: string, names: string[]) {
  return appendEntry(conv, {
    type: "tool",
    toolCallId: id,
    name: "read_file",
    content: `${names.join(", ")} — attached`,
    attachments: names.map((name) => ({ mime: "image/png", data: PNG_B64, name })),
  }).conv;
}

describe("buildWireMessages flushes attachments into a user message (D-78a)", () => {
  it("keeps the tool message text-only and puts the picture in the message after it", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "look at this" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "" }).conv;
    conv = withImages(conv, "c1", ["shot.png"]);

    const msgs = buildWireMessages(conv, { system: "SYS" });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);

    const toolMsg = msgs[3]!;
    expect(typeof toolMsg.content).toBe("string");
    expect(JSON.stringify(toolMsg)).not.toContain("base64");

    const flushed = msgs[4]!.content as { type: string }[];
    expect(flushed[0]).toMatchObject({ type: "text" });
    expect(flushed[1]).toEqual({ type: "text", text: "[1] shot.png (image/png)" });
    expect(flushed[2]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } });
  });

  it("gathers a run of tool results into ONE user message, in order", () => {
    // Three parallel reads make three tool messages and one user message — not
    // three interleaved pairs, which would split the run of `tool` messages that
    // must sit unbroken after the assistant turn that called them.
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "read all three" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "" }).conv;
    conv = withImages(conv, "c1", ["a.png"]);
    conv = withImages(conv, "c2", ["b.png"]);
    conv = withImages(conv, "c3", ["c.png"]);

    const msgs = buildWireMessages(conv, { system: "SYS" });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "tool", "user"]);
    const parts = msgs[6]!.content as { type: string; text?: string }[];
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(3);
    expect(parts.filter((p) => p.type === "text").map((p) => p.text)).toEqual([
      expect.stringContaining("3 images"),
      "[1] a.png (image/png)",
      "[2] b.png (image/png)",
      "[3] c.png (image/png)",
    ]);
  });

  it("flushes before the next assistant turn, not after it", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "look" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "" }).conv;
    conv = withImages(conv, "c1", ["shot.png"]);
    conv = appendEntry(conv, { type: "assistant", text: "I see a red square." }).conv;

    const msgs = buildWireMessages(conv, { system: "SYS" });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user", "assistant"]);
  });

  it("flushes before a following user turn too", () => {
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "look" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "" }).conv;
    conv = withImages(conv, "c1", ["shot.png"]);
    conv = appendEntry(conv, { type: "user", text: "and now?" }).conv;

    const msgs = buildWireMessages(conv, { system: "SYS" });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user", "user"]);
    expect(Array.isArray(msgs[4]!.content)).toBe(true);
    expect(typeof msgs[5]!.content).toBe("string");
  });

  it("drops attachments a compaction summarized away", () => {
    // Everything above the cut is gone, including bytes that had not flushed —
    // they belong to a turn that no longer exists in the replayed window.
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "look" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "" }).conv;
    conv = withImages(conv, "c1", ["shot.png"]);
    conv = appendEntry(conv, { type: "compaction", summary: "SUMMARY", replayCut: true }).conv;

    const msgs = buildWireMessages(conv, { system: "SYS" });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(JSON.stringify(msgs)).not.toContain("base64");
  });

  it("builds a text-only conversation byte-for-byte the way it always did", () => {
    // Additive or nothing: this is what keeps the committed replay cache valid,
    // since `requestSignature` hashes `req.messages`.
    let conv = newConversation();
    conv = appendEntry(conv, { type: "user", text: "hi" }).conv;
    conv = appendEntry(conv, { type: "assistant", text: "hello" }).conv;
    conv = appendEntry(conv, { type: "tool", toolCallId: "c1", name: "grep", content: "one match" }).conv;

    const msgs = buildWireMessages(conv, { system: "SYS", stamps: false });
    expect(msgs).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "tool", tool_call_id: "c1", name: "grep", content: "one match" },
    ]);
  });

  it("says 'an image' for one and counts them for several", () => {
    const one: Attachment[] = [{ mime: "image/png", data: PNG_B64, name: "a.png" }];
    const two: Attachment[] = [...one, { mime: "image/jpeg", data: PNG_B64, name: "b.jpg" }];
    expect((attachmentsMessage(one).content as { text?: string }[])[0]!.text).toContain("an image");
    expect((attachmentsMessage(two).content as { text?: string }[])[0]!.text).toContain("2 images");
    // A nameless attachment still gets a label rather than an empty one.
    const bare = attachmentsMessage([{ mime: "image/png", data: PNG_B64 }]);
    expect((bare.content as { text?: string }[])[1]!.text).toBe("[1] attachment 1 (image/png)");
  });
});

const CLAUDE = "anthropic/claude-opus-5";

/** Indices carrying a breakpoint, in order. */
function marked(msgs: ReturnType<typeof applyCacheBreakpoints>): number[] {
  const out: number[] = [];
  msgs.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some((p) => p.cache_control)) out.push(i);
  });
  return out;
}

describe("caching does not silently die on an image (D-78f, the D-58 lesson)", () => {
  const withImage: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "look at the screenshot" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", name: "read_file", content: "shot.png — attached" },
    {
      role: "user",
      content: [
        { type: "text", text: "attached:" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      ],
    },
  ];

  it("still places its breakpoints when the last message is parts", () => {
    // The old `typeof content === "string"` test would have marked index 4 as
    // unmarkable and walked back to the tool result — or, with the image last on
    // every turn, placed the write point nowhere useful at all. No error either way.
    expect(marked(applyCacheBreakpoints(withImage, CLAUDE))).toEqual([0, 1, 4]);
  });

  it("marks the LAST part, so the images are inside the cached prefix", () => {
    const out = applyCacheBreakpoints(withImage, CLAUDE);
    const parts = out[4]!.content as { type: string; cache_control?: unknown }[];
    expect(parts[0]!.cache_control).toBeUndefined();
    expect(parts[1]).toMatchObject({ type: "image_url", cache_control: { type: "ephemeral" } });
  });

  it("anchors on the turn the person typed, never on the attachment message", () => {
    // The attachment message is a `user` message JLCode wrote, sitting mid-turn
    // right after the tool results. Anchoring there lands one slot from the write
    // point and buys the same nothing an adjacent tool result would.
    const longer: ChatMessage[] = [
      ...withImage,
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", name: "grep", content: "a match" },
    ];
    expect(marked(applyCacheBreakpoints(longer, CLAUDE))).toEqual([0, 1, 6]);
  });

  it("leaves a text-only request hashing exactly what it hashed before", () => {
    const plain: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ];
    const req: ChatRequest = { model: CLAUDE, messages: plain };
    expect(requestSignature(req)).toBe(
      requestSignature({ model: CLAUDE, messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }] }),
    );
    // …and the marker never reaches the transcript that gets hashed.
    applyCacheBreakpoints(plain, CLAUDE);
    expect(plain[0]!.content).toBe("sys");
  });
});

describe("the capability is settled once, from a fetch we already make", () => {
  let dir: string;
  const config = (model: string, acceptsImages?: boolean): ModelConfig => ({
    id: "c",
    name: "T",
    openRouterKey: "sk",
    model,
    defaultMode: "code",
    defaultApproval: "manual",
    ...(acceptsImages === undefined ? {} : { acceptsImages }),
    createdAt: "",
    updatedAt: "",
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-p8b-cat-"));
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        windows: { "vision/model": 200000, "text/model": 200000 },
        modalities: { "vision/model": ["text", "image"], "text/model": ["text"] },
      }),
      "utf8",
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const catalog = () => new ModelCatalog({ file: path.join(dir, "models.json") });

  it("follows the catalog when the config says nothing", () => {
    expect(resolveImages(config("vision/model"), catalog())).toEqual({ acceptsImages: true, support: "yes" });
    expect(resolveImages(config("text/model"), catalog())).toEqual({ acceptsImages: false, support: "no" });
  });

  it("treats an unknown model as text-only, but still reports that it is a guess", () => {
    // Withholding costs a refusal that names its reason; advertising costs a
    // provider 400 in the middle of a task.
    expect(resolveImages(config("who/dis"), catalog())).toEqual({ acceptsImages: false, support: "unknown" });
  });

  it("lets the config override the catalog in both directions", () => {
    expect(resolveImages(config("who/dis", true), catalog()).acceptsImages).toBe(true);
    expect(resolveImages(config("vision/model", false), catalog()).acceptsImages).toBe(false);
  });
});

describe("end to end: a session reads a PNG and the request carries it (P8b done-when)", () => {
  const config: ModelConfig = {
    id: "cfg",
    name: "T",
    openRouterKey: "sk",
    model: CLAUDE,
    defaultMode: "code",
    defaultApproval: "full-auto",
    createdAt: "",
    updatedAt: "",
  };

  /** Calls `read_file`, then answers — recording every request it was sent. */
  function readThenAnswer(sent: ChatRequest[], acceptsImages: boolean): LlmDriver {
    let calls = 0;
    return {
      async *streamChat(req): AsyncGenerator<StreamEvent> {
        sent.push(req);
        calls++;
        if (calls === 1) {
          yield { type: "tool_call", index: 0, id: "c1", name: "read_file", argsDelta: JSON.stringify({ path: "shot.png" }) };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text", delta: acceptsImages ? "A tiny red square." : "I cannot see it." };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
  }

  async function run(acceptsImages: boolean): Promise<ChatRequest[]> {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_1X1);
    const sent: ChatRequest[] = [];
    const session = new Session({
      config,
      driver: readThenAnswer(sent, acceptsImages),
      tools: new ToolRegistry(defaultTools({ acceptsImages })),
      sandbox: new Sandbox([root]),
      approval: "full-auto",
    });
    await session.send("what is in shot.png?");
    return sent;
  }

  it("sends a text-only tool message and a user message holding the data URI", async () => {
    const sent = await run(true);
    const second = sent[1]!.messages;
    const toolMsg = second.find((m) => m.role === "tool")!;
    expect(typeof toolMsg.content).toBe("string");
    expect(toolMsg.content).toContain("shot.png");

    const last = second[second.length - 1]!;
    expect(last.role).toBe("user");
    const parts = last.content as { type: string; image_url?: { url: string } }[];
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toBe(`data:image/png;base64,${PNG_B64}`);
    // The whole point: not one replacement character anywhere in the request.
    expect(JSON.stringify(second)).not.toContain("�");
  });

  it("survives into the *next* turn, because the wire is rebuilt from the tree", async () => {
    // An attachment kept only on the live `ToolResult` would be gone by the next
    // send — and by the next resume — while the model went on answering as if it
    // could still see the picture. So it has to be on the entry, and the proof is
    // a second turn built from the tree alone.
    fs.writeFileSync(path.join(root, "shot.png"), PNG_1X1);
    const sent: ChatRequest[] = [];
    const session = new Session({
      config,
      driver: readThenAnswer(sent, true),
      tools: new ToolRegistry(defaultTools({ acceptsImages: true })),
      sandbox: new Sandbox([root]),
      approval: "full-auto",
    });
    await session.send("what is in shot.png?");
    await session.send("and what colour is it?");

    const third = sent[2]!.messages;
    const parts = third.filter((m) => Array.isArray(m.content));
    expect(parts).toHaveLength(1);
    expect(JSON.stringify(parts)).toContain(PNG_B64);
    // It sits where it was, mid-history — the new question comes after it.
    expect(third[third.length - 1]!.content).toContain("and what colour is it?");
  });

  it("gives a text-only model neither the image nor a broken tool result", async () => {
    const sent = await run(false);
    const second = sent[1]!.messages;
    expect(second.every((m) => typeof m.content === "string" || m.content === null)).toBe(true);
    expect(JSON.stringify(second)).toContain("does not accept images");
    expect(JSON.stringify(second)).not.toContain("base64");
  });

  it("still lands a cache breakpoint on the turn that carries the image", async () => {
    const sent = await run(true);
    const out = applyCacheBreakpoints(sent[1]!.messages, CLAUDE);
    expect(marked(out).length).toBeGreaterThanOrEqual(2);
    // …and the write point is the attachment message itself, the last thing sent.
    expect(marked(out)).toContain(out.length - 1);
  });
});
