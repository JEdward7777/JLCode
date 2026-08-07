/**
 * The conversation as an append-only parent-pointer tree (D-15, D-17). Entries
 * only ever append; each carries a stable id and a `parent`. A branch is the
 * chain traced from a leaf upward; `activeLeaf` is the tip currently in view.
 * On disk this is a JSONL log folded into this shape (D-37) — later phase.
 */
import type { ToolCall, Usage } from "../llm/types.js";

export interface BaseEntry {
  id: string;
  parent: string | null;
  ts: string;
}

export interface UserEntry extends BaseEntry {
  type: "user";
  text: string;
}

export interface AssistantEntry extends BaseEntry {
  type: "assistant";
  text: string;
  toolCalls?: ToolCall[];
  /** Opaque reasoning_details, replayed verbatim (D-14). */
  reasoning?: unknown;
  /** Human-readable reasoning for the UI — never replayed. */
  reasoningText?: string;
  /** Which OpenRouter backend served this turn. Reasoning signatures are only
   *  verifiable by the provider that minted them, so later turns pin to the
   *  first one recorded in the replayed window (D-49/H-02). Absent on entries
   *  written before this was captured — those simply don't pin. */
  provider?: string;
  finishReason?: string;
  /** finish_reason === "length": the turn was cut off (D-30). */
  truncated?: boolean;
  usage?: Usage;
}

export interface ToolEntry extends BaseEntry {
  type: "tool";
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  /** Ancestors above this are linked but not replayed (D-15). */
  replayCut: true;
}

export type Entry = UserEntry | AssistantEntry | ToolEntry | CompactionEntry;

export interface Conversation {
  id: string;
  /** Human label for the thread (X-09) — auto-titled after the first exchange,
   *  renameable by hand. Absent until then, and on logs written before titles. */
  title?: string;
  /** Where `title` came from (X-17). `manual` **pins** the name: auto-titling
   *  never overwrites a name a person chose, and this is what carries that
   *  across a resume — the source is recorded per title record in the log, so a
   *  hand-rename survives a restart as a hand-rename. Absent on logs written
   *  before the source was folded back, which read as `auto`. */
  titleSource?: "auto" | "manual";
  entries: Entry[];
  activeLeaf: string | null;
  createdAt: string;
  updatedAt: string;
}
