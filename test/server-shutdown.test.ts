import { describe, it, expect, vi } from "vitest";
import { createShutdown, type ClosableServer } from "../src/server/shutdown";

/**
 * H-03: `server.close()` waits for in-flight requests, and the browser's SSE bus
 * is a request that never ends — so Ctrl-C hung for as long as a tab was open.
 * The fix is to force the sockets closed *after* asking the server to stop.
 */

/** A server whose close() callback only fires once connections are dropped —
 *  the behaviour of a real http.Server holding an open SSE stream. */
function sseHoldingServer(): ClosableServer & { closed: () => boolean } {
  let pending: (() => void) | undefined;
  let closed = false;
  return {
    close(cb) {
      pending = cb; // held: a live connection is still open
    },
    closeAllConnections() {
      closed = true;
      pending?.(); // dropping the connection lets close() complete
      pending = undefined;
    },
    closed: () => closed,
  };
}

describe("createShutdown", () => {
  it("flushes before closing, so records aren't lost on the way out", async () => {
    const order: string[] = [];
    const server: ClosableServer = {
      close(cb) {
        order.push("close");
        cb?.();
      },
      closeAllConnections() {
        order.push("closeAllConnections");
      },
    };
    const { shutdown } = createShutdown({
      server,
      flush: async () => {
        order.push("flush");
      },
      onError: () => {},
    });

    await new Promise<void>((done) => shutdown(done));
    expect(order).toEqual(["flush", "close", "closeAllConnections"]);
  });

  it("completes even when a connection is held open (the SSE hang)", async () => {
    const server = sseHoldingServer();
    const { shutdown } = createShutdown({ server, flush: async () => {}, onError: () => {} });

    // Without closeAllConnections() this promise never settles — which was the bug.
    await new Promise<void>((done) => shutdown(done));
    expect(server.closed()).toBe(true);
  });

  it("still shuts down when the flush fails, reporting rather than hanging", async () => {
    const onError = vi.fn();
    const server = sseHoldingServer();
    const { shutdown } = createShutdown({
      server,
      flush: async () => {
        throw new Error("ENOSPC");
      },
      onError,
    });

    await new Promise<void>((done) => shutdown(done));
    expect(onError).toHaveBeenCalledOnce();
    // A full disk must not turn into an unkillable process (D-46).
    expect(server.closed()).toBe(true);
  });

  it("is idempotent, so a repeated signal can't start two teardowns", async () => {
    const close = vi.fn((cb?: () => void) => cb?.());
    const flush = vi.fn(async () => {});
    const { shutdown, isShuttingDown } = createShutdown({
      server: { close, closeAllConnections: () => {} },
      flush,
      onError: () => {},
    });

    expect(isShuttingDown()).toBe(false);
    await new Promise<void>((done) => {
      shutdown(done);
      shutdown(() => done()); // second signal arriving mid-teardown
    });
    expect(isShuttingDown()).toBe(true);
    expect(flush).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("tolerates a server without closeAllConnections", async () => {
    const { shutdown } = createShutdown({
      server: { close: (cb) => cb?.() },
      flush: async () => {},
      onError: () => {},
    });
    await expect(new Promise<void>((done) => shutdown(done))).resolves.toBeUndefined();
  });
});
