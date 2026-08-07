/**
 * P6c — trigger-mode UX (the five modes) + the cross-model summary path
 * (D-27/D-29 refined). Tier-0/1: pure summary-input shaping plus the Session
 * state machine (live trigger mode, the pre-send awaiting-compaction pause,
 * manual compact, and the cross-model request shape) — offline scripted driver,
 * no live spend.
 */
import { describe, it, expect } from "vitest";
import { buildCrossModelSummaryInput, SUMMARY_TOOL_OUTPUT_CAP_CHARS } from "../src/session/compaction";
import { buildWireMessages, stripEnvironmentDetails } from "../src/conversation/wire";
import type { Conversation } from "../src/conversation/types";
import { Session } from "../src/session/session";
import type { ModelConfig, CompactionSettings } from "../src/config/types";
import type { ChatRequest, LlmDriver, StreamEvent, Usage } from "../src/llm/types";
import type { SessionEvent } from "../src/session/types";

const SYS = "SYS";

const baseConfig: ModelConfig = {
  id: "cfg",
  name: "Test",
  openRouterKey: "sk",
  model: "work-model",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

function configWith(compaction?: Partial<CompactionSettings>): ModelConfig {
  return { ...baseConfig, compaction: compaction ? { auto: false, ...compaction } : undefined };
}

/** A turn that streams reasoning (text + opaque details), some text, usage. */
function reasoningTurn(reasoning: string, text: string, usage: Usage): StreamEvent[] {
  return [
    { type: "reasoning", delta: reasoning },
    { type: "reasoning_details", value: [{ type: "reasoning.encrypted", data: "SIGNED-OPAQUE" }] },
    { type: "text", delta: text },
    { type: "finish", reason: "stop" },
    { type: "usage", usage },
  ];
}

function turn(text: string, usage: Usage): StreamEvent[] {
  return [{ type: "text", delta: text }, { type: "finish", reason: "stop" }, { type: "usage", usage }];
}

function summary(text: string, usage: Usage = { promptTokens: 500, completionTokens: 40 }): StreamEvent[] {
  return [{ type: "text", delta: text }, { type: "finish", reason: "stop" }, { type: "usage", usage }];
}

function sequenceDriver(steps: Array<StreamEvent[] | { throw: string }>) {
  const requests: ChatRequest[] = [];
  let i = 0;
  const driver: LlmDriver = {
    // eslint-disable-next-line require-yield
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      requests.push(req);
      const step = steps[i++];
      if (!step) throw new Error(`sequenceDriver: no step #${i - 1} (script exhausted)`);
      if ("throw" in step) throw new Error(step.throw);
      for (const ev of step) yield ev;
    },
  };
  return { driver, requests };
}

describe("cross-model summary input (D-29 refined — keep planning, drop signed reasoning)", () => {
  it("folds readable reasoning into content, drops reasoning_details, labels tool output", async () => {
    const { driver } = sequenceDriver([
      reasoningTurn("plan: read the file then edit it", "I'll start now.", { promptTokens: 40, completionTokens: 12 }),
    ]);
    const session = new Session({ config: configWith(), driver, systemPrompt: SYS, contextWindow: 200_000 });
    await session.send("original request");

    const input = buildCrossModelSummaryInput(session.conversation, { system: SYS });
    // system + user + assistant (no tool cycle here)
    expect(input[0]).toEqual({ role: "system", content: SYS });
    expect(input[1]!.role).toBe("user");
    // Stamped like the live wire (X-25) — the summarizer reads the same dated
    // transcript the working model does; the user's words are unchanged under it.
    expect(stripEnvironmentDetails(input[1]!.content as string)).toBe("original request");
    const asst = input[2]!;
    expect(asst.role).toBe("assistant");
    expect(String(asst.content)).toContain("[reasoning] plan: read the file then edit it");
    expect(String(asst.content)).toContain("I'll start now.");
    // The opaque signed reasoning never crosses to the other model.
    expect(asst.reasoning_details).toBeUndefined();
    expect(JSON.stringify(input)).not.toContain("SIGNED-OPAQUE");
  });

  it("truncates oversized tool output but keeps the tail + marker", () => {
    // Hand-built conversation with a giant tool result on the active branch.
    const long = "y".repeat(SUMMARY_TOOL_OUTPUT_CAP_CHARS + 500);
    const conv = {
      id: "c",
      entries: [
        { id: "u1", parent: null, type: "user" as const, text: "go" },
        {
          id: "a1",
          parent: "u1",
          type: "assistant" as const,
          text: "",
          toolCalls: [{ id: "tc1", type: "function" as const, function: { name: "run", arguments: "{}" } }],
        },
        { id: "t1", parent: "a1", type: "tool" as const, toolCallId: "tc1", name: "run", content: long },
      ],
      activeLeaf: "t1",
    };
    const input = buildCrossModelSummaryInput(conv, { system: SYS });
    const toolMsg = input.find((m) => typeof m.content === "string" && m.content.includes("truncated for summary"));
    expect(toolMsg).toBeTruthy();
    expect((toolMsg!.content as string).length).toBeLessThan(long.length);
    expect(toolMsg!.content as string).toContain("y".repeat(100)); // tail kept
  });
});

