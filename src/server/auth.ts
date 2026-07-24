/**
 * Serve-mode auth (D-40, P5f). Localhost binds serve auth-free; an **outward**
 * (non-loopback) bind requires a password. The password is kept **hashed**
 * (scrypt, built-in — no native dep, D-25) in the config store; a successful
 * login (or a one-hit setup URL) sets an **httpOnly, signed session cookie**.
 *
 * Everything here is pure `node:crypto` + a small Hono guard so the runtime
 * stays dependency-light. The cookie is stateless: a signed `{exp}` payload
 * verified with a persisted HMAC secret, so sessions survive a server restart
 * (Joshua's call).
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";

/** Persisted auth material (lives in the config store's `auth` block). */
export interface AuthSecrets {
  /** scrypt hash of the password, hex. */
  passwordHash: string;
  /** Per-password random salt, hex. */
  salt: string;
  /** HMAC key for signing session cookies, hex (persisted → cookies survive restart). */
  cookieSecret: string;
  updatedAt: string;
}

const SCRYPT_KEYLEN = 32;
const COOKIE_NAME = "jlcode_session";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week

/** Hash a password with a fresh (or given) salt. */
export function hashPassword(password: string, salt: string = randomBytes(16).toString("hex")): {
  salt: string;
  hash: string;
} {
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { salt, hash };
}

/** Constant-time verify of a password against a stored salt+hash. */
export function verifyPassword(password: string, salt: string, hash: string): boolean {
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** A URL/cookie-safe random token (the one-hit setup token, cookie secret, …). */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** A human-typeable generated password: groups from an unambiguous alphabet. */
export function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  const raw = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += "-";
    out += alphabet[raw[i]! % alphabet.length];
  }
  return out; // e.g. XK4M-9QTP-...-....
}

/** Sign a session cookie value: `<exp>.<hmac(exp)>` (base64url). */
export function signCookie(secret: string, expMs: number): string {
  const payload = Buffer.from(String(expMs)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify a signed session cookie: intact signature and not expired. */
export function verifyCookie(secret: string, value: string, now = Date.now()): boolean {
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expMs = Number(Buffer.from(payload, "base64url").toString());
  return Number.isFinite(expMs) && expMs > now;
}

/** Parse a Cookie header into a name→value map. */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** The guard installed on the Hono app when serving outward. */
export interface AuthGuard {
  /** Register the guard middleware + `/auth/login` before the app's routes. */
  install(app: Hono): void;
}

export interface AuthGuardOptions {
  secrets: AuthSecrets;
  /** One-time setup token embedded in the printed URL; consumed on first use. */
  oneHitToken?: string;
  /** Session lifetime; default one week. */
  ttlMs?: number;
}

function setCookieHeader(value: string, ttlMs: number): string {
  const maxAge = Math.floor(ttlMs / 1000);
  // No `Secure`: an outward bind may be plain HTTP behind Joshua's TLS proxy, and
  // Secure would drop the cookie there. HttpOnly + SameSite is the guard.
  return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}`;
}

function loginPage(error?: string): string {
  const banner = error ? `<p class="err">${error}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JLCode — sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px system-ui, sans-serif; margin: 0; min-height: 100vh;
    display: grid; place-items: center; background: #f6f7f9; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #16181c; color: #e8e8e8; } }
  form { background: canvas; padding: 28px; border-radius: 12px; width: 300px;
    box-shadow: 0 6px 30px rgba(0,0,0,.12); display: grid; gap: 14px; }
  h1 { font-size: 18px; margin: 0; }
  input { font: inherit; padding: 10px 12px; border-radius: 8px;
    border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; }
  button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 0;
    background: #3b6ef6; color: #fff; cursor: pointer; }
  button:hover { background: #2f5fe0; }
  .err { color: #d33; margin: 0; font-size: 13px; }
</style></head><body>
<form id="f">
  <h1>JLCode</h1>
  ${banner}
  <input id="pw" type="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
  <p class="err" id="msg"></p>
</form>
<script>
  const f = document.getElementById('f'), msg = document.getElementById('msg');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    const res = await fetch('/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value }) });
    if (res.ok) location.replace('/');
    else msg.textContent = 'Incorrect password.';
  });
</script></body></html>`;
}

/** Build the outward-bind auth guard (D-40). Call `install(app)` before routes. */
export function createAuthGuard(opts: AuthGuardOptions): AuthGuard {
  const { secrets } = opts;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const oneHit = new Set<string>();
  if (opts.oneHitToken) oneHit.add(opts.oneHitToken);

  const wantsHtml = (c: Context): boolean => (c.req.header("accept") ?? "").includes("text/html");

  const guard: MiddlewareHandler = async (c, next) => {
    const url = new URL(c.req.url);

    // The login POST must reach its handler unauthenticated.
    if (c.req.method === "POST" && url.pathname === "/auth/login") return next();

    // One-hit setup URL: exchange the token for a cookie, then redirect to the
    // clean path so the token doesn't linger in history/referer.
    const token = url.searchParams.get("token");
    if (token && oneHit.has(token)) {
      oneHit.delete(token);
      const cookie = signCookie(secrets.cookieSecret, Date.now() + ttlMs);
      return new Response(null, {
        status: 303,
        headers: { Location: url.pathname, "Set-Cookie": setCookieHeader(cookie, ttlMs) },
      });
    }

    // Valid session cookie → allow through.
    const cookies = parseCookies(c.req.header("cookie"));
    const session = cookies[COOKIE_NAME];
    if (session && verifyCookie(secrets.cookieSecret, session)) return next();

    // Unauthenticated: a browser navigation gets the login page; anything else
    // (API/fetch/SSE) gets a 401 so nothing sensitive leaks.
    if (c.req.method === "GET" && wantsHtml(c)) {
      return c.html(loginPage(), 401);
    }
    return c.json({ error: "authentication required" }, 401);
  };

  return {
    install(app: Hono): void {
      app.use("*", guard);
      app.post("/auth/login", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
        if (typeof body.password !== "string" || !verifyPassword(body.password, secrets.salt, secrets.passwordHash)) {
          return c.json({ error: "invalid password" }, 401);
        }
        const cookie = signCookie(secrets.cookieSecret, Date.now() + ttlMs);
        c.header("Set-Cookie", setCookieHeader(cookie, ttlMs));
        return c.json({ ok: true });
      });
    },
  };
}
