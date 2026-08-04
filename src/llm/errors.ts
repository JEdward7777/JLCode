/**
 * Transport errors, typed enough to decide whether asking again could help (D-57).
 *
 * The session's retry policy turns on one question: *would re-sending the exact
 * same request plausibly succeed?* For "the provider is busy / a gateway blipped"
 * the answer is yes and JLCode should just do it. For "you are out of credits",
 * "your key is wrong", "that prompt is too long" the answer is no — those need a
 * human to go fix something, and retrying only burns the circuit breaker while
 * they're in another tab doing it.
 *
 * That distinction is an HTTP status code, so carry the status instead of
 * re-deriving it from prose. `isOverWindowError` (compaction.ts) stays a text
 * match because it splits *within* 400 and providers phrase it differently.
 */

/** A non-2xx response from the model provider, with the status preserved. */
export class HttpError extends Error {
  readonly status: number;
  /** Verbatim `Retry-After` header, when the provider sent one. */
  readonly retryAfter: string | undefined;

  constructor(status: number, message: string, opts: { retryAfter?: string } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfter = opts.retryAfter;
  }
}

/** Network-level failures: the request never got a status at all. Node phrases
 *  these as `cause.code` on a TypeError from fetch, or as a bare message. */
const TRANSIENT_NETWORK = /econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|socket hang up|network|fetch failed/i;

/**
 * Could re-sending this exact request work? Retry 429 (rate limited), 408
 * (request timeout) and 5xx (provider-side), plus anything that failed below the
 * HTTP layer. Everything else — 401/402/403/404/400 — is a fact about the
 * request or the account, and no number of retries changes a fact.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 408 || err.status === 429 || err.status >= 500;
  if (err instanceof Error && err.name === "AbortError") return false; // deliberate, not a failure
  const text = `${err instanceof Error ? err.message : String(err)} ${errorCode(err)}`;
  return TRANSIENT_NETWORK.test(text);
}

function errorCode(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : "";
}

/**
 * How long to wait before attempt `attempt` (1-based), in ms. Honors the
 * provider's `Retry-After` when it sent one — it knows its own rate window
 * better than our backoff curve does — clamped so a hostile or stale header
 * can't wedge the session for an hour. Otherwise exponential-ish with jitter.
 */
export function retryDelayMs(err: unknown, attempt: number, maxMs = 30_000): number {
  if (err instanceof HttpError && err.retryAfter) {
    const seconds = Number(err.retryAfter);
    // `Retry-After` is either delta-seconds or an HTTP date.
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(err.retryAfter) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, maxMs);
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), maxMs); // 1s, 2s, 4s, …
  return Math.round(base * (0.75 + Math.random() * 0.5)); // ±25% jitter, so parallel sessions don't sync up
}
