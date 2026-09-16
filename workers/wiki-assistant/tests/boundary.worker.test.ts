import { env, SELF } from "cloudflare:test";
import { AssistantAuth } from "../src/auth";
import { AssistantStore } from "../src/store";
import { AssistantUser } from "../src/user";
import { Leases } from "../src/leases";
import { sweep } from "../src/reaper";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
const bindings = env as Env;
beforeAll(async () => {
  await bindings.ASSISTANT_DB.exec(
    (env as Env & { TEST_MIGRATION: string }).TEST_MIGRATION,
  );
});
const origin = "https://wiki.kinic.xyz";
describe("assistant HTTP and D1 authentication boundary", () => {
  it("discards only fenced provider-free Agent intents", async () => {
    const store = new AssistantStore(bindings);
    const leases = new Leases(bindings.ASSISTANT_DB);
    const conversation = crypto.randomUUID();
    const valid = await leases.claim("question", conversation);
    expect(valid).not.toBeNull();

    const removable = "agent:" + crypto.randomUUID();
    await store.intent(removable, "intent-owner", conversation, "agent", {
      providerId: null,
      requestId: "removable",
    });
    expect(await store.discardUncreatedAgentIntent(removable, valid!)).toBe(
      true,
    );
    expect(
      await bindings.ASSISTANT_DB.prepare(
        "SELECT 1 FROM assistant_jobs WHERE id=?",
      )
        .bind(removable)
        .first(),
    ).toBeNull();

    const known = "agent:" + crypto.randomUUID();
    await store.intent(known, "intent-owner", conversation, "agent", {
      providerId: null,
      requestId: "known",
    });
    await store.created(known, "provider-session");
    expect(await store.discardUncreatedAgentIntent(known, valid!)).toBe(false);

    const mismatched = "agent:" + crypto.randomUUID();
    await store.intent(mismatched, "intent-owner", conversation, "agent", {
      providerId: null,
      requestId: "mismatched",
    });
    const otherLease = await leases.claim("question", crypto.randomUUID());
    expect(otherLease).not.toBeNull();
    expect(
      await store.discardUncreatedAgentIntent(mismatched, otherLease!),
    ).toBe(false);
    expect(await store.discardUncreatedAgentIntent(mismatched, valid!)).toBe(
      true,
    );
    await leases.release(otherLease!);

    const stale = "agent:" + crypto.randomUUID();
    await store.intent(stale, "intent-owner", conversation, "agent", {
      providerId: null,
      requestId: "stale",
    });
    await bindings.ASSISTANT_DB.prepare(
      "UPDATE assistant_leases SET expires_at=0 WHERE scope='question' AND id=?",
    )
      .bind(conversation)
      .run();
    expect(await store.discardUncreatedAgentIntent(stale, valid!)).toBe(false);
    const replacement = await leases.claim("question", conversation);
    expect(replacement).not.toBeNull();
    expect(await store.discardUncreatedAgentIntent(stale, valid!)).toBe(false);
    expect(
      await store.discardUncreatedAgentIntent(stale, replacement!),
    ).toBe(true);

    await bindings.ASSISTANT_DB.prepare(
      "DELETE FROM assistant_jobs WHERE id=?",
    )
      .bind(known)
      .run();
    await leases.release(replacement!);
  });
  it("keeps an uncertain Live create without storing or replaying SDP", async () => {
    const id = "live:" + crypto.randomUUID();
    const store = new AssistantStore(bindings);
    await store.intent(id, "replay-owner", "replay-conversation", "live", {
      providerId: null,
      requestId: "replay-request",
      voiceId: "replay-voice",
    });
    await bindings.ASSISTANT_DB.prepare(
      "UPDATE assistant_jobs SET state='pending' WHERE id=?",
    )
      .bind(id)
      .run();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await sweep(bindings);
    const row = await bindings.ASSISTANT_DB.prepare(
      "SELECT conversation_id,data,state,attempts,next_attempt FROM assistant_jobs WHERE id=?",
    )
      .bind(id)
      .first<{
        conversation_id: string;
        data: string;
        state: string;
        attempts: number;
        next_attempt: number;
      }>();
    expect(row).toMatchObject({
      conversation_id: "replay-conversation",
      state: "pending",
      attempts: 1,
    });
    expect(JSON.parse(row!.data)).toEqual({
      providerId: null,
      requestId: "replay-request",
      voiceId: "replay-voice",
    });
    expect(row!.next_attempt).toBeGreaterThan(Date.now());
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("assistant_live_creation_unresolved"),
    );
    error.mockRestore();
    await bindings.ASSISTANT_DB.prepare("DELETE FROM assistant_jobs WHERE id=?")
      .bind(id)
      .run();
  });
  it("closes and completes a known Live job once", async () => {
    const id = "live:" + crypto.randomUUID();
    await new AssistantStore(bindings).intent(
      id,
      "known-owner",
      "known-conversation",
      "live",
      {
        providerId: "live-provider",
        requestId: "known-request",
        voiceId: "known-voice",
      },
    );
    await bindings.ASSISTANT_DB.prepare(
      "UPDATE assistant_jobs SET state='pending' WHERE id=?",
    )
      .bind(id)
      .run();
    const closed: string[] = [];
    const close = async (_env: Env, providerId: string) => {
      closed.push(providerId);
    };
    await sweep(bindings, close);
    await sweep(bindings, close);
    expect(closed).toEqual(["live-provider"]);
    expect(
      await bindings.ASSISTANT_DB.prepare(
        "SELECT 1 FROM assistant_jobs WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it("does not complete a known Live job after its lease is superseded", async () => {
    const id = "live:" + crypto.randomUUID();
    await new AssistantStore(bindings).intent(
      id,
      "stale-owner",
      "stale-conversation",
      "live",
      {
        providerId: "stale-provider",
        requestId: "stale-request",
        voiceId: "stale-voice",
      },
    );
    await bindings.ASSISTANT_DB.prepare(
      "UPDATE assistant_jobs SET state='pending' WHERE id=?",
    )
      .bind(id)
      .run();
    await sweep(bindings, async () => {
      await bindings.ASSISTANT_DB.prepare(
        "UPDATE assistant_leases SET expires_at=0 WHERE scope='cleanup' AND id=?",
      )
        .bind(id)
        .run();
      expect(
        await new Leases(bindings.ASSISTANT_DB).claim("cleanup", id),
      ).not.toBeNull();
    });
    expect(
      await bindings.ASSISTANT_DB.prepare(
        "SELECT state FROM assistant_jobs WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({ state: "pending" });
    await bindings.ASSISTANT_DB.prepare("DELETE FROM assistant_jobs WHERE id=?")
      .bind(id)
      .run();
  });
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
      body: '{"consent":"2026-09-16"}',
    });
    expect(response.status).toBe(403);
  });
  it("stores only encrypted registration keys and binds completion to initiating cookie", async () => {
    const id = crypto.randomUUID();
    const stub = new AssistantAuth(bindings, id);
    const pending = await stub.begin(id);
    const record = await new AssistantStore(bindings).auth<
      Record<string, unknown>
    >(id);
    expect(JSON.stringify(record)).not.toContain(pending.token);
    expect(JSON.stringify(record)).not.toContain(pending.state);
    expect(record?.registration).toHaveProperty("algorithm", "AES-GCM");
    await expect(stub.complete("wrong", pending.state, "bad")).rejects.toThrow(
      "authentication_required",
    );
    await expect(stub.complete(pending.token, "wrong", "bad")).rejects.toThrow(
      "invalid_auth_state",
    );
  });
  it("claims authentication once and removes expired grants without a client", async () => {
    const id = crypto.randomUUID(),
      auth = new AssistantAuth(bindings, id),
      store = new AssistantStore(bindings);
    const pending = await auth.begin(id);
    expect(
      (await Promise.all([store.claimAuth(id), store.claimAuth(id)])).filter(
        Boolean,
      ),
    ).toHaveLength(1);
    await bindings.ASSISTANT_DB.prepare(
      "UPDATE assistant_auth SET expires_at=0 WHERE id=?",
    )
      .bind(id)
      .run();
    await sweep(bindings);
    expect(await auth.ownerForCleanup(pending.token)).toBeNull();
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

it("fences stale writes and deletes encrypted content with cleanup intent atomically", async () => {
  const principal = crypto.randomUUID(),
    store = new AssistantStore(bindings);
  const user = await new AssistantUser(bindings, principal).initialize();
  const now = Date.now(),
    id = crypto.randomUUID();
  user["state"].conversation = {
    id,
    authId: "unused",
    principal,
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
    format: 2,
    transcripts: [],
    history: [],
    utterances: [],
    delegations: [],
    deferred: null,
  };
  await user["save"]();
  const old = await store.load(principal);
  await store.intent("agent:" + id, principal, id, "agent", {
    providerId: null,
    requestId: "req",
  });
  user["state"].conversation!.transcripts.push({
    text: "private words",
    role: "user",
    start: 0,
    end: 1,
  });
  await user["save"]();
  expect(
    JSON.stringify(
      await bindings.ASSISTANT_DB.prepare(
        "SELECT data FROM assistant_users WHERE principal=?",
      )
        .bind(principal)
        .first(),
    ),
  ).not.toContain("private words");
  await expect(
    store.save(principal, old.revision, old.state, now),
  ).rejects.toThrow("stale_state");
  user["state"].conversation!.activity = now - 600000;
  await user["save"]();
  await user.tick(true);
  expect((await store.load(principal)).state.conversation).toBeNull();
  await store.created("agent:" + id, "late-provider-id");
  expect(
    await bindings.ASSISTANT_DB.prepare(
      "SELECT state FROM assistant_jobs WHERE id=?",
    )
      .bind("agent:" + id)
      .first(),
  ).toEqual({ state: "pending" });
  expect(
    await bindings.ASSISTANT_DB.prepare(
      "SELECT data FROM assistant_users WHERE principal=?",
    )
      .bind(principal)
      .first(),
  ).toEqual({ data: null });
});

describe("native Bearer boundary", () => {
  it("does not accept Web cookies or URL tokens for native events", async () => {
    const id = crypto.randomUUID();
    const pending = await new AssistantAuth(bindings, id).beginNative(
      id,
      "db",
      "owner",
    );
    const token = id + "." + pending.token;
    for (const suffix of ["", "&token=" + token]) {
      const response = await SELF.fetch(
        origin +
          "/api/assistant/native/events?conversationId=" +
          crypto.randomUUID() +
          suffix,
        {
          headers: {
            cookie: "__Host-kinic-assistant=" + token,
            upgrade: "websocket",
          },
        },
      );
      expect(response.status).toBe(401);
    }
  });
  it("accepts a header bearer at the transport boundary but rejects a pending grant", async () => {
    const id = crypto.randomUUID();
    const pending = await new AssistantAuth(bindings, id).beginNative(
      id,
      "db",
      "owner",
    );
    const response = await SELF.fetch(
      origin +
        "/api/assistant/native/conversation?conversationId=" +
        crypto.randomUUID(),
      {
        headers: { authorization: "Bearer " + id + "." + pending.token },
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication_required" });
  });
});

it("rejects an expired owner's write even when its conversation revision still matches", async () => {
  const principal = crypto.randomUUID(),
    store = new AssistantStore(bindings),
    leases = new Leases(bindings.ASSISTANT_DB);
  const state = (await store.load(principal)).state;
  const revision = await store.save(principal, 0, state, Date.now());
  const old = await leases.claim("question", principal, Date.now() - 46000);
  expect(old).not.toBeNull();
  const next = await leases.claim("question", principal);
  expect(next?.generation).toBe(2);
  state.questions = 49;
  await expect(
    store.save(principal, revision, state, Date.now(), old!),
  ).rejects.toThrow("stale_state");
  expect((await store.load(principal)).state.questions).toBe(0);
});
it("deduplicates control commands and encrypts their recorded responses", async () => {
  const store = new AssistantStore(bindings),
    id = crypto.randomUUID(),
    request = crypto.randomUUID();
  expect((await store.command(id, request, "hash")).fresh).toBe(true);
  expect((await store.command(id, request, "hash")).fresh).toBe(false);
  await store.commandResult(id, request, {
    status: 200,
    body: { sdp: "private SDP" },
  });
  expect((await store.command(id, request, "hash")).response?.body).toEqual({
    sdp: "private SDP",
  });
  await expect(store.command(id, request, "different")).rejects.toThrow(
    "request_id_conflict",
  );
  expect(
    JSON.stringify(
      await bindings.ASSISTANT_DB.prepare(
        "SELECT response FROM assistant_commands WHERE conversation_id=?",
      )
        .bind(id)
        .first(),
    ),
  ).not.toContain("private SDP");
});

it("persists a stop before the handling invocation disappears and ignores old voice IDs", async () => {
  const principal = crypto.randomUUID(),
    user = await new AssistantUser(bindings, principal).initialize(),
    store = new AssistantStore(bindings);
  const now = Date.now(),
    id = crypto.randomUUID(),
    voiceId = crypto.randomUUID();
  user["state"].conversation = {
    id,
    authId: "auth",
    principal,
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
    format: 2,
    transcripts: [],
    history: [],
    utterances: [],
    delegations: [],
    deferred: null,
    live: {
      id: "live-provider",
      stopping: false,
      usage: {
        chargeId: voiceId,
        started: now,
        reserved: 60,
        usageDay: "2026-09-14",
        settled: false,
      },
    },
  };
  user["state"].charges = [
    {
      id: voiceId,
      databaseId: "db",
      principal,
      rate: "1",
      reserved: 60,
      started: now,
      stopped: null,
      expires: now + 86400000,
      confirmed: 0,
    },
  ];
  await user["save"]();
  expect(
    await store.requestStop(principal, "auth", id, "old-voice", now + 10000),
  ).toBe(false);
  expect(
    await store.requestStop(principal, "auth", id, voiceId, now + 10000),
  ).toBe(true);
  await store.requestStop(principal, "auth", id, voiceId, now + 20000);
  const recovered = (await new AssistantStore(bindings).load(principal)).state;
  expect(recovered.conversation?.live?.stopping).toBe(true);
  expect(recovered.charges[0].stopped).toBe(now + 10000);
});
