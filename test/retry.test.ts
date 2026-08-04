/**
 * Retry — re-attempting the current turn (D-57).
 *
 * The whole feature rests on one invariant: a failed or abandoned attempt
 * appends **nothing**, so re-running the loop rebuilds the identical prefix.
 * Most of these tests are really assertions about the conversation tree, not
 * about buttons — if a retry ever left a stray entry behind, the "just ask
 * again" story would quietly become "fork the thread", which is the thing the
 * user was trying to avoid in the first place.
 */
import { describe, it, expect, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { Session } from "../src/session/session";
import { scriptedDriver } from "../src/session/fake";
import { HttpError, isTransientError, retryDelayMs } from "../src/llm/errors";
import type { LlmDriver, StreamEvent } from "../src/llm/types";
import type { ModelConfig } from "../src/config/types";
import type { SessionEvent } from "../src/session/types";
import type { AssistantEntry } from "../src/conversation/types";

const config: ModelConfig = {
  id: "cfg_r",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

const waitUntil = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("waitUntil timed out");
};

function textEvents(text: string): StreamEvent[] {
  return [
    { type: "text", delta: text },
    { type: "finish", reason: "stop" },
  ];
}

/** Fails the first `failures` calls with `err`, then streams `text`. */
function flakyDriver(failures: number, err: () => unknown, text = "recovered"): LlmDriver {
  let calls = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      if (calls++ < failures) throw err();
      yield* textEvents(text);
    },
  };
}

function newSession(driver: LlmDriver, opts: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  return new Session({ config, driver, autoRetryDelay: () => 0, ...opts });
}

describe("transient classification", () => {
  it("retries what a retry could fix, and nothing else", () => {
    // The distinction the whole auto-retry policy turns on. 402 is the case that
    // started this: no amount of asking again conjures credits.
    expect(isTransientError(new HttpError(429, "rate limited"))).toBe(true);
    expect(isTransientError(new HttpError(503, "upstream unavailable"))).toBe(true);
    expect(isTransientError(new HttpError(408, "timeout"))).toBe(true);
    expect(isTransientError(new HttpError(402, "Insufficient credits"))).toBe(false);
    expect(isTransientError(new HttpError(401, "bad key"))).toBe(false);
    expect(isTransientError(new HttpError(400, "malformed"))).toBe(false);
  });

  it("treats a request that never got a status as transient", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(isTransientError(new Error("something the model said"))).toBe(false);
  });

  it("never treats a deliberate abort as a failure", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isTransientError(abort)).toBe(false);
  });

  it("honors Retry-After, clamped", () => {
    expect(retryDelayMs(new HttpError(429, "x", { retryAfter: "7" }), 1)).toBe(7000);
    // A hostile/stale header must not wedge the session for an hour.
    expect(retryDelayMs(new HttpError(429, "x", { retryAfter: "9999" }), 1, 30_000)).toBe(30_000);
    // No header → backoff grows with the attempt (jitter keeps it a range).
    expect(retryDelayMs(new Error("boom"), 3)).toBeGreaterThan(retryDelayMs(new Error("boom"), 1));
  });
});

describe("automatic retry of transient failures", () => {
  it("rides out a blip without bothering the user", async () => {
    const events: SessionEvent[] = [];
    const s = newSession(flakyDriver(2, () => new HttpError(503, "upstream unavailable")));
    s.onEvent((e) => events.push(e));
    await s.send("hi");

    expect(s.status).toBe("idle");
    // It answered, and the failures never became the user's problem.
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(events.filter((e) => e.type === "retrying")).toHaveLength(2);
    const assistants = s.conversation.entries.filter((e) => e.type === "assistant");
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as AssistantEntry).text).toBe("recovered");
  });

  it("re-announces assistant-start per attempt so the live overlay resets", async () => {
    // Otherwise a re-send concatenates onto the half-streamed text of the
    // attempt it replaced, and the user watches one reply become two.
    const events: SessionEvent[] = [];
    const s = newSession(flakyDriver(1, () => new HttpError(503, "blip")));
    s.onEvent((e) => events.push(e));
    await s.send("hi");
    expect(events.filter((e) => e.type === "assistant-start")).toHaveLength(2);
  });

  it("gives up after maxAutoRetries and surfaces a retryable error", async () => {
    const events: SessionEvent[] = [];
    const s = newSession(flakyDriver(99, () => new HttpError(503, "still down")), { maxAutoRetries: 2 });
    s.onEvent((e) => events.push(e));
    await s.send("hi");

    expect(events.filter((e) => e.type === "retrying")).toHaveLength(2);
    const errs = events.filter((e) => e.type === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ retryable: true });
    expect(s.retryable).toBe(true);
  });

  it("does not auto-retry a failure a retry cannot fix", async () => {
    // The reported bug: out of credits. One error, immediately, with a button —
    // not three silent re-sends while the user is off topping up their account.
    const events: SessionEvent[] = [];
    const s = newSession(flakyDriver(99, () => new HttpError(402, "Insufficient credits")));
    s.onEvent((e) => events.push(e));
    await s.send("fix my bug");

    expect(events.filter((e) => e.type === "retrying")).toHaveLength(0);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(s.retryable).toBe(true);
    expect(s.status).toBe("idle");
  });
});

