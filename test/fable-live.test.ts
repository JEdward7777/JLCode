/**
 * The named Fable-safety must-pass tests (TESTING.md, D-14/D-28/D-38), Tier 3 —
 * aimed straight at the Fable × compaction boundary (O-02, resolved by the
 * safe-harbor design). Two properties:
 *
 *  (a) **Normal replay round-trips `reasoning_details` verbatim** (D-14): Fable
 *      returns signed reasoning on turn 1; turn 2 replays that assistant turn
 *      byte-for-byte (the wire builder sets `reasoning_details` from the stored
 *      entry) and Fable **accepts** it — an edited/orphaned signature would be
 *      rejected as tampered.
 *  (b) **A safe-harbor compaction produces a Fable-accepted request** (D-28/D-38):
 *      after `compact()` folds the branch into `system + summary`, the next turn's
 *      request is accepted by Fable (no signed thinking crosses the cut) and the
 *      continuation is coherent — the summary preserved the concrete facts (judged
 *      by an LLM-as-judge, TESTING.md).
 *
 * Every model call goes through the committed request-keyed cache (D-24): recorded
 * once with `JLCODE_LIVE=1` + a key, then replayed free (CI included). The suite
 * runs whenever fixtures exist or live is enabled; it skips only in a keyless
 * environment with no fixtures yet.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { Session } from "../src/session/session";
import type { ModelConfig } from "../src/config/types";
import type { Entry } from "../src/conversation/types";
import { liveDriver, FABLE_MODEL, LIVE, CACHE_DIR } from "./helpers/live";
import { judge } from "./helpers/judge";

/** Any recorded fixtures present → the suite can replay for free. */
function fixturesExist(): boolean {
  try {
    return fs
      .readdirSync(CACHE_DIR, { recursive: true } as { recursive: true })
      .some((f) => String(f).endsWith(".json"));
  } catch {
    return false;
  }
}

const RUN = LIVE || fixturesExist();
const SYS = "You are JLCode, a concise coding assistant. Keep replies short.";

function fableConfig(): ModelConfig {
  return {
    id: "cfg_fable",
    name: "Fable — Test",
    openRouterKey: "unused-through-caching",
    model: FABLE_MODEL,
    reasoningEffort: "medium",
    sampling: { maxTokens: 512 },
    defaultMode: "code",
    defaultApproval: "manual",
    compaction: { auto: false, contextLength: 1_000_000 },
    createdAt: "",
    updatedAt: "",
  };
}

const lastAssistant = (session: Session): Extract<Entry, { type: "assistant" }> => {
  const e = [...session.conversation.entries].reverse().find((x) => x.type === "assistant");
  if (!e || e.type !== "assistant") throw new Error("no assistant entry");
  return e;
};

describe.skipIf(!RUN)("Fable-safety (Tier 3, D-14/D-28/D-38)", () => {
  it("round-trips reasoning_details verbatim across a turn (D-14)", { timeout: 120_000 }, async () => {
    const session = new Session({ config: fableConfig(), driver: liveDriver(), systemPrompt: SYS });

    // A turn that genuinely needs thinking, so Fable emits signed reasoning.
    await session.send(
      "Think step by step: a repo has 3 modules and each needs 4 tests — how many tests total? " +
        "Also, our project codename is BLUEJAY; remember it. Give the number and acknowledge the codename.",
    );
    const a1 = lastAssistant(session);
    // Fable returned signed reasoning — the thing D-14 must round-trip verbatim.
    expect(a1.reasoning).toBeDefined();

    // Turn 2's wire replays a1 (incl. its reasoning_details) byte-for-byte; if
    // Fable accepts it (no error/halt) the signed reasoning survived intact.
    await session.send("What is the codename? Reply with just the word.");
    expect(session.status).toBe("idle");
    const a2 = lastAssistant(session);
    expect(a2.text.toUpperCase()).toContain("BLUEJAY");
  });

  it("produces a Fable-accepted request after a safe-harbor compaction (D-28/D-38)", { timeout: 120_000 }, async () => {
    const session = new Session({ config: fableConfig(), driver: liveDriver(), systemPrompt: SYS });

    await session.send(
      "Remember these project facts: the codename is BLUEJAY and the datastore is sqlite. Acknowledge in one sentence.",
    );
    // Safe-harbor fold: everything so far → one summary overlay (cache-reuse path).
    const ok = await session.compact();
    expect(ok).toBe(true);
    // The wire now replays only system + summary — no signed thinking crosses.
    const compaction = session.conversation.entries.find((e) => e.type === "compaction");
    expect(compaction).toBeTruthy();

    // A follow-up against the compacted request must be accepted by Fable AND
    // coherent — the summary preserved the concrete facts.
    await session.send("Using only what you remember, what is the codename and which datastore are we using?");
    expect(session.status).toBe("idle");
    const reply = lastAssistant(session).text;

    const verdict = await judge(liveDriver(), {
      criteria: "The candidate states that the codename is BLUEJAY and the datastore/database is sqlite.",
      candidate: reply,
    });
    expect(verdict.pass, `judge said: ${verdict.reason}`).toBe(true);
  });
});
