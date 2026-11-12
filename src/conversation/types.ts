/**
 * The conversation as an append-only parent-pointer tree (D-15, D-17). Entries
 * only ever append; each carries a stable id and a `parent`. A branch is the
 * chain traced from a leaf upward; `activeLeaf` is the tip currently in view.
 * On disk this is a JSONL log folded into this shape (D-37) — later phase.
 */
import type { ToolCall, Usage } from "../llm/types.js";
import type { TodoOp } from "./todos.js";

export interface BaseEntry {
  id: string;
  parent: string | null;
  ts: string;
}

/**
 * A message one agent sent another (X-56 Q5/Q6, D-88), or the notice that a
 * sub-agent went idle. It lands as an ordinary user-side entry — the receiver
 * reads it like anything else said to it — and this records **who** said it, so
 * the transcript can draw it as agent traffic rather than as the human (P9e) and
 * the log can tell an answered message from one still owed (P9f).
 *
 * `text` on the entry already carries the attribution line the model reads
 * (`[Message from your parent agent "root"]` …): rendering it once, when the
 * message is sent, keeps the wire a pure function of stored text and the cached
 * prefix byte-identical on every replay.
 */
export interface InboundMeta {
  /** The inbox id the message was recorded under when it was **sent** — before
   *  it reached the receiver's transcript — so a crash between the two leaves a
   *  pending message on disk rather than nothing. */
  id: string;
  /** The sender's agent name (`root`, `agent-2`). */
  from: string;
  /** `task`: the spawn's opening message; `message`: `send_message`;
   *  `finished`: the completion notice a parent gets when a child goes idle;
   *  `question`: a child's `ask(to: "parent")`, which its parent answers by
   *  replying with `send_message` (P9d, X-56 Q16); `mode`: the note that its
   *  parent agent changed its mode (`set_agent_mode`, P9f2) — never recorded in
   *  the inbox, since it is owed no reply. */
  kind: "task" | "message" | "finished" | "question" | "mode";
}

export interface UserEntry extends BaseEntry {
  type: "user";
  text: string;
  /** Present when another agent — not the human — sent this (D-88). */
  inbound?: InboundMeta;
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

/**
 * Bytes a tool produced that are not text — today an image a vision model can
 * look at (P8b, D-78a). It rides on the *entry* rather than only on the live
 * `ToolResult` because the wire is rebuilt from the tree on every turn, resume,
 * fork and rewind: an attachment the transcript did not keep would vanish from
 * the replayed window the moment the process restarted, and the model would
 * answer about a picture it can no longer see.
 *
 * `data` is base64 of the raw bytes, inline. **P8c moves it to a
 * content-addressed sidecar** (`{sha, mime, bytes}`, D-78d) — `ConversationStore.load()`
 * reads and parses the whole log on every resume, so an inline blob is a cost
 * D-37's append-only rule never lets you take back. Until then, `read_file`'s
 * size cap is what keeps the exposure bounded.
 */
export interface Attachment {
  /** One of `media.ts`'s `IMAGE_MIMES` — what the `data:` URI declares. */
  mime: string;
  /** Base64 of the raw bytes, without the `data:` prefix. */
  data: string;
  /** Where it came from, as the user asked for it — the label the wire's text
   *  part and the browser both show. */
  name?: string;
}

/**
 * A file the agent asked JLCode to make viewable (X-43, D-83) — a **pointer**,
 * never the bytes. `file_url` mints one per path; the browser fetches it back
 * through `/conversation/:id/file/:token/:index`, which re-resolves it at fetch
 * time. That is the deliberate difference from `Attachment`: an attachment is a
 * snapshot the model *looked at*, and this is a live pointer to something the
 * model never read.
 */
export interface SharedFile {
  /** Token addressing the whole `file_url` call this file belongs to. */
  token: string;
  /** The path as the agent asked for it — the label, and what a 404 names. */
  path: string;
  /** Resolved absolute path at mint time. */
  resolved: string;
  /** The fence this was validated against, re-checked on every fetch: a URL
   *  minted in one session must not outlive the workspace that authorized it. */
  fenceRoot: string;
  /** What the *bytes* said it was (D-78b), not what the extension claimed. */
  mime: string;
  bytes: number;
  /** Content hash at mint time. Recorded because it is nearly free and settles
   *  "is this still what was shown?" later; nothing refuses on a mismatch today
   *  (Joshua's call — a changed or missing file just 404s). */
  sha256: string;
}

export interface ToolEntry extends BaseEntry {
  type: "tool";
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
  /** Non-text output (P8b). The tool message itself stays text — the wire
   *  forbids anything else (D-78a) — and `buildWireMessages` flushes these into
   *  a following `user` message. Absent on every entry ever written before this,
   *  which is exactly the old shape, so no migration. */
  attachments?: Attachment[];
  /** Files made viewable in the browser without their bytes going to the
   *  model (X-43). Absent on every entry written before this. */
  files?: SharedFile[];
}

export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  /** Ancestors above this are linked but not replayed (D-15). */
  replayCut: true;
}

/**
 * A change to the shared todo list (X-31). It rides in the tree rather than
 * beside it so the list folds per *branch* — rewind, fork and resume then need
 * no bookkeeping of their own. It carries no wire message: the model learns what
 * changed from the tool result it just got, or by reading, so `buildWireMessages`
 * has no case for it and replays nothing.
 */
export interface TodoEntry extends BaseEntry {
  type: "todo";
  ops: TodoOp[];
  /** Who wrote it. The person's edits are the ones the agent has to be told about. */
  by: "agent" | "user";
}

/**
 * The thread's model changed here (X-56, D-87). The nearest switch above the
 * leaf governs which config the branch runs under; a branch with none follows
 * the folder binding exactly as before (D-82a). It names the config by **id**,
 * resolved live on every request so later edits to that config reach the
 * thread; the snapshot is only for the transcript marker, and is never used to
 * substitute for a config that has since been deleted.
 *
 * On the wire it carries no message of its own, but it is a boundary: the
 * assistant `reasoning_details` above it are dropped and the provider pin is
 * released (D-49), exactly as across a compaction — model B must never be
 * handed model A's signed thinking.
 */
export interface ModelSwitchEntry extends BaseEntry {
  type: "model-switch";
  configId: string;
  snapshot: { name: string; model: string };
}

export type Entry = UserEntry | AssistantEntry | ToolEntry | CompactionEntry | TodoEntry | ModelSwitchEntry;

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
  /** Agent messages recorded as sent to this conversation but never delivered
   *  into it (D-88) — what a crash or a restart left in flight. Folded from the
   *  log on load; a resumed session holds them in its queue, so they land with
   *  the next turn rather than vanishing. Absent on fresh conversations. */
  inbox?: (InboundMeta & { text: string })[];
  /** "Continue, don't ask again in this thread" was chosen here (P9d, X-56 Q8,
   *  D-89): the tool-round pause no longer fires in this thread or anywhere in
   *  its sub-agent subtree. Folded from a `rounds-off` record in the log, so it
   *  survives a restart. Absent = the pause is on. */
  roundsOff?: boolean;
}
