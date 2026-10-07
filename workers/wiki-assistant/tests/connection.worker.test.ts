import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import type { KinicReader } from "../src/kinic";

it("keeps the connection object internal and rejects requests without an authenticated owner", async () => {
  const connection = (env as Env).ASSISTANT_CONNECTION.getByName(crypto.randomUUID());
  expect((await connection.fetch("https://assistant/api/assistant/events")).status).toBe(401);
  expect((await connection.fetch("https://assistant/api/assistant/questions", {
    headers: { "x-assistant-principal": "owner", "x-assistant-auth-id": "auth" },
  })).status).toBe(404);
});

it("runs authenticated heartbeat control through the durable connection", async () => {
  const { AssistantUser } = await import("../src/user");
  const { vi } = await import("vitest");
  const bindings = env as Env & { TEST_MIGRATION: string; TEST_CHARGE_MIGRATION: string };
  await bindings.ASSISTANT_DB.exec(bindings.TEST_MIGRATION);
  await bindings.ASSISTANT_DB.exec(bindings.TEST_CHARGE_MIGRATION);
  const principal = crypto.randomUUID(), id = crypto.randomUUID(), now = Date.now();
  const user = await new AssistantUser(bindings, principal).initialize();
  user["state"].conversation = {
    id, authId: "auth", principal, databaseId: "db", scope: "database",
    native: true, nativeTextProvider: "deepseek", format: 3,
    sessionId: null, generation: 0, pending: null, activity: now, seen: now,
    status: "ready", error: null, transcripts: [], history: [], delegations: [], deferred: null,
    utterances: [], messages: [],
  };
  await user["save"]();
  const authorize = vi.fn(async () => {});
  const reader = vi.spyOn(AssistantUser.prototype as unknown as { reader: () => Promise<KinicReader> }, "reader")
    .mockResolvedValue({ authorize } as unknown as KinicReader);
  let socket: WebSocket | undefined;
  try {
    const response = await bindings.ASSISTANT_CONNECTION.getByName(principal).fetch(`https://assistant/api/assistant/events?conversationId=${id}`, {
      headers: { Upgrade: "websocket", "x-assistant-principal": principal, "x-assistant-auth-id": "auth" },
    });
    expect(response.status).toBe(101);
    socket = response.webSocket!;
    const nextMessage = () => new Promise<Record<string, unknown>>(resolve => socket!.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
    const snapshot = nextMessage();
    socket.accept();
    expect(await snapshot).toMatchObject({ type: "snapshot", id });
    for (let i = 0; i < 3; i++) {
      const reply = nextMessage(), requestId = crypto.randomUUID();
      socket.send(JSON.stringify({ type: "heartbeat", requestId }));
      expect(await reply).toEqual({ type: "heartbeat", requestId });
    }
    expect(authorize).toHaveBeenCalledTimes(4);
  } finally {
    socket?.close();
    reader.mockRestore();
  }
});
