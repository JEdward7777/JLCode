import { describe, it, expect } from "vitest";
import { Session } from "../src/session/session";
import { SessionManager } from "../src/session/manager";
import { scriptedDriver, throwingDriver } from "../src/session/fake";
import type { SessionEvent } from "../src/session/types";
import type { ModelConfig } from "../src/config/types";
import type { AssistantEntry } from "../src/conversation/types";
import type { ChatRequest } from "../src/llm/types";

const config: ModelConfig = {
  id: "cfg_x",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

function collector() {
  const events: SessionEvent[] = [];
  return { events, listen: (s: Session) => s.onEvent((e) => events.push(e)) };
}

describe("Session", () => {
  it("streams a reply and appends user + assistant entries", async () => {
    const driver = scriptedDriver([
      { type: "text", delta: "Hello" },
      { type: "finish", reason: "stop" },
    ]);
    const session = new Session({ config, driver });
    const { events, listen } = collector();
    listen(session);

    await session.send("hi");

    const kinds = session.conversation.entries.map((e) => e.type);
    expect(kinds).toEqual(["user", "assistant"]);
    const assistant = session.conversation.entries[1] as AssistantEntry;
    expect(assistant.text).toBe("Hello");
    expect(session.status).toBe("idle");
    expect(events.map((e) => e.type)).toContain("assistant-end");
    expect(events).toContainEqual({ type: "text", delta: "Hello" });
  });

  it("stores reasoning_details verbatim on the assistant entry (D-14)", async () => {
    const driver = scriptedDriver([
      { type: "reasoning", delta: "thinking" },
      { type: "reasoning_details", value: { type: "encrypted", signature: "sig" } },
      { type: "text", delta: "done" },
      { type: "finish", reason: "stop" },
    ]);
    const session = new Session({ config, driver });
    await session.send("go");
    const assistant = session.conversation.entries[1] as AssistantEntry;
    expect(assistant.reasoning).toEqual([{ type: "encrypted", signature: "sig" }]);
    expect(assistant.reasoningText).toBe("thinking");
  });

  it("detects truncation (finish_reason=length) without silence (D-30)", async () => {
    const driver = scriptedDriver([
      { type: "text", delta: "partial" },
      { type: "finish", reason: "length" },
    ]);
    const session = new Session({ config, driver });
    const { events, listen } = collector();
    listen(session);
    await session.send("write a lot");
    const assistant = session.conversation.entries[1] as AssistantEntry;
    expect(assistant.truncated).toBe(true);
    expect(events.some((e) => e.type === "truncation")).toBe(true);
  });

  it("halts after N consecutive failures (D-32)", async () => {
    const session = new Session({ config, driver: throwingDriver("boom"), maxConsecutiveFailures: 2 });
    const { events, listen } = collector();
    listen(session);

    await session.send("a"); // failure 1
    expect(session.status).toBe("idle");
    await session.send("b"); // failure 2 → halt
    expect(session.status).toBe("halted");
    expect(events.filter((e) => e.type === "error")).toHaveLength(2);
    expect(events.some((e) => e.type === "halted")).toBe(true);
    await expect(session.send("c")).rejects.toThrow(/halted/);
  });
});

describe("SessionManager", () => {
  it("creates, gets, lists, and removes sessions", () => {
    const mgr = new SessionManager();
    const s = mgr.create({ config, driver: scriptedDriver([]) });
    expect(mgr.size).toBe(1);
    expect(mgr.get(s.id)).toBe(s);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.remove(s.id)).toBe(true);
    expect(mgr.size).toBe(0);
  });
});

/**
 * End-to-end provider pinning (D-49/H-02): the backend that served turn 1 is
 * recorded on its entry, and every later request pins to it with fallbacks off.
 * Without this, OpenRouter re-routes freely and the replayed reasoning
 * signatures are rejected by a backend that never minted them.
 */
describe("Session provider pinning", () => {
  it("records the serving provider on the assistant entry", async () => {
    const driver = scriptedDriver([
      { type: "provider", name: "Anthropic" },
      { type: "text", delta: "hi" },
      { type: "finish", reason: "stop" },
    ]);
    const session = new Session({ config, driver });
    await session.send("q");
    const entry = session.conversation.entries.find((e) => e.type === "assistant") as AssistantEntry;
    expect(entry.provider).toBe("Anthropic");
  });

  it("sends no provider pin on the first call, then pins every later one", async () => {
    const seen: (ChatRequest["provider"] | undefined)[] = [];
    const driver = scriptedDriver((req) => {
      seen.push(req.provider);
      return [
        { type: "provider", name: "Anthropic" },
        { type: "text", delta: "ok" },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new Session({ config, driver });
    await session.send("q1");
    await session.send("q2");
    await session.send("q3");

    // Nothing to protect before the first response, so routing stays free.
    expect(seen[0]).toBeUndefined();
    // Afterwards the pin is binding — a silent failover would 400 on the
    // signatures anyway, so we'd rather hear "provider unavailable".
    expect(seen[1]).toEqual({ order: ["Anthropic"], allow_fallbacks: false });
    expect(seen[2]).toEqual({ order: ["Anthropic"], allow_fallbacks: false });
  });

  it("keeps pinning to the original backend even if a later turn reports another", async () => {
    const seen: (ChatRequest["provider"] | undefined)[] = [];
    let call = 0;
    const driver = scriptedDriver((req) => {
      seen.push(req.provider);
      call += 1;
      return [
        { type: "provider", name: call === 1 ? "Anthropic" : "Amazon Bedrock" },
        { type: "text", delta: "ok" },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new Session({ config, driver });
    await session.send("q1");
    await session.send("q2");
    await session.send("q3");
    expect(seen[2]).toEqual({ order: ["Anthropic"], allow_fallbacks: false });
  });

  it("does not pin when the provider is never reported", async () => {
    const seen: (ChatRequest["provider"] | undefined)[] = [];
    const driver = scriptedDriver((req) => {
      seen.push(req.provider);
      return [
        { type: "text", delta: "ok" },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new Session({ config, driver });
    await session.send("q1");
    await session.send("q2");
    expect(seen[1]).toBeUndefined();
  });
});
