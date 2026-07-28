/**
 * Orderly shutdown for the dev server, shared by `POST /shutdown` and the
 * SIGINT/SIGTERM handlers so both paths behave identically (H-03).
 *
 * Two things have to happen, in this order:
 *
 * 1. **Flush pending persistence writes.** `flush()` *rejects* on a stalled
 *    write (D-46) rather than resolving green, so a loss is reported on the way
 *    out instead of exiting silently — and we still exit, since a shutdown that
 *    can't complete because the disk is full would be worse than a loud one.
 *
 * 2. **Force the sockets closed.** `server.close()` only stops *new* connections
 *    and then waits for in-flight ones to end. The browser's multiplexed SSE bus
 *    (§11, D-43) is a request that never ends, so `close()`'s callback never
 *    fires while a tab is open — which is exactly why Ctrl-C appeared dead until
 *    you closed the tab (H-03). `closeAllConnections()` drops them.
 */

/** The slice of `http.Server` we need — keeps this unit testable. */
export interface ClosableServer {
  close(callback?: () => void): unknown;
  /** Node 18.2+. Optional so a stub server doesn't have to implement it. */
  closeAllConnections?(): void;
}

export interface ShutdownDeps {
  server: ClosableServer;
  /** Flush every durable writer (conversation store, debug journal, MCP children). */
  flush: () => Promise<unknown>;
  /** Called when the flush failed; the caller decides the exit code. */
  onError: (err: unknown) => void;
}

/**
 * Build the shutdown routine. The returned function is **idempotent** — a second
 * call while one is in flight is ignored, so a repeated signal can't start two
 * overlapping teardowns; callers wanting a hard exit on the second signal check
 * {@link isShuttingDown} and bail out themselves.
 */
export function createShutdown(deps: ShutdownDeps): {
  shutdown: (done: () => void) => void;
  isShuttingDown: () => boolean;
} {
  let shuttingDown = false;

  const shutdown = (done: () => void): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void deps
      .flush()
      .catch(deps.onError)
      .finally(() => {
        deps.server.close(() => done());
        // After close(), not before: close() stops new connections, then this
        // drops the long-lived ones already open so the callback can fire.
        deps.server.closeAllConnections?.();
      });
  };

  return { shutdown, isShuttingDown: () => shuttingDown };
}
