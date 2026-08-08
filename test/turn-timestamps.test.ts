/**
 * X-25 — JLCode tells the model when each turn was sent.
 *
 * From real use: *"JLCode was leaving notes with the wrong date in them."* The
 * system prompt carries no date and never did, so a model with a training cutoff
 * and no clock dates a changelog entry to whenever it thinks "now" is.
 *
 * Joshua's call is a stamp on **each user turn**, not one in the system prompt:
 * a one-shot date answers "what day is it" and destroys "you started this thread
 * yesterday morning"; a per-turn stamp answers both. `UserEntry.ts` has been on
 * disk since the tree existed, so this is a **rendering** change — which buys
 * three properties this file asserts directly, because they are the whole
 * argument for the design:
 *
 *  - **retroactive**: an old conversation renders stamps with no migration;
 *  - **cache-safe**: the stamp is frozen at append time, so turn N's prefix is a
 *    byte-identical prefix of turn N+1's, and re-rendering later never changes a
 *    byte — the property a date in the *system* message would destroy every turn
 *    (the exact defect D-58 fixed at a measured 12.3x);
 *  - **gap-legible**: two turns a day apart carry two different stamps.
 */
import { fakeAgentDriver } from "../src/session/fake";
import { withEnvironmentDetails } from "../src/conversation/wire";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  buildWireMessages,
  currentTimeSection,
  renderEnvironmentDetails,
  stripEnvironmentDetails,
  summarySpanSection,
  withEnvironmentDetails,
} from "../src/conversation/wire";
import { buildCrossModelSummaryInput } from "../src/session/compaction";
import type { Conversation, Entry } from "../src/conversation/types";
import { Session } from "../src/session/session";
import { scriptedDriver } from "../src/session/fake";
import { turnTimestampsEnabled } from "../src/config/operations";
import { runConfig } from "../src/config/commands";
import { loadConfig, saveConfig } from "../src/config/store";
import { addModelConfig } from "../src/config/operations";
import { resolvePaths } from "../src/paths";
import type { JlcodePaths } from "../src/paths";
import type { ModelConfig } from "../src/config/types";
import type { ChatRequest, LlmDriver, StreamEvent } from "../src/llm/types";

const SYS = "SYS";
const ZONE = "America/Chicago";

/** A conversation assembled by hand with the timestamps a real log carries —
 *  which is the point: nothing here is new state, it is the `ts` every entry has
 *  always had. */
function conversationOf(entries: Array<Partial<Entry> & { type: Entry["type"]; ts: string }>): Conversation {
  const built = entries.map((e, i) => ({
    id: `e${i}`,
    parent: i === 0 ? null : `e${i - 1}`,
    ...e,
  })) as Entry[];
  return {
    id: "conv",
    entries: built,
    activeLeaf: built[built.length - 1]?.id ?? null,
    createdAt: built[0]?.ts ?? "",
    updatedAt: built[built.length - 1]?.ts ?? "",
  };
}

/** Yesterday 09:14 local-ish and this morning 08:02 — the overnight gap X-25(f)
 *  is about, expressed in UTC because that is what the log stores. */
const YESTERDAY = "2026-08-05T14:14:09.000Z";
const TODAY = "2026-08-06T13:02:41.000Z";

const overnightThread = () =>
  conversationOf([
    { type: "user", text: "start the migration notes", ts: YESTERDAY },
    { type: "assistant", text: "started", ts: "2026-08-05T14:14:30.000Z" },
    { type: "user", text: "add today's entry", ts: TODAY },
  ]);

const userContents = (msgs: { role: string; content: unknown }[]) =>
  msgs.filter((m) => m.role === "user").map((m) => String(m.content));

// ---------------------------------------------------------------------------
// The rendered stamp (X-25a/b/c).
// ---------------------------------------------------------------------------

