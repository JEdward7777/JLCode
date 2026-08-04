import { describe, it, expect, afterEach } from "vitest";
import { createServer as createRawServer, type Server as NetServer } from "node:net";
import type { Server } from "node:http";
import { startNodeServer, PORT_SCAN_COUNT } from "../src/server/node-adapter";

/**
 * A busy port must not be fatal for the *default* port — `serve` walks to the
 * next free one, and hands the choice to the OS if the whole block is taken.
 * An explicitly requested port still fails loudly (that's the whole point of
 * having asked for it).
 */

const HOST = "127.0.0.1";
const ok = () => new Response("ok");

const occupied: NetServer[] = [];
const started: Server[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => new Promise((r) => s.close(r))));
  await Promise.all(occupied.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Bind a plain socket so the port is genuinely taken. */
function occupy(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createRawServer();
    server.once("error", reject);
    server.listen(port, HOST, () => {
      occupied.push(server);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

/** `count` consecutive busy ports. Retries: another process may hold one of the
 *  ports just above our base, which would make the block non-contiguous. */
async function occupyBlock(count: number): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = await occupy(0);
    try {
      for (let i = 1; i < count; i++) await occupy(base + i);
      return base;
    } catch {
      await Promise.all(occupied.splice(0).map((s) => new Promise((r) => s.close(r))));
    }
  }
  throw new Error("could not reserve a contiguous port block");
}

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

describe("startNodeServer port fallback", () => {
  it("moves to the next free port when the default is taken", async () => {
    const taken = await occupy(0);
    const server = await startNodeServer(ok, { host: HOST, port: taken, fallback: true });
    started.push(server);
    const bound = portOf(server);
    expect(bound).toBeGreaterThan(taken);
    expect(bound).toBeLessThanOrEqual(taken + PORT_SCAN_COUNT - 1);
  });

  it("still serves requests on the port it landed on", async () => {
    const taken = await occupy(0);
    const server = await startNodeServer(ok, { host: HOST, port: taken, fallback: true });
    started.push(server);
    const res = await fetch(`http://${HOST}:${portOf(server)}/`);
    expect(await res.text()).toBe("ok");
  });

  it("lets the OS pick when the whole scanned block is busy", async () => {
    const base = await occupyBlock(PORT_SCAN_COUNT);
    const server = await startNodeServer(ok, { host: HOST, port: base, fallback: true });
    started.push(server);
    const bound = portOf(server);
    expect(bound).toBeGreaterThan(0);
    expect(bound < base || bound > base + PORT_SCAN_COUNT - 1).toBe(true);
  });

  it("fails loudly on a busy port that was asked for by name", async () => {
    const taken = await occupy(0);
    await expect(startNodeServer(ok, { host: HOST, port: taken })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  it("binds the requested port when it is free", async () => {
    const free = await occupy(0);
    await new Promise((r) => occupied.pop()!.close(r)); // release it again
    const server = await startNodeServer(ok, { host: HOST, port: free });
    started.push(server);
    expect(portOf(server)).toBe(free);
  });
});
