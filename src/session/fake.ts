/**
 * Fake LLM drivers for offline development and tests — so the walking skeleton
 * and the loop can be exercised without a live (paid) OpenRouter call.
 */
import zlib from "node:zlib";
import type { ChatRequest, LlmDriver, StreamEvent } from "../llm/types.js";

export function scriptedDriver(
  script: StreamEvent[] | ((req: ChatRequest) => StreamEvent[]),
): LlmDriver {
  return {
    async *streamChat(req) {
      const events = typeof script === "function" ? script(req) : script;
      for (const ev of events) yield ev;
    },
  };
}

export function throwingDriver(message = "simulated provider error"): LlmDriver {
  return {
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncGenerator<StreamEvent> {
      throw new Error(message);
    },
  };
}

/** Streams "You said: <last user message>" a token at a time. */
export function echoDriver(): LlmDriver {
  return scriptedDriver((req) => {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const said = typeof lastUser?.content === "string" ? lastUser.content : "";
    const text = `You said: ${said}`;
    const events: StreamEvent[] = [{ type: "reasoning", delta: "(considering) " }];
    for (const token of text.split(/(\s+)/)) {
      if (token.length > 0) events.push({ type: "text", delta: token });
    }
    events.push({ type: "finish", reason: "stop" });
    events.push({ type: "usage", usage: { promptTokens: 8, completionTokens: text.length } });
    return events;
  });
}

function textReply(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const token of text.split(/(\s+)/)) if (token.length > 0) events.push({ type: "text", delta: token });
  events.push({ type: "finish", reason: "stop" });
  // A plausible token count so spend accounting (D-33) has something to price
  // when the config carries fallback pricing (the API cost is fake-driver-absent).
  events.push({ type: "usage", usage: { promptTokens: 1000, completionTokens: Math.max(1, text.length) } });
  return events;
}

function toolCall(name: string, args: unknown): StreamEvent[] {
  return [
    { type: "tool_call", index: 0, id: `fake_${Date.now()}`, name, argsDelta: JSON.stringify(args) },
    { type: "finish", reason: "tool_calls" },
    { type: "usage", usage: { promptTokens: 1000, completionTokens: 20 } },
  ];
}

/**
 * An offline driver that can drive the *gated* flows (approvals, ask_user) end
 * to end for the browser — no spend, no key. It reacts to command prefixes in
 * the latest user message so a person can trigger each surface by hand:
 *
 *   write: <path> | <content>   → a write_file call (approval card)
 *   edit: <path> | <a> => <b>   → an apply_edits batch (unified-diff card, D-53)
 *   run: <command>              → a run_command call (approval card, edit-approve)
 *   read: <path>                → a read_file call
 *   ask: <question>             → a single-question ask_user form
 *   form:                       → a multi-question ask_user form
 *   mcp: <tool> <json>          → a bridged MCP call, e.g. `mcp: srv__echo {"text":"hi"}`
 *
 * It also answers the ephemeral auto-title question (X-09) with a short label
 * taken from the opening message, so labels can be peeked at offline.
 *
 * Anything else echoes like {@link echoDriver}. Once a tool result comes back
 * (the latest message is no longer the user's), it gives a short final answer.
 */
