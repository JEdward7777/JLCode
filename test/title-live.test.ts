/**
 * The title ask survives a live provider (Tier 2 — cheap live smoke, D-84).
 *
 * D-84's defect was **not** visible offline in any test we had: the ephemeral
 * title ask (X-09, D-29) was built while the model's tool call was still
 * unanswered, and a window in that state is rejected by the *provider*, not by
 * anything in this repo. The catch swallowed the rejection and wrote no journal
 * line, so an agentic thread simply never got a name and nothing said why.
 *
 * So this test is deliberately shaped like the failure: a session with **real
 * tools**, a prompt that makes the model call one, and `autoTitle` on — the run
 * that used to produce a silently-rejected title ask on every single turn. It
 * runs against **OpenAI through OpenRouter**, the family that rejected it in
 * production (`openai/gpt-6-astra`), on the cheapest member of it.
 *
 * What it proves that an offline test cannot: a real backend **accepted** the
 * window the ask appends to. The offline regression test (the shape of the
 * window) lives in `ephemeral-cache-contract.test.ts`; this one is the receipt.
 *
 * Every call goes through the committed request-keyed cache (D-24): recorded
 * once with `JLCODE_LIVE=1` + a key, replayed free forever after.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { Session } from "../src/session/session";
import { ToolRegistry } from "../src/tools/registry";
import { fileTools } from "../src/tools/file-tools";
import { Sandbox } from "../src/tools/sandbox";
import { endsWithUnansweredToolCall } from "../src/conversation/wire";
import type { ModelConfig } from "../src/config/types";
import type { ChatRequest, LlmDriver } from "../src/llm/types";
import { liveDriver, LIVE, CACHE_DIR } from "./helpers/live";

const SMOKE_MODEL = process.env.JLCODE_SMOKE_MODEL ?? "openai/gpt-4o-mini";

function fixturesExist(): boolean {
  try {
    return fs.readdirSync(CACHE_DIR, { recursive: true } as { recursive: true }).some((f) => String(f).endsWith(".json"));
  } catch {
    return false;
  }
}

const RUN = LIVE || fixturesExist();
const SYS = "You are JLCode, a concise coding assistant. Keep replies short.";

/** Note the *relative* path: it appears in the tool call, the tool result and
 *  the next request, so an absolute one would key the fixture to one checkout
 *  (the same reason P8f pins the image fixture's path). */
const NOTE = "test/fixtures/title-live-note.txt";

function smokeConfig(): ModelConfig {
  return {
    id: "cfg_smoke",
    name: "Smoke — Test",
    openRouterKey: "unused-through-caching",
    model: SMOKE_MODEL,
    sampling: { maxTokens: 512 },
    defaultMode: "code",
    // Reads run, side effects are denied — the model can only do the one thing
    // this test asks of it, whatever else it decides to try.
    defaultApproval: "read-only",
    compaction: { auto: false, contextLength: 1_000_000 },
    // Same reason as the Fable fixtures: a per-turn wall clock (X-25) changes
    // the D-24 cache key on every run, and a recorded replay could never match.
    environment: { turnTimestamps: false },
    createdAt: "",
    updatedAt: "",
  };
}

/** Wrap the caching driver so the test can read what actually went on the wire. */
function recording(inner: LlmDriver): { driver: LlmDriver; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    driver: {
      async *streamChat(req, opts) {
        requests.push(req);
        yield* inner.streamChat(req, opts);
      },
    },
  };
}

describe.skipIf(!RUN)("the title ask survives a live provider (Tier 2, D-84)", () => {
  it("names a thread whose first turn called a tool", { timeout: 120_000 }, async () => {
    const { driver, requests } = recording(liveDriver());
    const session = new Session({
      config: smokeConfig(),
      driver,
      systemPrompt: SYS,
      tools: new ToolRegistry(fileTools()),
      sandbox: new Sandbox([process.cwd()]),
      autoTitle: true,
    });

    await session.send(`Use the read_file tool to read ${NOTE}, then tell me the release codename in one short sentence.`);

    // The premise: the model really did call a tool, so the title ask really was
    // built at the boundary D-84 is about. Without this the test could pass
    // vacuously on a model that just answered from the prompt.
    const calledATool = session.conversation.entries.some((e) => e.type === "tool");
    expect(calledATool).toBe(true);

    // The receipt: a live backend accepted every window we sent, the title ask
    // included — and it is in there, riding the live prefix rather than a
    // flattened copy of it.
    const asks = requests.filter((r) => String(r.messages[r.messages.length - 1]?.content).includes("Name this conversation"));
    expect(asks.length).toBe(1);
    for (const [i, req] of requests.entries()) {
      expect(`#${i}: ${endsWithUnansweredToolCall(req.messages) ? "dangling" : "sendable"}`).toBe(`#${i}: sendable`);
    }
    expect(session.status).toBe("idle");

    // …and the thread came back named. Weak on the words (the model picks them),
    // strict on the thing that was broken: there is a name at all.
    expect(session.conversation.title ?? "").not.toBe("");
    expect((session.conversation.title ?? "").length).toBeLessThanOrEqual(60);
  });
});