describe("retry after a failure", () => {
  it("re-sends the same prefix and appends nothing extra", async () => {
    const s = newSession(flakyDriver(99, () => new HttpError(402, "Insufficient credits")));
    await s.send("what is 2+2");

    // One user entry, no assistant entry: the branch is exactly as the failed
    // request found it.
    expect(s.conversation.entries).toHaveLength(1);
    const leafAfterFailure = s.conversation.activeLeaf;

    // "Joshua tops up his credits" — the driver starts working.
    (s as unknown as { driver: LlmDriver }).driver = scriptedDriver(textEvents("4"));
    await s.retry();

    expect(s.status).toBe("idle");
    expect(s.retryable).toBe(false);
    const entries = s.conversation.entries;
    expect(entries).toHaveLength(2); // the original user message + one answer
    expect(entries.filter((e) => e.type === "user")).toHaveLength(1); // no "continue" junk
    expect((entries[1] as AssistantEntry).text).toBe("4");
    expect(entries[1]!.parent).toBe(leafAfterFailure); // answered in place, not forked
  });

  it("resets the circuit breaker from halted", async () => {
    // The breaker counts *consecutive* failures; a person deliberately asking
    // again is precisely the discontinuity that count is measuring.
    const s = newSession(flakyDriver(99, () => new HttpError(402, "no credits")), {
      maxConsecutiveFailures: 1,
    });
    await s.send("hi");
    expect(s.status).toBe("halted");
    expect(s.retryable).toBe(true);

    (s as unknown as { driver: LlmDriver }).driver = scriptedDriver(textEvents("ok"));
    await s.retry();
    expect(s.status).toBe("idle");
    expect(s.conversation.entries.filter((e) => e.type === "assistant")).toHaveLength(1);
  });

  it("refuses when there is nothing to retry", async () => {
    const s = newSession(scriptedDriver(textEvents("hello")));
    await s.send("hi");
    expect(s.retryable).toBe(false);
    await expect(s.retry()).rejects.toThrow(/nothing to retry/i);
  });

  it("a new message supersedes a pending retry", async () => {
    const s = newSession(flakyDriver(1, () => new HttpError(402, "no credits"), "answer"));
    await s.send("hi");
    expect(s.retryable).toBe(true);
    await s.send("actually, never mind");
    expect(s.retryable).toBe(false);
  });
});

describe("retry while a request looks hung", () => {
  /** Streams one token, then hangs until aborted. */
  function hangingDriver(onHang: () => void): LlmDriver {
    return {
      async *streamChat(_req, opts): AsyncGenerator<StreamEvent> {
        yield { type: "text", delta: "thin" };
        onHang();
        await new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    };
  }

  it("abandons the stuck attempt and sends it again, counting no failure", async () => {
    let hung = false;
    let calls = 0;
    const driver: LlmDriver = {
      async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
        if (calls++ === 0) {
          yield* hangingDriver(() => (hung = true)).streamChat(req, opts);
          return;
        }
        yield* textEvents("second time lucky");
      },
    };
    const events: SessionEvent[] = [];
    const s = newSession(driver);
    s.onEvent((e) => events.push(e));

    const turn = s.send("hi");
    await waitUntil(() => hung);
    await s.retry(); // the user calls it stuck
    await turn;

    expect(s.status).toBe("idle");
    // No failure was counted and no error was shown — this was a restart, not a
    // fault. The tree holds one question and one answer.
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(s.conversation.entries).toHaveLength(2);
    expect((s.conversation.entries[1] as AssistantEntry).text).toBe("second time lucky");
    // The overlay was reset before the second attempt streamed into it.
    expect(events.filter((e) => e.type === "assistant-start")).toHaveLength(2);
  });

  it("leaves background work alone — that is Stop's job", async () => {
    // The distinction that keeps Retry from being a second, sneakier Stop: a
    // hung *request* should not cost you a running build.
    let hung = false;
    let calls = 0;
    const driver: LlmDriver = {
      async *streamChat(req, opts): AsyncGenerator<StreamEvent> {
        if (calls++ === 0) {
          yield* hangingDriver(() => (hung = true)).streamChat(req, opts);
          return;
        }
        yield* textEvents("done");
      },
    };
    const s = newSession(driver);
    const turn = s.send("hi");
    await waitUntil(() => hung);
    await s.enqueue("and also this");
    expect(s.queuedMessages).toHaveLength(1);

    await s.retry();
    expect(s.queuedMessages).toHaveLength(1); // survived the restart
    await turn;
  });

  it("refuses when no request is in flight", async () => {
    // Mid-tool-run there is nothing to abandon; saying so beats silently
    // poisoning the next turn's error handling with a stale restart flag.
    const s = newSession(scriptedDriver(textEvents("hi")));
    await s.send("hi");
    (s as unknown as { status: string }).status = "running";
    await expect(s.retry()).rejects.toThrow(/no model request is in flight/i);
  });

  it("a stop outranks a retry that was mid-flight", async () => {
    let hung = false;
    const s = newSession(hangingDriver(() => (hung = true)));
    const turn = s.send("hi");
    await waitUntil(() => hung);
    await s.retry();
    s.stop("hard"); // changed their mind: don't want this turn at all
    await turn;
    expect(s.status).toBe("idle");
    expect(s.conversation.entries).toHaveLength(1); // no answer, and none re-requested
  });
});