describe("redacted vs readable thinking (D-14/D-28/D-29)", () => {
  // The SDK splits reasoning into readable text (`reasoningText`) and the opaque
  // signed/encrypted blob (`reasoning`). "Redacted thinking" is the case with an
  // encrypted blob and NO readable text. The cross-model builder keys off that
  // split, so "only redact the redacted thinking" holds by construction: readable
  // planning survives, the opaque blob (signed OR encrypted) never crosses models.
  const redactedConv: Conversation = {
    id: "c",
    entries: [
      { id: "u1", parent: null, type: "user", text: "do the risky thing" },
      {
        id: "a1",
        parent: "u1",
        type: "assistant",
        text: "I can't help with that.",
        // Encrypted/redacted thinking: opaque data, no readable text.
        reasoning: [{ type: "reasoning.encrypted", data: "REDACTED-OPAQUE-BLOB" }],
        // reasoningText intentionally absent — nothing readable was returned.
      },
    ],
    activeLeaf: "a1",
  };

  it("cross-model: a redacted turn keeps no thinking and never leaks the opaque blob", () => {
    const input = buildCrossModelSummaryInput(redactedConv, { system: SYS });
    const asst = input.find((m) => m.role === "assistant")!;
    expect(asst.content).toBe("I can't help with that."); // answer text only, no [reasoning]
    expect(String(asst.content)).not.toContain("[reasoning]");
    expect(JSON.stringify(input)).not.toContain("REDACTED-OPAQUE-BLOB");
  });

  it("same-model wire round-trips an encrypted reasoning array byte-identical (D-14)", () => {
    const a1 = redactedConv.entries[1] as { reasoning: unknown };
    const wire = buildWireMessages(redactedConv, { system: SYS });
    const asst = wire.find((m) => m.role === "assistant")!;
    // Opaque passthrough: the encrypted blob replays by the same reference (===),
    // so a same-model replay is Fable-safe for the redacted variety exactly as for
    // the signed one — no editing, no reconstruction.
    expect(asst.reasoning_details).toBe(a1.reasoning);
    expect(asst.reasoning_details).toEqual([{ type: "reasoning.encrypted", data: "REDACTED-OPAQUE-BLOB" }]);
  });
});

describe("Session.compact() — cross-model path (D-29)", () => {
  it("sends flattened structured messages to the compactor id, no signed reasoning", async () => {
    const { driver, requests } = sequenceDriver([
      reasoningTurn("thinking hard", "answer one", { promptTokens: 50, completionTokens: 10 }),
      summary("## Goal\nDo the thing.\n"),
    ]);
    const session = new Session({
      config: configWith({ model: "cheap-compactor" }),
      driver,
      systemPrompt: SYS,
      contextWindow: 200_000,
    });
    await session.send("original request");
    const ok = await session.compact();
    expect(ok).toBe(true);

    const req = requests[1]!;
    expect(req.model).toBe("cheap-compactor"); // routed to the cheaper compactor
    expect(req.tool_choice).toBe("none");
    // No signed reasoning crosses models; the planning survives as readable text.
    expect(JSON.stringify(req.messages)).not.toContain("SIGNED-OPAQUE");
    expect(req.messages.some((m) => String(m.content).includes("[reasoning] thinking hard"))).toBe(true);
    // The overlay landed and the wire resets to system + summary.
    expect(session.conversation.entries.some((e) => e.type === "compaction")).toBe(true);
  });
});

describe("trigger-mode live state (D-27)", () => {
  it("resolves from config and emits on switch", () => {
    const { driver } = sequenceDriver([]);
    const session = new Session({ config: configWith({ triggerModes: ["suggest"] }), driver, systemPrompt: SYS });
    expect(session.triggerMode).toBe("suggest");
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    session.setTriggerMode("hard");
    expect(session.triggerMode).toBe("hard");
    expect(events).toContainEqual({ type: "trigger-mode", mode: "hard" });
  });
});

