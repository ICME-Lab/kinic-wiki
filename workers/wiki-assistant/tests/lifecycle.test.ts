import { AssistantUser } from "../src/user";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { AssistantError, DEFAULT_LIMITS } from "../src/contracts";
import type { Env } from "../src/env";
const mocks = vi.hoisted(() => ({
  deepseek: vi.fn(),
  create: vi.fn(),
  items: vi.fn(),
  retrieve: vi.fn(),
  turn: vi.fn(),
  list: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  authorize: vi.fn(),
  read: vi.fn(),
  discardIntent: vi.fn(),
  route: vi.fn(),
}));
vi.mock("../src/deepseek", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/deepseek")>(),
  runDeepSeekTurn: mocks.deepseek,
}));
vi.mock("../src/openai", () => ({
  client: () => ({
    beta: {
      agents: {
        sessions: {
          retrieve: mocks.retrieve,
          events: { create: mocks.send },
          turns: { retrieve: mocks.turn },
          list: mocks.list,
        },
      },
    },
  }),
  createAgent: mocks.create,
  sessionItems: mocks.items,
  cancelAgent: mocks.cancel,
  deleteAgent: mocks.remove,
  inputText: (
    requestId: string,
    question: string,
    scope: string,
    selectedPath?: string,
    history: unknown[] = [],
  ) =>
    JSON.stringify({
      requestId,
      question,
      scope,
      selectedPath: selectedPath ?? null,
      ...(history.length ? { history } : {}),
    }),
  messageText: (item: { text?: string }) => item.text ?? "",
}));
vi.mock("../src/routing", () => ({
  routeAskAiIntent: mocks.route,
  boundedRoutingHistory: (items: unknown[]) => items.slice(-6),
  clarificationFor: () => "Please clarify.",
}));
vi.mock("@kinic/ii-server/internet-identity", () => ({
  restoreKinicIdentity: () => ({}),
}));
vi.mock("../src/kinic", () => ({
  createReadActor: () => ({}),
  emptyToolState: () => ({
    calls: 0,
    characters: 0,
    evidence: [],
    sources: [],
    readPaths: [],
    discoveredPaths: [],
    jevDurationMs: 0,
    jevRouteDurationMs: 0,
    jevRerankDurationMs: 0,
    inventoryObserved: 0,
    inventoryTruncated: false,
  }),
  KinicReader: class {
    authorize = mocks.authorize;
    manifest = async () => ({});
    constructor(
      _actor: unknown,
      _db: string,
      _scope: string,
      private state: { calls: number; evidence: unknown[] },
    ) {}
    execute = async (name: string, args: unknown) => {
      this.state.calls++;
      return mocks.read(name, args);
    };
  },
}));
vi.mock("../src/auth", () => ({
  requireEnabled: (env: Env) => {
    if (env.ASSISTANT_ENABLED !== "true") throw new Error("disabled");
  },
  AssistantAuth: class {
    async material() {
      return { principal: "owner", material: { appKey: ["a", "b"] } };
    }
  },
}));
vi.mock("../src/leases", () => ({
  RENEW_MS: 10000,
  Leases: class {
    async claim(scope: string, id: string) {
      return {
        scope,
        id,
        owner: "test",
        generation: 1,
        expires_at: Date.now() + 45000,
      };
    }
    async renew() {
      return true;
    }
    async valid() {
      return true;
    }
    async active() {
      return false;
    }
    async release() {}
  },
}));
vi.mock("../src/store", () => ({
  AssistantStore: class {
    private memory: {
      storage: Map<string, unknown>;
      wake: number | null;
      revision: number;
    };
    constructor(env: Env) {
      this.memory = (
        env as unknown as {
          memory: {
            storage: Map<string, unknown>;
            wake: number | null;
            revision: number;
          };
        }
      ).memory;
    }
    db = {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
      }),
    };
    async load(principal: string) {
      return {
        revision: this.memory.revision,
        state: structuredClone(
          this.memory.storage.get("state") ?? {
            principal,
            day: new Date().toISOString().slice(0, 10),
            questions: 0,
            conversation: null,
            cleanup: [],
          },
        ),
      };
    }
    async save(
      _principal: string,
      revision: number,
      state: unknown,
      next: number,
    ) {
      this.memory.storage.set("state", structuredClone(state));
      this.memory.wake = next;
      return (this.memory.revision = revision + 1);
    }
    async intent() {}
    async created() {}
    async discardUncreatedAgentIntent(...args: unknown[]) {
      return mocks.discardIntent(...args);
    }
    async command() { return { fresh: true, response: null }; }
    async commandResult() {}
    async touch() {}
    async canSend() {
      return true;
    }
  },
}));
async function harness(native = false) {
  const storage = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const memory = { storage, wake: null as number | null, revision: 0 };
  const env = {
    ASSISTANT_ENABLED: "true",
    OPENAI_API_KEY: "fake",
    DEEPSEEK_API_KEY: "fake",
    TYPESAFE_API_KEY: "fake",
    ASSISTANT_KEY_ENCRYPTION_KEY: "fake",
    ASSISTANT_DERIVATION_ORIGIN: "origin",
    memory,
  } as unknown as Env;
  const user = await new AssistantUser(env, "owner", (p) =>
    background.push(p),
  ).initialize();
  user["connectionLease"] = {
    scope: "connection",
    id: "test",
    owner: "test",
    generation: 1,
    expires_at: Infinity,
  };
  let id = "";
  const call = async (path: string, body?: unknown, overrideId?: string) =>
    user.fetch(
      new Request(
        "https://wiki.kinic.xyz/api/assistant" +
          path +
          "?conversationId=" +
          (overrideId ?? id),
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "content-type": "application/json",
            "x-assistant-auth-id": "auth",
            "x-assistant-principal": "owner",
            ...(native ? { "x-assistant-client": "native" } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      ),
    );
  const created = await call("/conversations", {
    databaseId: "db",
    scope: "/Knowledge",
    consent: native ? "2026-09-29" : "2026-09-22",
  });
  id = ((await created.json()) as { id: string }).id;
  return {
    user,
    alarmAt: () => memory.wake,
    fireAlarm: async () => {
      memory.wake = null;
      await user.tick();
    },
    call,
    id,
    storage,
    drain: async () => {
      await Promise.all(background.splice(0));
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({ id: "session-1" });
  mocks.items.mockResolvedValue([]);
  mocks.retrieve.mockResolvedValue({
    status: "in_progress",
    required_actions: [],
  });
  mocks.turn.mockResolvedValue({ status: "in_progress" });
  mocks.list.mockImplementation(async function* () {});
  mocks.cancel.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.discardIntent.mockResolvedValue(true);
  mocks.route.mockResolvedValue({ route: "focused_search", durationMs: 3 });
});
const question = () => ({
  requestId: crypto.randomUUID(),
  question: "What is the decision?",
  scope: "/Knowledge",
});
describe("conversation lifecycle", () => {
  it.each(["scope_not_allowed", "tool_not_allowed"])("keeps a native conversation after model input error %s", async (code) => {
    const h = await harness(true);
    const c = h.user["state"].conversation!;
    mocks.deepseek.mockRejectedValueOnce(new AssistantError(code, 400));
    await h.call("/questions", question());
    await h.drain();
    expect(h.user["state"].conversation).toBe(c);
    expect(c.status).toBe("ready");
    expect(c.pending).toBeNull();
    expect(c.messages[0].error).toBe(code);
    mocks.deepseek.mockResolvedValue({ answer: "No evidence", citations: [], insufficient: true, contradictions: [], unverified: [] });
    expect((await h.call("/questions", question())).status).toBe(202);
    await h.drain();
    expect(c.messages[1].answer?.answer).toBe("No evidence");
  });
  it("still ends native conversations after a real permission denial", async () => {
    const h = await harness(true);
    mocks.deepseek.mockRejectedValueOnce(new AssistantError("wiki_read_denied", 403));
    await h.call("/questions", question());
    await h.drain();
    expect(h.user["state"].conversation).toBeNull();
  });
  it("routes consented native text to DeepSeek and preserves bounded follow-up history", async () => {
    const h = await harness(true);
    mocks.route.mockResolvedValue({ route: "conversation", durationMs: 1 });
    mocks.deepseek.mockResolvedValue({ answer: "Hello", citations: [], insufficient: false, contradictions: [], unverified: [] });
    await h.call("/questions", question());
    await h.drain();
    expect(mocks.deepseek).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(h.user["state"].conversation!.messages[0].answer?.answer).toBe("Hello");
    await h.call("/questions", question());
    await h.drain();
    expect(mocks.deepseek.mock.calls[1][0].state.messages[1].content).toContain("Hello");
  });

  it("aborts cancelled native requests and never publishes a late answer", async () => {
    const h = await harness(true);
    mocks.route.mockResolvedValue({ route: "conversation", durationMs: 1 });
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    mocks.deepseek.mockImplementation(async () => {
      started();
      await waiting;
      return { answer: "Late", citations: [], insufficient: false, contradictions: [], unverified: [] };
    });
    await h.call("/questions", question());
    await entered;
    const c = h.user["state"].conversation!;
    c.sessionId = "existing-voice-agent";
    c.deferred = { id: "next-voice-question", offset: 0 };
    const send = vi.fn();
    const socket = { send, close: vi.fn() } as unknown as WebSocket;
    const requestId = crypto.randomUUID();
    await h.user["controlMessage"](socket, c, JSON.stringify({
      type: "command", action: "cancel", payload: {}, requestId, generation: c.generation,
    }));
    expect(send.mock.calls.map(([body]) => JSON.parse(body))).toContainEqual(expect.objectContaining({
      type: "command.result", requestId, status: 200,
    }));
    expect(mocks.deepseek.mock.calls[0][0].signal.aborted).toBe(true);
    expect(c.sessionId).toBe("existing-voice-agent");
    expect(c.deferred).toEqual({ id: "next-voice-question", offset: 0 });
    expect(c.status).toBe("ready");
    expect(h.user["state"].cleanup).toEqual([]);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    release();
    await h.drain();
    expect(h.user["state"].conversation!.messages[0].answer).toBeNull();
  });
  it("rejects old native conversation consent", async () => {
    const h = await harness(true);
    const response = await h.call("/conversations", { databaseId: "db", scope: "/Knowledge", consent: "2026-09-22" });
    expect(response.status).toBe(400);
    expect(mocks.deepseek).not.toHaveBeenCalled();
  });
  it("rejects unsupported native answers and clears pending text without OpenAI cleanup", async () => {
    const h = await harness(true);
    mocks.deepseek.mockResolvedValue({ answer: "Invented", citations: [], insufficient: false, contradictions: [], unverified: [] });
    await h.call("/questions", question());
    await h.drain();
    expect(h.user["state"].conversation!.messages[0]).toMatchObject({ answer: null, error: "unsupported_answer" });
    expect(h.user["state"].conversation!.pending).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("handles malformed native answers without Agent reconciliation or voice cleanup", async () => {
    const h = await harness(true);
    const c = h.user["state"].conversation!;
    c.sessionId = "existing-voice-agent";
    mocks.deepseek.mockResolvedValue({ unexpected: true });
    await h.call("/questions", question());
    await h.drain();
    expect(c.messages[0]).toMatchObject({ answer: null, error: "deepseek_invalid_response" });
    expect(c.status).toBe("ready");
    expect(c.sessionId).toBe("existing-voice-agent");
    expect(mocks.discardIntent).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(h.user["state"].cleanup).toEqual([]);
  });
  it("does not send native text to DeepSeek under old consent", async () => {
    const h = await harness();
    h.user["state"].conversation!.native = true;
    await h.call("/questions", question());
    await h.drain();
    expect(h.user["state"].conversation!.messages[0].error).toBe("consent_required");
    expect(mocks.deepseek).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });


  it("returns a clarification without creating an Agent when routing is ambiguous", async () => {
    mocks.route.mockResolvedValueOnce({ route: null, durationMs: 4 });
    const h = await harness();
    const q = question();
    expect((await h.call("/questions", q)).status).toBe(202);
    await h.drain();
    expect(mocks.create).not.toHaveBeenCalled();
    const conversation = h.user["state"].conversation!;
    expect(conversation.pending).toBeNull();
    expect(conversation.messages[0]).toMatchObject({
      kind: "clarification",
      answer: { answer: "Please clarify.", citations: [] },
      trace: { route: "clarification", jevRouteDurationMs: 4 },
    });
  });
  it("routes follow-up questions with bounded prior conversation text", async () => {
    const h = await harness();
    const conversation = h.user["state"].conversation!;
    conversation.history = [
      { role: "user", text: "Translate this sentence" },
      { role: "assistant", text: "The sentence is ready." },
    ];
    const q = { ...question(), question: "それを日本語にして" };
    expect((await h.call("/questions", q)).status).toBe(202);
    await h.drain();
    expect(mocks.route).toHaveBeenCalledWith(
      expect.objectContaining({
        question: q.question,
        history: conversation.history,
      }),
    );
  });
  it("submits repeated request IDs only once and rejects changed content", async () => {
    const h = await harness();
    const q = question();
    expect((await h.call("/questions", q)).status).toBe(202);
    await h.drain();
    expect((await h.call("/questions", q)).status).toBe(202);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(
      (await h.call("/questions", { ...q, question: "changed" })).status,
    ).toBe(409);
  });
  it("enforces one active conversation and ownership of conversation IDs", async () => {
    const h = await harness();
    expect(
      (
        await h.call("/conversations", {
          databaseId: "other",
          scope: "/Knowledge",
          consent: "2026-09-22",
        })
      ).status,
    ).toBe(409);
    expect(
      (await h.call("/conversation", undefined, crypto.randomUUID())).status,
    ).toBe(403);
  });
  it("does not resubmit an input when session creation has an uncertain outcome", async () => {
    mocks.create.mockRejectedValue(new Error("connection reset"));
    const h = await harness();
    await h.call("/questions", question());
    await h.drain();
    await h.fireAlarm();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.discardIntent).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404])(
    "discards the Agent intent after a definitive %s creation rejection",
    async (status) => {
      const failure = Object.assign(Object.create(OpenAI.APIError.prototype), {
        status,
      });
      mocks.create.mockRejectedValue(failure);
      const h = await harness();
      const q = question();
      await h.call("/questions", q);
      await h.drain();
      expect(mocks.discardIntent).toHaveBeenCalledWith(
        "agent:" + h.id + ":" + q.requestId,
        expect.objectContaining({ scope: "question", id: h.id }),
      );
      const conversation = h.user["state"].conversation!;
      expect(conversation.pending).toBeNull();
      expect(conversation.status).toBe("ready");
      expect(conversation.messages.at(-1)?.error).toBe(
        "agent_response_unavailable",
      );
      expect(h.user["state"].cleanup).toEqual([]);
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );
  it("keeps a rejected creation unresolved when intent deletion is not fenced", async () => {
    const failure = Object.assign(Object.create(OpenAI.APIError.prototype), {
      status: 400,
    });
    mocks.create.mockRejectedValue(failure);
    mocks.discardIntent.mockResolvedValue(false);
    const h = await harness();
    await h.call("/questions", question());
    await h.drain();
    expect(h.user["state"].conversation?.pending?.stage).toBe("creating");
    expect(h.user["state"].conversation?.error).toBe(
      "checking_request_status",
    );
    await h.fireAlarm();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("discards a delayed creation result after the conversation has ended", async () => {
    let release!: (v: { id: string }) => void;
    mocks.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const h = await harness();
    await h.call("/questions", question());
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalled());
    await h.user.endOwned("auth", h.id);
    release({ id: "late-session" });
    await h.drain();
    expect((await h.call("/conversation")).status).toBe(410);
    await h.fireAlarm();
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.anything(),
      "late-session",
    );
    expect(JSON.stringify(h.storage.get("state"))).not.toContain(
      "What is the decision?",
    );
  });
  it("keeps only cleanup IDs after failed remote deletion and retries them", async () => {
    const h = await harness();
    await h.call("/questions", question());
    await h.drain();
    mocks.remove.mockRejectedValueOnce(new Error("503"));
    await h.user.endOwned("auth", h.id);
    const stored = JSON.stringify(h.storage.get("state"));
    expect(stored).toContain("session-1");
    expect(stored).not.toContain("What is the decision?");
    await h.fireAlarm();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    vi.setSystemTime(h.user["state"].cleanup[0].nextAttempt!);
    await h.fireAlarm();
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });
  it("retains the daily quota across ended conversations", async () => {
    const h = await harness();
    h.user["state"].questions = DEFAULT_LIMITS.questions;
    expect((await h.call("/questions", question())).status).toBe(429);
  });
  it("ends the conversation when access is revoked during processing", async () => {
    const h = await harness();
    await h.call("/questions", question());
    await h.drain();
    mocks.authorize.mockRejectedValue(new Error("permission revoked"));
    await h.fireAlarm();
    expect((await h.call("/conversation")).status).toBe(410);
    expect(mocks.remove).toHaveBeenCalled();
  });
});

it("uses the current turn final answer, ignoring old completed turns", async () => {
  const h = await harness();
  const q = question();
  const answer = {
    answer: "根拠が見つかりませんでした。",
    citations: [],
    insufficient: true,
    contradictions: [],
    unverified: [],
  };
  mocks.items.mockResolvedValue([
    {
      type: "message",
      role: "assistant",
      turn_id: "old",
      phase: "final_answer",
      text: "invalid old answer",
    },
    {
      type: "message",
      role: "user",
      turn_id: "current",
      text: JSON.stringify({ ...q, selectedPath: null }),
    },
    {
      type: "message",
      role: "assistant",
      turn_id: "current",
      phase: "final_answer",
      text: JSON.stringify(answer),
    },
  ]);
  // The provider input has a stable field order independent of request JSON.
  const items = await mocks.items();
  items[1].text = JSON.stringify({
    requestId: q.requestId,
    question: q.question,
    scope: q.scope,
    selectedPath: null,
  });
  mocks.turn.mockResolvedValue({ status: "completed" });
  await h.call("/questions", q);
  await h.drain();
  const state = JSON.stringify(h.storage.get("state"));
  expect(state).toContain(answer.answer);
  expect(state).not.toContain("invalid old answer");
  expect(mocks.turn).toHaveBeenCalledWith("current", {
    session_id: "session-1",
  });
});
it("replays a saved tool result after a delivery failure without reading again", async () => {
  const h = await harness();
  const q = question();
  mocks.items.mockResolvedValue([
    {
      type: "message",
      role: "user",
      turn_id: "current",
      text: JSON.stringify({
        requestId: q.requestId,
        question: q.question,
        scope: q.scope,
        selectedPath: null,
      }),
    },
  ]);
  mocks.retrieve.mockResolvedValue({
    status: "in_progress",
    required_actions: [
      {
        type: "function_call",
        turn_id: "current",
        call_id: "read-1",
        name: "wiki_read",
        arguments: { path: "/Knowledge/test.md", start: 0 },
      },
    ],
  });
  mocks.read.mockResolvedValue("saved text");
  mocks.send.mockRejectedValueOnce(new Error("connection reset"));
  await h.call("/questions", q);
  await h.drain();
  await h.fireAlarm();
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.send.mock.calls[1][1].events[0].output).toBe("saved text");
});


afterEach(() => {
  vi.useRealTimers();
});
it("expires inactivity despite presence and before external authorization", async () => {
  vi.useFakeTimers();
  const h = await harness();
  const c = h.user["state"].conversation!;
  vi.setSystemTime(c.activity + 600000);
  c.seen = Date.now();
  mocks.authorize.mockClear();
  await h.fireAlarm();
  expect(h.user["state"].conversation).toBeNull();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it("cancels overdue questions before external authorization", async () => {
  vi.useFakeTimers();
  const h = await harness();
  await h.call("/questions", question());
  await h.drain();
  const c = h.user["state"].conversation!;
  vi.setSystemTime(c.pending!.started + 90000);
  mocks.authorize.mockImplementation(async () => {
    expect(c.pending).toBeNull();
  });
  await h.fireAlarm();
  expect(c.messages[0].error).toBe("turn_timeout");
});

it("pages history by revision without putting content in snapshots", async () => {
  const h = await harness();
  const c = h.user["state"].conversation!;
  c.messages = Array.from({ length: 30 }, (_, index) => ({
    voice: false,
    requestId: crypto.randomUUID(),
    question: `${index}:` + "日🙂".repeat(2000),
    answer: null,
    error: null,
    kind: null,
    trace: null,
  }));
  const snapshot = h.user["snapshot"](c);
  expect(snapshot).not.toHaveProperty("messages");
  expect(snapshot).not.toHaveProperty("utterances");
  let cursor = 0;
  let count = 0;
  do {
    const page = h.user["historyPage"](
      c,
      h.user["revision"],
      cursor,
    );
    expect(page.messages.length + page.utterances.length).toBeLessThanOrEqual(10);
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(512000);
    count += page.messages.length + page.utterances.length;
    cursor = page.nextCursor === null ? -1 : Number(page.nextCursor);
  } while (cursor >= 0);
  expect(count).toBe(30);
  expect(() =>
    h.user["historyPage"](c, h.user["revision"] - 1, 0),
  ).toThrow("stale_state");
});


it("retires the previous temporary conversation format through cleanup", async () => {
  const h = await harness();
  const state = structuredClone(h.user["state"]);
  state.conversation!.format = 1 as 3;
  vi.spyOn(h.user["store"], "load").mockResolvedValue({ revision: h.user["revision"], state });
  await h.user.initialize();
  expect(h.user["state"].conversation).toBeNull();
});

it.each(["live", "native", "delegation"])("drops retired %s state without provider termination or reconciliation", async (kind) => {
  const h = await harness();
  const state = structuredClone(h.user["state"]);
  const c = state.conversation!;
  if (kind === "live") c.live = { id: "retired-provider", usage: { chargeId: "retired-charge" } };
  if (kind === "native") { c.native = true; delete c.nativeTextProvider; }
  if (kind === "delegation") {
    await h.call("/questions", question());
    c.pending = structuredClone(h.user["state"].conversation!.pending);
    c.pending!.delegationId = "retired-delegation";
  }
  c.sessionId = "retired-agent";
  state.cleanup.push({ sessionId: "retired-agent", liveId: "retired-provider", voiceUsage: {}, conversationId: c.id, unknownCreate: false });
  vi.spyOn(h.user["store"], "load").mockResolvedValue({ revision: h.user["revision"], state });
  await h.user.initialize();
  expect(h.user["state"].conversation).toBeNull();
  expect(h.user["state"].cleanup).toEqual([]);
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
