/**
 * Thin OpenRouter client (D-21): we own the exact request/response JSON so the
 * opaque `reasoning_details` round-trips verbatim (D-14) and we can support
 * prompt-cache breakpoints (D-26). `fetch` is injectable so the streaming path
 * is testable offline (D-24). Nothing here interprets reasoning.
 */
import { streamSSE, chunkToEvents } from "./stream.js";
import { HttpError } from "./errors.js";
import { applyCacheBreakpoints } from "./cache-breakpoints.js";
import type { ChatRequest, LlmDriver, StreamEvent, StreamOptions } from "./types.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Optional OpenRouter attribution headers. */
  referer?: string;
  title?: string;
}

export class OpenRouterClient implements LlmDriver {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly referer: string | undefined;
  private readonly title: string | undefined;

  constructor(options: OpenRouterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.referer = options.referer;
    this.title = options.title;
  }

  async *streamChat(req: ChatRequest, opts?: StreamOptions): AsyncGenerator<StreamEvent, void, unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;

    // `usage.include` asks OpenRouter to report authoritative per-call `cost`
    // (cache-aware) so spend accounting doesn't have to price tokens itself (D-33).
    //
    // Breakpoints go on *this* copy only (D-26). `req.messages` stays untouched,
    // so the caller's transcript — and the D-24 request signature derived from it —
    // never sees a marker that can't change the model's output anyway.
    const body = JSON.stringify({
      ...req,
      messages: applyCacheBreakpoints(req.messages, req.model),
      stream: true,
      stream_options: { include_usage: true },
      usage: { include: true },
    });
    const res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body,
      signal: opts?.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new HttpError(res.status, `OpenRouter ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`, {
        retryAfter: res.headers.get("retry-after") ?? undefined,
      });
    }
    if (!res.body) throw new Error("OpenRouter response had no body");

    for await (const chunk of streamSSE(res.body as ReadableStream<Uint8Array>)) {
      yield* chunkToEvents(chunk);
    }
  }
}
