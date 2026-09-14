import {
  env,
  SELF,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
const bindings = env as Env;
const origin = "https://wiki.kinic.xyz";
describe("assistant HTTP and durable authentication boundary", () => {
  it("requires authentication for private routes", async () => {
    const response = await SELF.fetch(origin + "/api/assistant/conversations", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });
  it("rejects cross-origin state changes before authentication", async () => {
    const response = await SELF.fetch(origin + "/api/assistant/auth/start", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: '{"consent":"2026-09-14"}',
    });
    expect(response.status).toBe(403);
  });
  it("stores only encrypted registration keys and binds completion to initiating cookie", async () => {
    const id = crypto.randomUUID();
    const stub = bindings.ASSISTANT_AUTH.getByName(id);
    const pending = await stub.begin(id);
    const record = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get<Record<string, unknown>>("auth"),
    );
    expect(JSON.stringify(record)).not.toContain(pending.token);
    expect(JSON.stringify(record)).not.toContain(pending.state);
    expect(record?.registration).toHaveProperty("algorithm", "AES-GCM");
    expect(
      await runInDurableObject(stub, async (instance) => {
        try {
          await instance.complete("wrong", pending.state, "bad");
          return "unexpected";
        } catch (error) {
          return (error as Error).message;
        }
      }),
    ).toBe("authentication_required");
    expect(
      await runInDurableObject(stub, async (instance) => {
        try {
          await instance.complete(pending.token, "wrong", "bad");
          return "unexpected";
        } catch (error) {
          return (error as Error).message;
        }
      }),
    ).toBe("invalid_auth_state");
  });
  it("removes pending authentication on its alarm", async () => {
    const stub = bindings.ASSISTANT_AUTH.getByName(crypto.randomUUID());
    const pending = await stub.begin(crypto.randomUUID());
    await runDurableObjectAlarm(stub);
    expect(await stub.ownerForCleanup(pending.token)).toBeNull();
  });
  it("does not accept a principal as proof of authentication", async () => {
    const response = await SELF.fetch(
      origin +
        "/api/assistant/conversation?conversationId=" +
        crypto.randomUUID(),
      {
        headers: {
          "x-assistant-principal": "fake-owner",
          "x-assistant-auth-id": "fake",
        },
      },
    );
    expect(response.status).toBe(401);
  });
  it("returns a no-store callback with no dynamic credential interpolation", async () => {
    const response = await SELF.fetch(origin + "/api/assistant/callback");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(await response.text()).toContain("history.replaceState");
  });
});

it("preserves the earliest persisted alarm and expires idle state in workerd", async () => {
  const stub = bindings.ASSISTANT_USERS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance, ctx) => {
    const now = Date.now();
    instance["state"].conversation = {
      id: crypto.randomUUID(),
      authId: "unused",
      principal: "owner",
      databaseId: "db",
      scope: "/Knowledge",
      sessionId: null,
      generation: 0,
      pending: null,
      activity: now,
      seen: now,
      status: "ready",
      error: null,
      messages: [],
      live: null,
      transcripts: [],
      delegations: [],
      deferred: null,
    };
    const earlier = now + 1000;
    await ctx.storage.setAlarm(earlier);
    await instance["save"]();
    expect(await ctx.storage.getAlarm()).toBe(earlier);
    instance["state"].conversation!.activity = now - 600000;
    await instance["save"]();
  });
  await runDurableObjectAlarm(stub);
  const current = await runInDurableObject(
    stub,
    async (instance) => instance["state"].conversation,
  );
  expect(current).toBeNull();
});
