/**
 * The SessionManager (D-36): holds N first-class sessions ("a bag of agents")
 * in one instance. Even at N=1 it exists, so concurrency stays additive and
 * nothing assumes a single "current session" (the anti-entropy invariant).
 *
 * It is also the instance-level **fan-in bus** (D-43): every session's event
 * stream is multiplexed here, tagged with the session id, alongside
 * added/removed lifecycle frames. One instance = one bus — the shape the future
 * fleet aggregator (§18) subscribes to, and the fewest connections for the
 * browser. `subscribe()` delivers those frames; the server projects them to the
 * multiplexed `/events` SSE.
 */
import { Session, type SessionOptions } from "./session.js";
import type { SessionEvent } from "./types.js";

/** A frame the manager's fan-in bus delivers to subscribers (D-43). */
export type ManagerFrame =
  | { kind: "event"; sessionId: string; event: SessionEvent } // one session's event, tagged
  | { kind: "added"; session: Session } // a session joined the bag
  | { kind: "removed"; sessionId: string }; // a session left (closed)

type ManagerListener = (frame: ManagerFrame) => void;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<ManagerListener>();
  /** Per-session unsubscribe for the fan-in wiring, so removal detaches it. */
  private readonly unsubs = new Map<string, () => void>();

  create(options: SessionOptions): Session {
    return this.add(new Session(options));
  }

  /** Register an already-constructed session (used with a session factory). Wires
   *  its events into the fan-in bus and announces it as `added`. */
  add(session: Session): Session {
    if (this.sessions.has(session.id)) return session; // idempotent
    this.sessions.set(session.id, session);
    const unsub = session.onEvent((event) => this.broadcast({ kind: "event", sessionId: session.id, event }));
    this.unsubs.set(session.id, unsub);
    this.broadcast({ kind: "added", session });
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Remove a session from the bag, detach its fan-in wiring, and announce it as
   *  `removed`. (Stopping the loop is the caller's concern — see the close path.) */
  remove(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.unsubs.get(id)?.();
    this.unsubs.delete(id);
    this.sessions.delete(id);
    this.broadcast({ kind: "removed", sessionId: id });
    return true;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Subscribe to the instance's multiplexed event/lifecycle stream (D-43).
   *  Returns an unsubscribe. Subscribe *before* snapshotting `list()` so no
   *  add can slip through the gap (subscribers dedupe by id). */
  subscribe(listener: ManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(frame: ManagerFrame): void {
    for (const listener of this.listeners) listener(frame);
  }
}
