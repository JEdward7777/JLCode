/**
 * SSE parsing for OpenAI-style streaming responses, and accumulation of the
 * event stream into a final AssistantResult. Tool-call arguments are retained
 * as they stream (D-31 groundwork); reasoning_details is kept opaque (D-14).
 */
import type { AssistantResult, StreamEvent, ToolCall, Usage } from "./types.js";

/** Yield each parsed `data:` JSON object from an SSE byte stream. */
export async function* streamSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === "" || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          // ignore an unparsable/partial chunk
        }
      }
    }
  }
}

function mapUsage(u: any): Usage {
  const usage: Usage = {
    promptTokens: u?.prompt_tokens,
    completionTokens: u?.completion_tokens,
    totalTokens: u?.total_tokens,
    cachedTokens: u?.prompt_tokens_details?.cached_tokens,
  };
  // OpenRouter reports authoritative spend in `cost` when asked (D-33).
  if (typeof u?.cost === "number") usage.costUsd = u.cost;
  return usage;
}

/** Translate one OpenAI streaming chunk into zero or more normalized events. */
export function chunkToEvents(chunk: any): StreamEvent[] {
  const events: StreamEvent[] = [];
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta ?? {};
  if (typeof delta.content === "string" && delta.content.length > 0) {
    events.push({ type: "text", delta: delta.content });
  }
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
    events.push({ type: "reasoning", delta: delta.reasoning });
  }
  if (delta.reasoning_details !== undefined && delta.reasoning_details !== null) {
    events.push({ type: "reasoning_details", value: delta.reasoning_details });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      events.push({
        type: "tool_call",
        index: typeof tc.index === "number" ? tc.index : 0,
        id: tc.id,
        name: tc.function?.name,
        argsDelta: tc.function?.arguments,
      });
    }
  }
  if (choice?.finish_reason) events.push({ type: "finish", reason: choice.finish_reason });
  // OpenRouter names the backend it routed to on every chunk; we keep the first
  // one so the conversation can pin to it later (D-49/H-02).
  if (typeof chunk?.provider === "string" && chunk.provider.length > 0) {
    events.push({ type: "provider", name: chunk.provider });
  }
  if (chunk?.usage) events.push({ type: "usage", usage: mapUsage(chunk.usage) });
  return events;
}

/**
 * Streaming `reasoning_details` arrive as **deltas that must be merged by
 * `index`** (H-04): the text accumulates across several fragments and the
 * `signature` lands in a final one that carries no text. Appending them instead
 * stores N partial thinking blocks plus an orphan signature — which the provider
 * then rejects with `Invalid signature in thinking block`, because the signature
 * covers content that was never reassembled.
 *
 * This is still "verbatim and opaque" (D-14): reassembling a stream the way the
 * protocol defines is not interpreting it. We never look at what reasoning says
 * — only at the envelope fields that say how to put it back together.
 */
const REASONING_CONTENT_FIELDS = new Set(["text", "data", "summary"]);

class ReasoningAssembler {
  private readonly byKey = new Map<string, unknown>();
  private seq = 0;

  add(item: unknown): void {
    // Anything that isn't a keyed object stays exactly as it came (opaque).
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      this.byKey.set(`#${this.seq++}`, item);
      return;
    }
    const rec = item as Record<string, unknown>;
    // No `index` means the provider isn't streaming fragments — keep the old
    // one-entry-per-item behaviour rather than guessing they belong together.
    const key = typeof rec.index === "number" ? `i${rec.index}` : `#${this.seq++}`;
    const cur = this.byKey.get(key);
    if (cur === undefined || typeof cur !== "object" || cur === null) {
      this.byKey.set(key, { ...rec });
      return;
    }
    const target = cur as Record<string, unknown>;
    for (const [field, value] of Object.entries(rec)) {
      if (value === undefined) continue;
      // Content fields concatenate; envelope fields (type/format/signature/id)
      // take the latest non-empty value.
      if (REASONING_CONTENT_FIELDS.has(field) && typeof value === "string" && typeof target[field] === "string") {
        target[field] = (target[field] as string) + value;
      } else {
        target[field] = value;
      }
    }
  }

  /** Assembled blocks, in the order their indices were first seen. */
  result(): unknown[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }
}

/** Fold a normalized event stream into the final assistant result. */
export function accumulate(events: Iterable<StreamEvent>): AssistantResult {
  let text = "";
  let reasoningText = "";
  const reasoning = new ReasoningAssembler();
  const toolByIndex = new Map<number, { id?: string; name?: string; args: string }>();
  let finishReason = "stop";
  let provider: string | undefined;
  let usage: Usage | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case "text":
        text += ev.delta;
        break;
      case "reasoning":
        reasoningText += ev.delta;
        break;
      case "reasoning_details":
        // Merge fragments by index rather than appending them (H-04).
        if (Array.isArray(ev.value)) for (const item of ev.value) reasoning.add(item);
        else reasoning.add(ev.value);
        break;
      case "tool_call": {
        const cur = toolByIndex.get(ev.index) ?? { args: "" };
        if (ev.id) cur.id = ev.id;
        if (ev.name) cur.name = ev.name;
        if (ev.argsDelta) cur.args += ev.argsDelta;
        toolByIndex.set(ev.index, cur);
        break;
      }
      case "finish":
        finishReason = ev.reason;
        break;
      case "provider":
        provider ??= ev.name; // first chunk wins; it can't change mid-response
        break;
      case "usage":
        usage = ev.usage;
        break;
    }
  }

  const toolCalls: ToolCall[] = [...toolByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id: t.id ?? "",
      type: "function" as const,
      function: { name: t.name ?? "", arguments: t.args },
    }));

  const result: AssistantResult = { text, toolCalls, finishReason };
  if (reasoningText) result.reasoningText = reasoningText;
  if (reasoning.size > 0) result.reasoning = reasoning.result();
  if (provider) result.provider = provider;
  if (usage) result.usage = usage;
  return result;
}
