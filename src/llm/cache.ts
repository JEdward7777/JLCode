/**
 * Request-keyed LLM cache (D-24): content-addressed, git-blob-style sharded
 * files (`<dir>/ab/<hash>.json`). The filename is the request-signature hash,
 * so lookup is an O(1) point read with no index. The signature includes only
 * the request fields that affect output, so it self-invalidates when we change
 * the request ("pay once, free until we change something"). Pure-JS (D-25).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AssistantResult, ChatRequest } from "./types.js";

/** Deterministic JSON with sorted object keys, so key order can't change the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/** The output-affecting fields of a request. */
export function requestSignature(req: ChatRequest): string {
  return stableStringify({
    model: req.model,
    messages: req.messages,
    tools: req.tools,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    reasoning: req.reasoning,
  });
}

export function hashRequest(req: ChatRequest): string {
  return createHash("sha256").update(requestSignature(req)).digest("hex");
}

export class LlmCache {
  constructor(private readonly dir: string) {}

  pathFor(hash: string): string {
    return path.join(this.dir, hash.slice(0, 2), `${hash}.json`);
  }

  get(req: ChatRequest): AssistantResult | undefined {
    const file = this.pathFor(hashRequest(req));
    try {
      return JSON.parse(readFileSync(file, "utf8")) as AssistantResult;
    } catch {
      return undefined;
    }
  }

  put(req: ChatRequest, result: AssistantResult): void {
    const file = this.pathFor(hashRequest(req));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(result));
  }
}
