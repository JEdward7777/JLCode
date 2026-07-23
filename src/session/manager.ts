/**
 * The SessionManager (D-36): holds N first-class sessions ("a bag of agents")
 * in one instance. Even at N=1 it exists, so concurrency stays additive and
 * nothing assumes a single "current session" (the anti-entropy invariant).
 */
import { Session, type SessionOptions } from "./session.js";

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  create(options: SessionOptions): Session {
    return this.add(new Session(options));
  }

  /** Register an already-constructed session (used with a session factory). */
  add(session: Session): Session {
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  remove(id: string): boolean {
    return this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}