describe("pre-send compaction pause (D-27 cancelable / hard)", () => {
  it("cancelable pauses awaiting-compaction, then Compact folds and continues", async () => {
    const { driver, requests } = sequenceDriver([
      turn("first", { promptTokens: 950, completionTokens: 100 }), // prefix 1050 > threshold 900
      summary("## Goal\nsummary.\n"), // the compaction on resolve
      turn("second", { promptTokens: 20, completionTokens: 5 }), // held turn after compaction
    ]);
    const session = new Session({
      config: configWith({ triggerModes: ["cancelable"], bufferTokens: 100 }),
      driver,
      systemPrompt: SYS,
      contextWindow: 1_000,
    });
    const events: SessionEvent[] = [];
    session.onEvent((e) => events.push(e));

    await session.send("one");
    expect(session.needsCompaction).toBe(true);

    await session.send("two"); // crosses into the pause instead of sending
    expect(session.status).toBe("awaiting-compaction");
    const pause = events.find((e) => e.type === "awaiting-compaction");
    expect(pause).toMatchObject({ request: { cancelable: true, mode: "cancelable" } });
    expect(session.awaitingCompaction).toBeTruthy();

    await session.resolveCompaction(false); // Compact
    expect(session.conversation.entries.filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(session.conversation.entries.some((e) => e.type === "assistant" && e.text === "second")).toBe(true);
    // The held turn replayed only system + summary (safe-harbor reset).
    expect(requests[2]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(session.status).toBe("idle");
  });

  it("cancelable Skip proceeds uncompacted (accepts the one-turn overshoot)", async () => {
    const { driver } = sequenceDriver([
      turn("first", { promptTokens: 950, completionTokens: 100 }),
      turn("second", { promptTokens: 950, completionTokens: 100 }), // sent WITHOUT compaction
    ]);
    const session = new Session({
      config: configWith({ triggerModes: ["cancelable"], bufferTokens: 100 }),
      driver,
      systemPrompt: SYS,
      contextWindow: 1_000,
    });
    await session.send("one");
    await session.send("two");
    expect(session.status).toBe("awaiting-compaction");
    await session.resolveCompaction(true); // Skip
    expect(session.conversation.entries.some((e) => e.type === "compaction")).toBe(false);
    expect(session.conversation.entries.some((e) => e.type === "assistant" && e.text === "second")).toBe(true);
    expect(session.status).toBe("idle");
  });

  it("hard ignores Skip — it always compacts", async () => {
    const { driver } = sequenceDriver([
      turn("first", { promptTokens: 950, completionTokens: 100 }),
      summary("## Goal\nforced by hard mode.\n"),
      turn("second", { promptTokens: 20, completionTokens: 5 }),
    ]);
    const session = new Session({
      config: configWith({ triggerModes: ["hard"], bufferTokens: 100 }),
      driver,
      systemPrompt: SYS,
      contextWindow: 1_000,
    });
    await session.send("one");
    await session.send("two");
    expect(session.status).toBe("awaiting-compaction");
    expect(session.awaitingCompaction).toMatchObject({ cancelable: false, mode: "hard" });
    await session.resolveCompaction(true); // Skip requested, but hard compacts anyway
    expect(session.conversation.entries.filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(session.status).toBe("idle");
  });

  it("suggest / manual never pause the loop", async () => {
    const { driver } = sequenceDriver([
      turn("first", { promptTokens: 950, completionTokens: 100 }),
      turn("second", { promptTokens: 950, completionTokens: 100 }),
    ]);
    const session = new Session({
      config: configWith({ triggerModes: ["suggest"], bufferTokens: 100 }),
      driver,
      systemPrompt: SYS,
      contextWindow: 1_000,
    });
    await session.send("one");
    await session.send("two");
    expect(session.status).toBe("idle");
    expect(session.conversation.entries.some((e) => e.type === "compaction")).toBe(false);
  });
});

describe("manual compact-now (D-27)", () => {
  it("compacts an idle session on demand", async () => {
    const { driver } = sequenceDriver([
      turn("first", { promptTokens: 50, completionTokens: 10 }),
      summary("## Goal\non demand.\n"),
    ]);
    const session = new Session({
      config: configWith({ triggerModes: ["manual"] }),
      driver,
      systemPrompt: SYS,
      contextWindow: 200_000,
    });
    await session.send("one");
    const ok = await session.compactNow();
    expect(ok).toBe(true);
    expect(session.conversation.entries.some((e) => e.type === "compaction")).toBe(true);
  });
});
