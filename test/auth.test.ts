import { describe, it, expect } from "vitest";
import { createServer } from "../src/server/server";
import { ConversationStore } from "../src/persist/conversation-store";
import { echoDriver } from "../src/session/fake";
import { Session } from "../src/session/session";
import type { ModelConfig } from "../src/config/types";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  hashPassword,
  verifyPassword,
  signCookie,
  verifyCookie,
  parseCookies,
  generatePassword,
  createAuthGuard,
  type AuthSecrets,
} from "../src/server/auth";

const config: ModelConfig = {
  id: "cfg_x",
  name: "Test",
  openRouterKey: "sk",
  model: "m",
  defaultMode: "code",
  defaultApproval: "manual",
  createdAt: "",
  updatedAt: "",
};

describe("auth crypto (D-40)", () => {
  it("hashes and verifies a password (constant-time), rejects wrong ones", () => {
    const { salt, hash } = hashPassword("hunter2");
    expect(verifyPassword("hunter2", salt, hash)).toBe(true);
    expect(verifyPassword("Hunter2", salt, hash)).toBe(false);
    expect(verifyPassword("", salt, hash)).toBe(false);
    // Fresh salt each time → different hash for the same password.
    expect(hashPassword("hunter2").hash).not.toBe(hash);
  });

  it("signs and verifies a session cookie; tamper and expiry fail", () => {
    const secret = "s3cr3t";
    const value = signCookie(secret, Date.now() + 10_000);
    expect(verifyCookie(secret, value)).toBe(true);
    expect(verifyCookie("other-secret", value)).toBe(false); // wrong key
    expect(verifyCookie(secret, value + "x")).toBe(false); // tampered sig
    expect(verifyCookie(secret, "garbage")).toBe(false); // malformed
    const expired = signCookie(secret, Date.now() - 1);
    expect(verifyCookie(secret, expired)).toBe(false); // past exp
  });

  it("parses cookie headers and generates a typeable password", () => {
    expect(parseCookies("a=1; jlcode_session=xyz; b=2").jlcode_session).toBe("xyz");
    expect(parseCookies(undefined)).toEqual({});
    const pw = generatePassword();
    expect(pw).toMatch(/^[A-Z0-9-]+$/);
    expect(pw).not.toMatch(/[IO01]/); // unambiguous alphabet
    expect(generatePassword()).not.toBe(pw);
  });
});

describe("auth guard on the server (D-40)", () => {
  let storeDir: string;
  let store: ConversationStore;

  function secretsFor(pw: string): AuthSecrets {
    const { salt, hash } = hashPassword(pw);
    return { passwordHash: hash, salt, cookieSecret: "test-cookie-secret", updatedAt: "" };
  }

  function guardedApp(oneHitToken?: string) {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-auth-"));
    store = new ConversationStore(storeDir);
    const secrets = secretsFor("open-sesame");
    return createServer({
      resolveConfig: () => config,
      newSession: (c, conversation) => new Session({ config: c, driver: echoDriver(), conversation }),
      store,
      workingDir: "/work/test",
      version: "0.0.0",
      auth: createAuthGuard({ secrets, oneHitToken }),
    }).app;
  }

  it("blocks API calls without a cookie (401) and serves the login page to browsers", async () => {
    const app = guardedApp();
    const api = await app.request("/health");
    expect(api.status).toBe(401);
    expect((await api.json()).error).toMatch(/authentication/i);

    const nav = await app.request("/", { headers: { accept: "text/html" } });
    expect(nav.status).toBe(401);
    expect(nav.headers.get("content-type")).toContain("text/html");
    expect(await nav.text()).toContain("Sign in");
    await store.close();
  });

  it("rejects a bad password and accepts the right one, then the cookie unlocks the API", async () => {
    const app = guardedApp();
    const bad = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(bad.status).toBe(401);

    const ok = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "open-sesame" }),
    });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("jlcode_session=");
    expect(setCookie).toContain("HttpOnly");

    const cookie = setCookie.split(";")[0]!; // jlcode_session=<value>
    const health = await app.request("/health", { headers: { cookie } });
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
    await store.close();
  });

  it("exchanges a one-hit token for a cookie once, then the token is spent", async () => {
    const app = guardedApp("SETUP-TOKEN");
    const res = await app.request("/?token=SETUP-TOKEN", { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("jlcode_session=");

    // The cookie it minted works.
    const cookie = setCookie.split(";")[0]!;
    expect((await app.request("/health", { headers: { cookie } })).status).toBe(200);

    // The token is single-use: a second exchange no longer authenticates.
    const again = await app.request("/?token=SETUP-TOKEN", { headers: { accept: "text/html" } });
    expect(again.status).toBe(401);
    await store.close();
  });
});

describe("no auth guard = open (localhost bind)", () => {
  it("serves without any credential when no auth dep is passed", async () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlcode-noauth-"));
    const store = new ConversationStore(storeDir);
    const app = createServer({
      resolveConfig: () => config,
      newSession: (c, conversation) => new Session({ config: c, driver: echoDriver(), conversation }),
      store,
      workingDir: "/work/test",
      version: "0.0.0",
    }).app;
    expect((await app.request("/health")).status).toBe(200);
    await store.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });
});
