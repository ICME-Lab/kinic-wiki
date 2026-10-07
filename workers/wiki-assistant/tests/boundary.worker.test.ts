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
  await bindings.ASSISTANT_DB.exec(
    (env as Env & { TEST_CHARGE_MIGRATION: string }).TEST_CHARGE_MIGRATION,
  );
});
const origin = "https://wiki.kinic.xyz";
it("loads metadata without history and decrypts only requested revision-bound pages", async () => {
  const principal = crypto.randomUUID();
  const store = new AssistantStore(bindings);
  const user = await new AssistantUser(bindings, principal).initialize();
  const now = Date.now(), id = crypto.randomUUID();
  user["state"].conversation = {
    id, authId: "page-owner", principal, databaseId: "db", scope: "database",
    native: true, nativeTextProvider: "deepseek", format: 3,
    sessionId: null, generation: 0, pending: null, activity: now, seen: now,
    status: "ready", error: null, transcripts: [], history: [], delegations: [], deferred: null,
    utterances: [{ id: "legacy", role: "user", text: "last item", voiceId: "retired", events: [], end: 0 }],
    messages: Array.from({ length: 23 }, (_, index) => ({
      requestId: crypto.randomUUID(), question: "question " + index,
      voice: false, answer: null, error: null, kind: null, trace: null,
    })),
  };
  await user["save"]();
  const decode = vi.spyOn(store, "decode");
  const metadata = await store.load(principal, false);
  expect(metadata.state.conversation!.messages).toEqual([]);
  expect(decode).toHaveBeenCalledTimes(1);
  decode.mockClear();
  const c = metadata.state.conversation!;
  const page = await store.historyPage(principal, c, metadata.revision, 10);
  expect(decode).toHaveBeenCalledTimes(10);
  expect(page.messages.map((item) => item.question)).toEqual(Array.from({ length: 10 }, (_, i) => "question " + (i + 10)));
  expect(page.nextCursor).toBe("20");
  const last = await store.historyPage(principal, c, metadata.revision, 20);
  expect(last.messages).toHaveLength(3);
  expect(last.utterances).toEqual([{ id: "legacy", role: "user", text: "last item" }]);
  expect(last.nextCursor).toBeNull();
  await store.touch(principal, id);
  expect((await store.load(principal, false)).revision).toBe(metadata.revision);
  await store.schedule(principal, id, metadata.revision, 123);
  expect((await store.db.prepare("SELECT next_attempt FROM assistant_users WHERE principal=?").bind(principal).first<{ next_attempt: number }>())?.next_attempt).toBe(123);
  await expect(store.historyPage(principal, c, metadata.revision, 25)).rejects.toThrow("invalid_cursor");
  await user["save"]();
  await store.schedule(principal, id, metadata.revision, 456);
  expect((await store.db.prepare("SELECT next_attempt FROM assistant_users WHERE principal=?").bind(principal).first<{ next_attempt: number }>())?.next_attempt).not.toBe(456);
  // Internal commits preserve the view and its pages, even after restart.
  expect((await store.historyPage(principal, c, metadata.revision, 0)).revision).toBe(metadata.revision);
  expect((await store.load(principal, false)).state.conversation!.viewRevision).toBe(metadata.revision);
  user["state"].conversation!.messages[0].error = "turn_timeout";
  await user["save"]();
  await expect(store.historyPage(principal, c, metadata.revision, 0)).rejects.toThrow("stale_state");
  await store.requestEnd(principal, c.authId, id, now);
  await expect(store.historyPage(principal, c, metadata.revision, 0)).rejects.toThrow("stale_state");
  decode.mockRestore();
});
describe("assistant HTTP and D1 authentication boundary", () => {
  it.each(["/voice", "/voice/quote", "/voice/connected", "/voice/stop"])(
    "returns 404 for retired native voice route %s before authentication or configuration",
    async (path) => {
      const response = await SELF.fetch("https://assistant/api/assistant/native" + path, {
        method: path === "/voice/quote" ? "GET" : "POST",
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    },
  );

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
  it("ignores legacy Live cleanup jobs without contacting providers or retrying", async () => {
    const id = "live:" + crypto.randomUUID();
    await bindings.ASSISTANT_DB.prepare("INSERT INTO assistant_jobs(id,principal,conversation_id,kind,state,data,next_attempt,attempts,created_at) VALUES (?,?,?,'live','pending',?,0,0,0)")
      .bind(id, "retired-owner", "retired-conversation", JSON.stringify({ providerId: null, requestId: "retired-request" })).run();
    await sweep(bindings);
    expect(await bindings.ASSISTANT_DB.prepare("SELECT state,attempts,next_attempt FROM assistant_jobs WHERE id=?").bind(id).first())
      .toEqual({ state: "pending", attempts: 0, next_attempt: 0 });
    await bindings.ASSISTANT_DB.prepare("DELETE FROM assistant_jobs WHERE id=?").bind(id).run();
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
      body: '{"consent":"2026-09-22"}',
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
    format: 3,
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

it("persists an owner-bound text end across invocations", async () => {
  const principal = crypto.randomUUID();
  const user = await new AssistantUser(bindings, principal).initialize();
  const now = Date.now(), id = crypto.randomUUID();
  user["state"].conversation = {
    id, authId: "text-owner", principal, databaseId: "db", scope: "database",
    native: true, nativeTextProvider: "deepseek", format: 3,
    sessionId: null, generation: 0, pending: null, activity: now, seen: now,
    status: "ready", error: null, messages: [], transcripts: [], history: [],
    utterances: [], delegations: [], deferred: null,
  };
  await user["save"]();
  const store = new AssistantStore(bindings);
  expect(await store.requestEnd(principal, "wrong-owner", id, now)).toBe(false);
  expect((await store.load(principal)).state.endRequested).toBeUndefined();
  expect(await store.requestEnd(principal, "text-owner", id, now)).toBe(true);
  expect((await store.load(principal)).state.endRequested).toBe(now);
  const next = await new AssistantUser(bindings, principal).initialize();
  expect(next["state"].conversation).toBeNull();
});