describe("the /retry route (D-57)", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-retry-"));
  const store = new ConversationStore(storeDir);
  afterAll(async () => {
    await store.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  function makeApp(driver: LlmDriver) {
    return createServer({
      resolveConfig: () => config,
      newSession: (c, conversation) => new Session({ config: c, driver, conversation, autoRetryDelay: () => 0 }),
      store,
      workingDir: "/work/test",
      version: "0.0.0",
    }).app;
  }
  const post = async (app: ReturnType<typeof makeApp>, url: string, body: unknown) => {
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  it("carries `retryable` on the settled state, then recovers the turn", async () => {
    // End-to-end shape of the reported bug: a paid request fails, the browser
    // learns the turn is re-sendable, the account is fixed, one POST recovers it
    // — with no extra user message in the transcript.
    let broke = false;
    const driver: LlmDriver = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        if (!broke) {
          broke = true;
          throw new HttpError(402, "Insufficient credits");
        }
        yield* textEvents("answer");
      },
    };
    const app = makeApp(driver);
    const id = (await post(app, "/session", {})).json.sessionId as string;

    const failed = await post(app, "/chat", { sessionId: id, text: "hi" });
    expect(failed.json.retryable).toBe(true);

    const recovered = await post(app, `/session/${id}/retry`, {});
    expect(recovered.status).toBe(200);
    expect(recovered.json.retryable).toBe(false);
    expect(recovered.json.reply).toBe("answer");
  });

  it("409s rather than silently doing nothing when there is nothing to retry", async () => {
    const app = makeApp(scriptedDriver(textEvents("fine")));
    const id = (await post(app, "/session", {})).json.sessionId as string;
    await post(app, "/chat", { sessionId: id, text: "hi" });
    const res = await post(app, `/session/${id}/retry`, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/nothing to retry/i);
  });

  it("404s for an unknown session", async () => {
    const app = makeApp(scriptedDriver(textEvents("x")));
    expect((await post(app, "/session/sess_nope/retry", {})).status).toBe(404);
  });

  it("GET /state answers with the pauses, which GET /session does not (X-21 seam)", async () => {
    // The re-sync seam a client uses when its own copy is no longer trustworthy.
    // `GET /session/:id` is the *tree* endpoint: folding its response through
    // `applyState` would clear `pendingApproval`, which is the state a stranded
    // browser is already stuck in — so re-syncing through it would look like a
    // fix and do nothing. These two must not be confused; hence the assertion.
    const app = makeApp(flakyDriver(99, () => new HttpError(402, "no credits")));
    const id = (await post(app, "/session", {})).json.sessionId as string;
    await post(app, "/chat", { sessionId: id, text: "hi" });

    const state = (await (await app.request(`/session/${id}/state`)).json()) as any;
    expect(state.retryable).toBe(true);
    expect(state.status).toBe("idle");
    expect("approvalRequest" in state || state.status !== "awaiting-approval").toBe(true);

    const tree = (await (await app.request(`/session/${id}`)).json()) as any;
    expect(tree.entries).toBeDefined(); // the tree endpoint's job
    expect(tree.retryable).toBeUndefined(); // ...and not this one's
  });
});