export function fakeAgentDriver(): LlmDriver {
  return scriptedDriver((req) => {
    const last = req.messages[req.messages.length - 1];
    // A tool result (or anything non-user) just settled → wrap up the turn.
    if (!last || last.role !== "user") return textReply("Done — the tool ran and reported back.");

    const msg = typeof last.content === "string" ? last.content.trim() : "";
    const after = (p: string) => msg.slice(p.length).trim();

    // The ephemeral auto-title question (X-09) — offline, answer it the way a
    // model would: a few words off the opening message, not an echo of the ask.
    if (msg.startsWith("Ignore the task for one moment. Name this conversation.")) {
      const opening = req.messages.find((m) => m.role === "user");
      const words = (typeof opening?.content === "string" ? opening.content : "")
        .replace(/^\w+:\s*/, "") // drop a driver prefix like `run:` / `read:`
        .split(/\s+/)
        .filter((w) => w !== "")
        .slice(0, 5)
        .join(" ");
      return textReply(words === "" ? "A new conversation" : words[0]!.toUpperCase() + words.slice(1));
    }

    if (msg.startsWith("write:")) {
      const [rawPath, ...rest] = after("write:").split("|");
      const path = (rawPath ?? "note.txt").trim() || "note.txt";
      const content = rest.join("|").trim() || "hello from JLCode\n";
      return toolCall("write_file", { path, content });
    }
    // An apply_edits batch (D-53), so the unified-diff approval card is peekable
    // offline: `edit: a.txt | old => new ; older => newer | b.txt | x => y`
    if (msg.startsWith("edit:")) {
      const files = after("edit:")
        .split("|")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const out: { path: string; edits: { old_string: string; new_string: string }[] }[] = [];
      for (const part of files) {
        if (part.includes("=>")) {
          const edits = part.split(";").map((pair) => {
            const [o, n] = pair.split("=>");
            return { old_string: (o ?? "").trim(), new_string: (n ?? "").trim() };
          });
          if (out.length > 0) out[out.length - 1]!.edits.push(...edits);
        } else {
          out.push({ path: part, edits: [] });
        }
      }
      return toolCall("apply_edits", { files: out });
    }
    if (msg.startsWith("run:")) return toolCall("run_command", { command: after("run:") || "echo hi" });
    if (msg.startsWith("read:")) return toolCall("read_file", { path: after("read:") || "README.md" });
    if (msg.startsWith("ask:")) {
      return toolCall("ask_user", { question: after("ask:") || "How should I proceed?", options: ["Yes", "No"] });
    }
    // A bridged MCP tool by its namespaced name, args verbatim (P7b) — the only
    // way to drive an MCP call offline, and how the D-48 learn card is peeked.
    if (msg.startsWith("mcp:")) {
      const rest = after("mcp:");
      const space = rest.indexOf(" ");
      const name = space < 0 ? rest : rest.slice(0, space);
      let args: unknown = {};
      try {
        args = space < 0 ? {} : JSON.parse(rest.slice(space + 1));
      } catch {
        /* malformed JSON → call it with no args and let the tool complain */
      }
      return toolCall(name || "unknown_tool", args);
    }
    if (msg.startsWith("demo")) return textReply(RICH_MD);
    if (msg.startsWith("form:")) {
      return toolCall("ask_user", {
        questions: [
          { header: "Store", question: "Which store should I use?", options: ["sqlite", "postgres"] },
          {
            header: "Targets",
            question: "Which environments?",
            options: ["dev", "staging", "prod"],
            multiSelect: true,
            allowFreeText: true,
          },
          { header: "Notes", question: "Anything else I should know?", allowFreeText: true },
        ],
      });
    }
    return echoReply(msg);
  });
}

/** A solid-colour PNG as a data URI — a clean, offline `<img src>` for the peek
 *  (base64, no spaces/parens, so marked parses it and DOMPurify keeps it). */
function solidPngDataUri(w: number, h: number, [r, g, b]: [number, number, number]): string {
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** A rich-markdown reply for the P5d browser peek: a heading, a list, an inline
 *  image (data URI — no network), and a mermaid diagram, so rendering can be
 *  eyeballed offline. Not used by tests; only the `demo` prefix reaches it. */
const RICH_MD = [
  "## Rich rendering check",
  "",
  "A few things at once:",
  "",
  "- **bold**, `inline code`, and a [link](https://example.com)",
  "- an inline image below, then a diagram",
  "",
  `![an inline image](${solidPngDataUri(150, 48, [0xe0, 0x79, 0x6b])})`,
  "",
  "```mermaid",
  "graph LR",
  "  A[User] --> B{JLCode}",
  "  B -->|tool| C[Sandbox]",
  "  B -->|reply| D[Browser]",
  "```",
  "",
  "That's the lot.",
].join("\n");

function echoReply(said: string): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "reasoning", delta: "(considering) " }, ...textReply(`You said: ${said}`)];
  return events;
}
