/**
 * Fake LLM drivers for offline development and tests — so the walking skeleton
 * and the loop can be exercised without a live (paid) OpenRouter call.
 */
import zlib from "node:zlib";
import type { ChatRequest, LlmDriver, StreamEvent } from "../llm/types.js";
import { HttpError } from "../llm/errors.js";
import { stripEnvironmentDetails } from "../conversation/wire.js";

/** Milliseconds to hold between fake stream events (`JLCODE_FAKE_LLM_DELAY_MS`).
 *  Zero — the default, and what every test runs at — streams the whole reply in
 *  one tick. A nonzero value is for **looking at** the browser: a turn that
 *  settles instantly can't be screenshotted mid-flight, so the streaming surfaces
 *  (the live overlay, its branch pinning under H-05) are otherwise unpeekable. */
function fakeDelayMs(): number {
  const raw = Number(process.env.JLCODE_FAKE_LLM_DELAY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function scriptedDriver(
  script: StreamEvent[] | ((req: ChatRequest) => StreamEvent[]),
): LlmDriver {
  return {
    async *streamChat(req) {
      const events = typeof script === "function" ? script(req) : script;
      const delay = fakeDelayMs();
      for (const ev of events) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        yield ev;
      }
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
    // Echo the user's own words, not JLCode's per-turn framing (X-25).
    const said = typeof lastUser?.content === "string" ? stripEnvironmentDetails(lastUser.content) : "";
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
 *   write: <path> | <content>   → a write_file call (approval card, X-23 preview)
 *   delete: <path>              → a delete_file call (approval card, X-23 preview)
 *   edit: <path> | <a> => <b>   → an apply_edits batch (unified-diff card, D-53)
 *   run: <command>              → a run_command call (approval card, edit-approve)
 *   read: <path>                → a read_file call
 *   ask: <q> [| a, b, c]        → a single-question ask_user form (D-72 escape hatch)
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
  // Failure shapes, so the Retry surfaces (D-57) are drivable offline: `fail:`
  // is a dead end a retry fixes, `flaky:` a blip it rides out on its own, and
  // `hang:` a request that never answers. Each misbehaves once and then works,
  // because what needs looking at is the *recovery*, not the failure.
  const spent = new Set<string>();
  const scripted = scriptedDriver(fakeAgentScript);
  return {
    async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
      const last = req.messages[req.messages.length - 1];
      const msg =
        last?.role === "user" && typeof last.content === "string"
          ? stripEnvironmentDetails(last.content).trim()
          : "";
      const mode = /^(fail|flaky|hang):/.exec(msg)?.[1];
      if (mode && !spent.has(mode)) {
        if (mode !== "flaky") spent.add(mode); // flaky clears itself once its retries run out
        if (mode === "fail") throw new HttpError(402, "OpenRouter 402 Payment Required: Insufficient credits");
        if (mode === "flaky") {
          flakyLeft -= 1;
          if (flakyLeft <= 0) spent.add("flaky");
          throw new HttpError(503, "OpenRouter 503 Service Unavailable: upstream is busy");
        }
        yield { type: "text", delta: "Let me think about " };
        await new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      yield* scripted.streamChat(req, opts);
    },
  };
}

/** Attempts `flaky:` fails before it settles down — two, so the "retrying 2/2"
 *  notice is reachable without a long wait. */
let flakyLeft = 2;

function fakeAgentScript(req: ChatRequest): StreamEvent[] {
    const last = req.messages[req.messages.length - 1];
    // A tool result (or anything non-user) just settled → wrap up the turn.
    if (!last || last.role !== "user") return textReply("Done — the tool ran and reported back.");

    // An attachment message (P8b): a `user` message JLCode wrote, not one the
    // person typed, so none of the `prefix:` commands below can match it. Say
    // what arrived — offline, that is the only way to *see* that the flush put
    // the images where the wire needs them, and it keeps a `read:` of a PNG from
    // falling through to "You said: ".
    if (Array.isArray(last.content)) {
      const images = last.content.filter((part) => part.type === "image_url").length;
      const names = last.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => /^\[\d+\] (.*) \(image\/\w+\)$/.exec(part.text)?.[1])
        .filter((name): name is string => name !== undefined);
      const what = names.length > 0 ? `: ${names.join(", ")}` : "";
      return textReply(`I can see ${images === 1 ? "the image" : `${images} images`}${what}.`);
    }

    // The prefixes below match on what the *user* typed, so the X-25
    // environment block comes off first — otherwise `write: a.txt | hi` would
    // write the timestamp into the file.
    const msg = typeof last.content === "string" ? stripEnvironmentDetails(last.content).trim() : "";
    const after = (p: string) => msg.slice(p.length).trim();

    // The ephemeral auto-title question (X-09) — offline, answer it the way a
    // model would: a few words off the opening message, not an echo of the ask.
    if (msg.startsWith("Ignore the task for one moment. Name this conversation.")) {
      const opening = req.messages.find((m) => m.role === "user");
      // The opening turn carries X-25's environment block too, and it must come
      // off *before* the words are counted — otherwise a short message (or a
      // bare driver prefix like `form:`, which leaves nothing behind) titles the
      // thread `<environment_details> # Current Time …`. Seen in a peek.
      const words = stripEnvironmentDetails(typeof opening?.content === "string" ? opening.content : "")
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
    // `delete: <path>` — the delete_file approval card and its file preview (X-23).
    if (msg.startsWith("delete:")) return toolCall("delete_file", { path: after("delete:") || "note.txt" });
    if (msg.startsWith("run:")) return toolCall("run_command", { command: after("run:") || "echo hi" });
    if (msg.startsWith("read:")) return toolCall("read_file", { path: after("read:") || "README.md" });
    // `todo:` reads the shared list; `todo: {"add":["one"]}` writes it, args
    // verbatim. The write is refused until a read has happened (the X-31
    // barrier), so a peek sends the bare form first — which is the barrier
    // working, not the fake misbehaving.
    if (msg.startsWith("todo:")) {
      const rest = after("todo:");
      if (rest === "") return toolCall("todo_read", {});
      try {
        return toolCall("todo_write", JSON.parse(rest) as Record<string, unknown>);
      } catch {
        return textReply(`fake driver: \`todo:\` wants JSON args for todo_write, got ${JSON.stringify(rest)}`);
      }
    }
    // `ask: <question>` — or `ask: <question> | a, b, c` to name the options,
    // which is what poses the D-72 card with something other than Yes/No.
    if (msg.startsWith("ask:")) {
      const [q, opts] = after("ask:").split("|");
      const options = opts
        ? opts
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : ["Yes", "No"];
      return toolCall("ask_user", { question: (q ?? "").trim() || "How should I proceed?", options });
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
          },
          // One `required` field, so the peek can pose the case where the skip is
          // withheld — and see that typing still satisfies it (D-72).
          { header: "Ticket", question: "Which ticket is this for?", required: true },
          { header: "Notes", question: "Anything else I should know?" },
        ],
      });
    }
  return echoReply(msg);
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
