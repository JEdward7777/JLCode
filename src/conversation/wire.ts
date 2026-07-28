/**
 * Assemble the wire messages sent to the model from the active branch (D-15).
 * Walks root→leaf; on a compaction (`replayCut`) entry it drops everything
 * above and injects the summary — the lossless-overlay behaviour. Assistant
 * `reasoning` (reasoning_details) is replayed verbatim (D-14).
 */
import type { ChatMessage } from "../llm/types.js";
import type { Conversation } from "./types.js";
import { pathToLeaf } from "./tree.js";

export interface WireOptions {
  system?: string;
  leafId?: string | null;
}

export function buildWireMessages(conv: Conversation, options: WireOptions = {}): ChatMessage[] {
  const system = options.system?.trim();
  const path = pathToLeaf(conv, options.leafId ?? conv.activeLeaf);
  const systemMsg: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  let messages: ChatMessage[] = [];

  for (const entry of path) {
    switch (entry.type) {
      case "compaction":
        // Reset: everything above is summarized away; keep only the summary.
        messages = [
          { role: "user", content: `[Summary of the earlier conversation]\n${entry.summary}` },
        ];
        break;
      case "user":
        messages.push({ role: "user", content: entry.text });
        break;
      case "assistant": {
        const msg: ChatMessage = { role: "assistant", content: entry.text === "" ? null : entry.text };
        if (entry.toolCalls && entry.toolCalls.length > 0) msg.tool_calls = entry.toolCalls;
        if (entry.reasoning !== undefined) msg.reasoning_details = entry.reasoning;
        messages.push(msg);
        break;
      }
      case "tool":
        messages.push({ role: "tool", tool_call_id: entry.toolCallId, name: entry.name, content: entry.content });
        break;
    }
  }
  return [...systemMsg, ...messages];
}

/**
 * The backend this conversation is pinned to (D-49/H-02), or undefined to let
 * OpenRouter route freely.
 *
 * Anthropic `thinking` blocks carry a signature only the provider that minted
 * it can verify, and we replay `reasoning_details` verbatim (D-14) — so once a
 * turn has been served, every later turn in the same replayed window must go
 * back to the same place or the provider rejects the history.
 *
 * Derived from the *replayed* window rather than stored as separate state: it
 * walks the same path and honors the same `replayCut` reset as the wire build
 * above. That gives two properties for free — old logs (no `provider` recorded)
 * simply don't pin, and compaction releases the pin, since the summary drops
 * `reasoning_details` and leaves no signature to protect.
 */
export function pinnedProvider(conv: Conversation, leafId?: string | null): string | undefined {
  const path = pathToLeaf(conv, leafId ?? conv.activeLeaf);
  let pin: string | undefined;
  for (const entry of path) {
    if (entry.type === "compaction") pin = undefined; // everything above is gone
    else if (entry.type === "assistant" && pin === undefined) pin = entry.provider;
  }
  return pin;
}
