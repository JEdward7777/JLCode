import { describe, it, expect } from "vitest";
import { createServer } from "../src/server/server";
import { echoDriver } from "../src/session/fake";
import type { ModelConfig } from "../src/config/types";

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

function makeApp() {
  return createServer({ config, driver: echoDriver(), version: "0.0.0" }).app;
}

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe("dev server", () => {
  it("reports health", async () => {
    const res = await makeApp().request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("starts a thread and retains it across calls", async () => {
    const app = makeApp();
    const first = await post(app, "/chat", { text: "hello" });
    expect(first.status).toBe(200);
    expect(first.json.reply).toBe("You said: hello");
    const id = first.json.sessionId as string;

    const second = await post(app, "/chat", { text: "again", sessionId: id });
    expect(second.json.sessionId).toBe(id);

    const view = await app.request(`/session/${id}`);
    const entries = (await view.json()).entries as Array<{ type: string }>;
    // user, assistant, user, assistant — the thread was retained.
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("rejects an empty message and an unknown session", async () => {
    const app = makeApp();
    expect((await post(app, "/chat", { text: "" })).status).toBe(400);
    expect((await post(app, "/chat", { text: "hi", sessionId: "nope" })).status).toBe(404);
  });
});
