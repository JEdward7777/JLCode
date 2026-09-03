#!/usr/bin/env node
/**
 * A real stdio MCP server, used by the Tier-1 MCP tests so the client is
 * exercised over an actual child process + JSON-RPC handshake rather than a
 * mock (P7a). Four tools, chosen to cover the classification rules — and, since
 * P8e, the one content block that is not text:
 *
 *   echo        — no annotations → conservative default (command / mutating)
 *   peek        — `readOnlyHint` → demoted to a read tool
 *   touch_file  — writes a file, so the workspace fence has something to catch
 *   screenshot  — returns an `image` content block, the input P8e stopped dropping
 *
 * `JLCODE_TEST_MCP_FAIL=1` makes it exit before serving, to test a dead server.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import zlib from "node:zlib";

if (process.env.JLCODE_TEST_MCP_FAIL === "1") process.exit(3);

const server = new Server({ name: "test-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the given text back.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" }, note: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "peek",
      description: "Read-only probe.",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { target: { type: "string" } } },
    },
    {
      name: "screenshot",
      description: "Return a picture.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          /** `png` (default), `big` (over the 5 MB cap), or `lying` (a text body labelled image/png). */
          kind: { type: "string" },
        },
      },
    },
    {
      name: "touch_file",
      description: "Create a file at the given path.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === "echo") return { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] };
  if (name === "peek") return { content: [{ type: "text", text: `peeked ${args.target ?? ""}` }] };
  if (name === "screenshot") {
    const kind = String(args.kind ?? "png");
    if (kind === "lying") {
      // A server that mislabels its bytes — the reason the bridge sniffs rather
      // than trusting `mimeType` (D-78b).
      return { content: [{ type: "image", data: Buffer.from("not a png at all").toString("base64"), mimeType: "image/png" }] };
    }
    const data =
      kind === "big"
        ? Buffer.alloc(6 * 1024 * 1024).toString("base64")
        : solidPng(24, 16, [0x3f, 0x8e, 0xd0]).toString("base64");
    return {
      content: [
        { type: "text", text: `here is a ${kind} shot` },
        { type: "image", data, mimeType: "image/png" },
      ],
    };
  }
  if (name === "touch_file") {
    try {
      fs.writeFileSync(String(args.path), String(args.body ?? ""), "utf8");
      return { content: [{ type: "text", text: `wrote ${args.path}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `write failed: ${e.message}` }], isError: true };
    }
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

/** A solid-colour PNG, hand-encoded so the fixture needs no image dependency. */
function solidPng(w, h, [r, g, b]) {
  const crc32 = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
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
  ihdr[8] = 8;
  ihdr[9] = 2;
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
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await server.connect(new StdioServerTransport());
