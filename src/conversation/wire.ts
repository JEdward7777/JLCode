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