describe("the per-turn stamp (X-25a/b)", () => {
  it("appends an <environment_details> block after the user's own words", () => {
    const msgs = buildWireMessages(overnightThread(), { system: SYS, timeZone: ZONE });
    const first = String(msgs[1]!.content);
    // (b) a wrapping block, not a bare prefix line: the model can tell JLCode's
    // framing from what the user typed, and it is where a cwd/mode/cost line
    // would go next.
    expect(first.startsWith("start the migration notes\n\n<environment_details>")).toBe(true);
    expect(first.endsWith("</environment_details>")).toBe(true);
    expect(stripEnvironmentDetails(first)).toBe("start the migration notes");
  });

  it("states an ISO 8601 UTC instant plus the user's zone and offset (X-25a)", () => {
    const msgs = buildWireMessages(overnightThread(), { system: SYS, timeZone: ZONE });
    const first = String(msgs[1]!.content);
    expect(first).toContain("# Current Time");
    expect(first).toContain(`Current time in ISO 8601 UTC format: ${YESTERDAY}`);
    // The zone is what makes the instant actionable ("yesterday morning").
    expect(first).toContain(`User time zone: ${ZONE}, UTC-05:00`);
  });

  it("computes the offset at the stamped instant, not at render time (DST)", () => {
    const summer = currentTimeSection("2026-07-04T12:00:00.000Z", ZONE)!;
    const winter = currentTimeSection("2026-01-04T12:00:00.000Z", ZONE)!;
    expect(summer.lines[1]).toBe(`User time zone: ${ZONE}, UTC-05:00`);
    expect(winter.lines[1]).toBe(`User time zone: ${ZONE}, UTC-06:00`);
    // UTC itself formats as an offset rather than the bare "GMT" Intl returns.
    expect(currentTimeSection(TODAY, "UTC")!.lines[1]).toBe("User time zone: UTC, UTC+00:00");
  });

  it("stamps user turns only — assistant and tool entries carry a ts too (X-25c)", () => {
    const conv = conversationOf([
      { type: "user", text: "run it", ts: YESTERDAY },
      { type: "assistant", text: "ok", ts: YESTERDAY, toolCalls: [] as never },
      { type: "tool", toolCallId: "tc", name: "run_command", content: "done", ts: YESTERDAY },
    ]);
    const msgs = buildWireMessages(conv, { system: SYS, timeZone: ZONE });
    for (const m of msgs) {
      if (m.role === "user") expect(String(m.content)).toContain("<environment_details>");
      else expect(String(m.content ?? "")).not.toContain("<environment_details>");
    }
  });

  it("keeps the date out of the system message — the D-58 trap X-25 exists to avoid", () => {
    const msgs = buildWireMessages(overnightThread(), { system: SYS, timeZone: ZONE });
    expect(msgs[0]).toEqual({ role: "system", content: SYS });
  });

  it("survives an unparseable ts without losing the turn", () => {
    const conv = conversationOf([{ type: "user", text: "hi", ts: "not-a-date" }]);
    const msgs = buildWireMessages(conv, { system: SYS, timeZone: ZONE });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  it("renders exactly the pre-X-25 shape when stamps are off (X-25e)", () => {
    const msgs = buildWireMessages(overnightThread(), { system: SYS, stamps: false });
    expect(msgs.map((m) => m.content)).toEqual([SYS, "start the migration notes", "started", "add today's entry"]);
  });
});

describe("the three properties the rendering design buys", () => {
  it("is retroactive: a thread written before X-25 gains its stamps unmigrated", () => {
    // Nothing was added to the log — these are the timestamps a 2026-08-05 log
    // already had. Rendering is the only thing that changed.
    const msgs = buildWireMessages(overnightThread(), { system: SYS, timeZone: ZONE });
    expect(userContents(msgs)[0]).toContain(YESTERDAY);
  });

  it("reads an overnight gap as a gap: each turn keeps its own frozen stamp", () => {
    const [first, second] = userContents(buildWireMessages(overnightThread(), { system: SYS, timeZone: ZONE }));
    expect(first).toContain("2026-08-05T14:14:09");
    expect(second).toContain("2026-08-06T13:02:41");
    expect(first).not.toContain("2026-08-06");
  });

  it("is cache-safe: turn N's prefix is a byte-identical prefix of turn N+1's", () => {
    const conv = overnightThread();
    // The window as it stood one turn earlier…
    const earlier = buildWireMessages(conv, { system: SYS, leafId: "e1", timeZone: ZONE });
    // …and as it stands now, after another user turn landed.
    const now = buildWireMessages(conv, { system: SYS, timeZone: ZONE });
    expect(now.slice(0, earlier.length)).toEqual(earlier);
    // And re-rendering the same conversation later is byte-identical: the stamp
    // was frozen at append time, so nothing in the prefix moves with the clock.
    expect(buildWireMessages(conv, { system: SYS, timeZone: ZONE })).toEqual(now);
  });
});

describe("the <environment_details> seam (X-25g — shared with X-15)", () => {
  it("composes further per-turn sections without touching the turn renderer", () => {
    // X-15's *static* half belongs in the system prompt; anything that varies
    // per turn lands here as another section. Asserted so the shape is a
    // contract, not an accident of the current one-section case.
    const block = renderEnvironmentDetails([
      { heading: "Current Time", lines: ["a"] },
      { heading: "Current Working Directory", lines: ["/work"] },
    ]);
    expect(block).toBe(
      "<environment_details>\n# Current Time\na\n\n# Current Working Directory\n/work\n</environment_details>",
    );
    // Empty sections drop out, and nothing to say renders nothing at all.
    expect(renderEnvironmentDetails([{ heading: "Current Time", lines: [] }])).toBe("");
    expect(withEnvironmentDetails("just words", [])).toBe("just words");
  });

  it("strips back off cleanly, including a turn that was only the block", () => {
    const stamped = withEnvironmentDetails("hello", [currentTimeSection(TODAY, ZONE)!]);
    expect(stripEnvironmentDetails(stamped)).toBe("hello");
    expect(stripEnvironmentDetails(withEnvironmentDetails("", [currentTimeSection(TODAY, ZONE)!]))).toBe("");
    expect(stripEnvironmentDetails("no block here")).toBe("no block here");
  });
});

// ---------------------------------------------------------------------------
// Compaction keeps the history of time (X-25d).
// ---------------------------------------------------------------------------

describe("a compacted thread keeps its dates (X-25d)", () => {
  const compacted = () =>
    conversationOf([
      { type: "user", text: "old q", ts: "2026-08-01T10:00:00.000Z" },
      { type: "assistant", text: "old a", ts: "2026-08-01T10:00:20.000Z" },
      { type: "compaction", summary: "SUMMARY", replayCut: true, ts: "2026-08-05T20:31:00.000Z" },
      { type: "user", text: "new q", ts: TODAY },
    ]);

  it("says which span the summary stands in for", () => {
    const msgs = buildWireMessages(compacted(), { system: SYS, timeZone: ZONE });
    const summary = String(msgs[1]!.content);
    expect(summary).toContain("[Summary of the earlier conversation]\nSUMMARY");
    expect(summary).toContain("# Summarized History");
    expect(summary).toContain(
      "The summary above replaces the conversation from 2026-08-01T10:00:00.000Z to 2026-08-05T20:31:00.000Z",
    );
    // The turn after the cut still carries its own stamp, so the model can see
    // both "that was last week" and "this is today".
    expect(String(msgs[2]!.content)).toContain(TODAY);
  });

  it("spans from the root of the branch, since a later summary folds the earlier one in (D-28)", () => {
    const twice = conversationOf([
      { type: "user", text: "q1", ts: "2026-07-30T09:00:00.000Z" },
      { type: "compaction", summary: "S1", replayCut: true, ts: "2026-08-01T09:00:00.000Z" },
      { type: "user", text: "q2", ts: "2026-08-03T09:00:00.000Z" },
      { type: "compaction", summary: "S2", replayCut: true, ts: "2026-08-05T09:00:00.000Z" },
    ]);
    const summary = String(buildWireMessages(twice, { system: SYS, timeZone: ZONE })[1]!.content);
    expect(summary).toContain("from 2026-07-30T09:00:00.000Z to 2026-08-05T09:00:00.000Z");
  });

  it("goes away with the stamps, and never breaks the summary text itself", () => {
    const msgs = buildWireMessages(compacted(), { system: SYS, stamps: false });
    expect(msgs[1]!.content).toBe("[Summary of the earlier conversation]\nSUMMARY");
  });

  it("the cross-model summarizer reads the same dated transcript (D-29)", () => {
    const input = buildCrossModelSummaryInput(overnightThread(), { system: SYS });
    expect(String(input[1]!.content)).toContain(YESTERDAY);
    expect(stripEnvironmentDetails(String(input[1]!.content))).toBe("start the migration notes");
    // Off is off on both paths.
    expect(buildCrossModelSummaryInput(overnightThread(), { system: SYS, stamps: false })[1]!.content).toBe(
      "start the migration notes",
    );
  });
});

// ---------------------------------------------------------------------------
// The Session: default on, opt-out honored, one rendering for every path.
// ---------------------------------------------------------------------------

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

function recordingDriver(replies: string[]): { driver: LlmDriver; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  const driver: LlmDriver = {
    async *streamChat(req): AsyncGenerator<StreamEvent> {
      requests.push(req);
      const text = replies[Math.min(i++, replies.length - 1)] ?? "ok";
      yield { type: "text", delta: text };
      yield { type: "finish", reason: "stop" };
      yield { type: "usage", usage: { promptTokens: 100, completionTokens: 5 } };
    },
  };
  return { driver, requests };
}

describe("Session (X-25e — on unless the config says otherwise)", () => {
  it("stamps by default, with no config key present at all", async () => {
    const { driver, requests } = recordingDriver(["ok"]);
    const s = new Session({ config: baseConfig, driver, systemPrompt: SYS });
    await s.send("what day is it?");
    const user = requests[0]!.messages.find((m) => m.role === "user")!;
    expect(String(user.content)).toContain("# Current Time");
    expect(stripEnvironmentDetails(String(user.content))).toBe("what day is it?");
    // Still nothing dated in the system message.
    expect(requests[0]!.messages[0]!.content).toBe(SYS);
  });

  it("honors environment.turnTimestamps = false", async () => {
    const { driver, requests } = recordingDriver(["ok"]);
    const config: ModelConfig = { ...baseConfig, environment: { turnTimestamps: false } };
    const s = new Session({ config, driver, systemPrompt: SYS });
    await s.send("what day is it?");
    expect(requests[0]!.messages.find((m) => m.role === "user")!.content).toBe("what day is it?");
  });

  it("defaults on in the one place the default is stated", () => {
    expect(turnTimestampsEnabled(undefined)).toBe(true);
    expect(turnTimestampsEnabled({})).toBe(true);
    expect(turnTimestampsEnabled({ environment: {} })).toBe(true);
    expect(turnTimestampsEnabled({ environment: { turnTimestamps: true } })).toBe(true);
    expect(turnTimestampsEnabled({ environment: { turnTimestamps: false } })).toBe(false);
  });

  it("renders one prefix for every path, so same-model compaction still hits the cache (D-29)", async () => {
    const { driver, requests } = recordingDriver(["first answer", "SUMMARY TEXT"]);
    const s = new Session({ config: baseConfig, driver, systemPrompt: SYS, contextWindow: 200_000 });
    await s.send("remember the codename");
    const live = requests[0]!.messages;
    expect(await s.compact()).toBe(true);
    // The summary request is the live prefix + the ephemeral instruction. If the
    // stamps differed by so much as a byte between the two builders, the cache
    // reuse that makes same-model compaction cheap would silently stop working.
    const summaryReq = requests[1]!.messages;
    expect(summaryReq.slice(0, live.length)).toEqual(live);
  });

  it("re-sends turn 1 byte-identically on turn 2 (the stamp is frozen, not re-read)", async () => {
    const { driver, requests } = recordingDriver(["ok"]);
    const s = new Session({ config: baseConfig, driver, systemPrompt: SYS });
    await s.send("hello");
    const first = requests[0]!.messages;
    await new Promise((r) => setTimeout(r, 5)); // the clock moves; the prefix must not
    await s.send("again");
    expect(requests[1]!.messages.slice(0, first.length)).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// `config set --turn-timestamps` — the opt-out without hand-editing JSON.
// ---------------------------------------------------------------------------

describe("config set --turn-timestamps (X-25e)", () => {
  let dir: string;
  let paths: JlcodePaths;
  let out: string[];
  const savedEnv = { config: process.env.JLCODE_CONFIG_DIR, data: process.env.JLCODE_DATA_DIR };
  let restoreOut: () => void;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-x25-cli-"));
    process.env.JLCODE_CONFIG_DIR = path.join(dir, "config");
    process.env.JLCODE_DATA_DIR = path.join(dir, "data");
    paths = resolvePaths();
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(
      paths.modelsCacheFile,
      JSON.stringify({ fetchedAt: new Date().toISOString(), windows: { "anthropic/claude-opus-5": 1_000_000 } }),
    );
    const { config } = addModelConfig(loadConfig(paths), {
      name: "Opus",
      model: "anthropic/claude-opus-5",
      openRouterKey: "sk",
      defaultMode: "code",
      defaultApproval: "manual",
      compaction: { auto: true },
    });
    saveConfig(config, paths);
    out = [];
    const realOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    restoreOut = () => {
      process.stdout.write = realOut;
    };
  });
  afterEach(() => {
    restoreOut();
    process.env.JLCODE_CONFIG_DIR = savedEnv.config;
    process.env.JLCODE_DATA_DIR = savedEnv.data;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stored = () => loadConfig(paths).modelConfigs[0]!;

  it("turns the stamps off and reads the decision back", async () => {
    expect(await runConfig(["set", "Opus", "--turn-timestamps", "off", "--offline"])).toBe(0);
    expect(stored().environment?.turnTimestamps).toBe(false);
    expect(turnTimestampsEnabled(stored())).toBe(false);
    expect(out.join("")).toContain("turn timestamps: off");
  });

  it("turns them back on, and a fresh config needs no key at all", async () => {
    expect(turnTimestampsEnabled(stored())).toBe(true);
    expect(stored().environment).toBeUndefined();
    await runConfig(["set", "Opus", "--turn-timestamps", "off", "--offline"]);
    await runConfig(["set", "Opus", "--turn-timestamps", "on", "--offline"]);
    expect(turnTimestampsEnabled(stored())).toBe(true);
    expect(out.join("")).toContain("turn timestamps: on");
  });

  it("rejects anything that isn't on/off", async () => {
    await expect(runConfig(["set", "Opus", "--turn-timestamps", "maybe", "--offline"])).rejects.toThrow(
      /must be "on" or "off"/,
    );
  });

  it("`config which` states it beside the window and the threshold", async () => {
    await runConfig(["use", "Opus"]);
    await runConfig(["set", "Opus", "--turn-timestamps", "off", "--offline"]);
    out.length = 0;
    expect(await runConfig(["which", "--offline"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("turn timestamps: off");
    expect(text).toContain("the model is never told what day it is");
  });

  it("does not disturb the compaction settings it sits beside", async () => {
    await runConfig(["set", "Opus", "--compaction-threshold", "171500", "--offline"]);
    await runConfig(["set", "Opus", "--turn-timestamps", "off", "--offline"]);
    expect(stored().compaction?.thresholdTokens).toBe(171_500);
    expect(stored().environment?.turnTimestamps).toBe(false);
  });
});

/**
 * The stamp must never leak into a *title*. The fake driver answers X-09's
 * ephemeral naming question from the opening user turn, and that turn now
 * carries an `<environment_details>` block — so counting words before stripping
 * it names a short thread after the timestamp. Found by eye in an X-28 peek,
 * where a bare `form:` seed left nothing but the block and the rail card read
 * `<environment_de…`.
 */
describe("the stamp never becomes the thread's name", () => {
  const NAME_ASK = "Ignore the task for one moment. Name this conversation.";
  const stamped = (text: string) =>
    withEnvironmentDetails(text, [{ heading: "Current Time", lines: ["Current time in ISO 8601 UTC format: 2026-08-08T20:30:00.000Z"] }]);

  const titleFor = async (opening: string): Promise<string> => {
    const driver = fakeAgentDriver();
    let out = "";
    for await (const ev of driver.streamChat({
      model: "fake",
      messages: [
        { role: "user", content: stamped(opening) },
        { role: "user", content: NAME_ASK },
      ],
    })) {
      if (ev.type === "text") out += ev.delta;
    }
    return out;
  };

  it("names the thread from the words, not the block", async () => {
    expect(await titleFor("fix the scroll defect")).toBe("Fix the scroll defect");
  });

  it("does not read the block when the seed leaves no words behind", async () => {
    const title = await titleFor("form:");
    expect(title).not.toContain("environment_details");
    expect(title).not.toContain("Current Time");
    expect(title).toBe("A new conversation");
  });
});
