#!/usr/bin/env node
/**
 * A real stdio MCP server, used by the Tier-1 MCP tests so the client is
 * exercised over an actual child process + JSON-RPC handshake rather than a
 * mock (P7a). Three tools, chosen to cover the classification rules:
 *
 *   echo        — no annotations → conservative default (command / mutating)
 *   peek        — `readOnlyHint` → demoted to a read tool
 *   touch_file  — writes a file, so the workspace fence has something to catch
 *
 * `JLCODE_TEST_MCP_FAIL=1` makes it exit before serving, to test a dead server.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";

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

await server.connect(new StdioServerTransport());
