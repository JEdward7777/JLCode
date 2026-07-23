/**
 * Native, sandboxed file tools (D-03): read / write / delete / list / glob /
 * grep. Every path goes through the workspace fence. Writes are atomic
 * (temp → rename), so a bad/partial write never leaves a half file (D-30).
 */
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_READ_CHARS = 100_000;
const MAX_GLOB = 500;
const MAX_GREP_FILES = 2000;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 512 * 1024;

function ok(content: string): ToolResult {
  return { content };
}
function err(content: string): ToolResult {
  return { content, isError: true };
}
function reqStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

const readFile: Tool = {
  name: "read_file",
  kind: "read",
  mutates: false,
  def: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file within the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative or absolute path" } },
        required: ["path"],
      },
    },
  },
  async execute(args, ctx) {
    const p = reqStr(args, "path");
    if (p === undefined) return err("read_file requires a string 'path'");
    const r = ctx.sandbox.resolve(p);
    if (!r.ok) return err(r.reason);
    try {
      const data = fs.readFileSync(r.path, "utf8");
      return data.length > MAX_READ_CHARS
        ? ok(data.slice(0, MAX_READ_CHARS) + `\n[truncated at ${MAX_READ_CHARS} chars]`)
        : ok(data);
    } catch (e) {
      return err(`read failed: ${(e as Error).message}`);
    }
  },
};

const writeFile: Tool = {
  name: "write_file",
  kind: "write",
  mutates: true,
  def: {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file within the workspace (atomic).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args, ctx) {
    const p = reqStr(args, "path");
    const content = reqStr(args, "content");
    if (p === undefined || content === undefined) return err("write_file requires string 'path' and 'content'");
    const r = ctx.sandbox.resolve(p);
    if (!r.ok) return err(r.reason);
    try {
      const tmp = path.join(path.dirname(r.path), `.${path.basename(r.path)}.${process.pid}.tmp`);
      fs.mkdirSync(path.dirname(r.path), { recursive: true });
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, r.path);
      return ok(`wrote ${Buffer.byteLength(content)} bytes to ${p}`);
    } catch (e) {
      return err(`write failed: ${(e as Error).message}`);
    }
  },
};

const deleteFile: Tool = {
  name: "delete_file",
  kind: "write",
  mutates: true,
  def: {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file within the workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  async execute(args, ctx) {
    const p = reqStr(args, "path");
    if (p === undefined) return err("delete_file requires a string 'path'");
    const r = ctx.sandbox.resolve(p);
    if (!r.ok) return err(r.reason);
    try {
      fs.unlinkSync(r.path);
      return ok(`deleted ${p}`);
    } catch (e) {
      return err(`delete failed: ${(e as Error).message}`);
    }
  },
};

const listDir: Tool = {
  name: "list_dir",
  kind: "read",
  mutates: false,
  def: {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries of a directory within the workspace.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Default '.'" } } },
    },
  },
  async execute(args, ctx) {
    const p = reqStr(args, "path") ?? ".";
    const r = ctx.sandbox.resolve(p);
    if (!r.ok) return err(r.reason);
    try {
      const entries = fs.readdirSync(r.path, { withFileTypes: true });
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return ok(lines.length > 0 ? lines.join("\n") : "(empty)");
    } catch (e) {
      return err(`list failed: ${(e as Error).message}`);
    }
  },
};

const glob: Tool = {
  name: "glob",
  kind: "read",
  mutates: false,
  def: {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern (e.g. 'src/**/*.ts') within the workspace.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  },
  async execute(args, ctx) {
    const pattern = reqStr(args, "pattern");
    if (pattern === undefined) return err("glob requires a string 'pattern'");
    try {
      const matches = fs.globSync(pattern, { cwd: ctx.sandbox.primary }).slice(0, MAX_GLOB);
      return ok(matches.length > 0 ? matches.join("\n") : "(no matches)");
    } catch (e) {
      return err(`glob failed: ${(e as Error).message}`);
    }
  },
};

const grep: Tool = {
  name: "grep",
  kind: "read",
  mutates: false,
  def: {
    type: "function",
    function: {
      name: "grep",
      description: "Search files for a regular expression within the workspace.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string", description: "Dir to search; default '.'" } },
        required: ["pattern"],
      },
    },
  },
  async execute(args, ctx) {
    const pattern = reqStr(args, "pattern");
    if (pattern === undefined) return err("grep requires a string 'pattern'");
    const searchPath = reqStr(args, "path") ?? ".";
    const r = ctx.sandbox.resolve(searchPath);
    if (!r.ok) return err(r.reason);
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return err(`invalid regex: ${(e as Error).message}`);
    }
    try {
      const files = fs.globSync("**/*", { cwd: r.path }).slice(0, MAX_GREP_FILES);
      const out: string[] = [];
      for (const rel of files) {
        if (out.length >= MAX_GREP_MATCHES) break;
        const abs = path.join(r.path, rel);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_GREP_FILE_BYTES) continue;
        const text = fs.readFileSync(abs, "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            out.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
            if (out.length >= MAX_GREP_MATCHES) break;
          }
        }
      }
      return ok(out.length > 0 ? out.join("\n") : "(no matches)");
    } catch (e) {
      return err(`grep failed: ${(e as Error).message}`);
    }
  },
};

export function fileTools(): Tool[] {
  return [readFile, writeFile, deleteFile, listDir, glob, grep];
}
