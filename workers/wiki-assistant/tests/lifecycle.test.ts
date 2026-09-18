import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import {
  AssistantUser,
  SIDEBAND_RETRY_BASE_MS,
  SIDEBAND_RETRY_MAX_MS,
  sidebandRetryDelay,
  voiceSummary,
} from "../src/user";
import { AssistantError, DEFAULT_LIMITS } from "../src/contracts";
import type { Env } from "../src/env";
const mocks = vi.hoisted(() => ({
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
  attach: vi.fn(),
  reserve: vi.fn(),
  charge: vi.fn(),
  stop: vi.fn(),
  stopAt: vi.fn(),
  clearStop: vi.fn(),
  discardIntent: vi.fn(),
}));
vi.mock("../src/billing", () => ({
  voiceReservation: async () => null,
  reserveVoice: mocks.reserve,
  settleVoiceCharge: mocks.charge,
  stopVoiceCharge: mocks.stop,
  voicePolicy: async () => ({ enabled: true, daily_budget_cycles: 1000n }),
  voiceRate: async () => ({ version: 1n, cycles_per_minute: 60n }),
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
  createLive: mocks.create,
  sessionItems: mocks.items,
  cancelAgent: mocks.cancel,
  deleteAgent: mocks.remove,
  inputText: (
    requestId: string,
    question: string,
    scope: string,
    selectedPath?: string,
  ) =>
    JSON.stringify({
      requestId,
      question,
      scope,
      selectedPath: selectedPath ?? null,
    }),
  messageText: (item: { text?: string }) => item.text ?? "",
  attachLive: mocks.attach,
  // Deliberately minimal: the real handshake is covered by
  // close-live.worker.test.ts against the actual implementation. Copying that
  // logic here would let the two drift apart while staying green.
  closeLiveSession: async (
    _apiKey: string,
    _id: string,
    ws?: WebSocket,
    drainEvents: () => Promise<void> = async () => {},
  ): Promise<unknown> => {
    const socket = ws ?? ((await mocks.attach(_apiKey, _id)) as WebSocket);
    let seconds: unknown;
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(String((event as MessageEvent).data)) as {
        type?: unknown;
        usage?: { seconds?: unknown };
      };
      if (data.type === "session.closed") seconds = data.usage?.seconds;
    });
    socket.send(JSON.stringify({ type: "session.close" }));
    // ClosingSocket answers on a microtask, so let it deliver before reading.
    await Promise.resolve();
    await Promise.resolve();
    await drainEvents();
    return seconds;
  },
  voiceInstructions: "test",
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
            voiceSeconds: 0,
            conversation: null,
            cleanup: [],
            charges: [],
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
    async touch() {}
    async canSend() {
      return true;
    }
    async stopAt(...args: unknown[]) {
      return mocks.stopAt(...args);
    }
    async clearStop(...args: unknown[]) {
      return mocks.clearStop(...args);
    }
  },
}));
async function harness() {
  const storage = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const memory = { storage, wake: null as number | null, revision: 0 };
  const env = {
    ASSISTANT_ENABLED: "true",
    OPENAI_API_KEY: "fake",
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
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      ),
    );
  const created = await call("/conversations", {
    databaseId: "db",
    scope: "/Knowledge",
    consent: "2026-09-18",
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
  mocks.stopAt.mockResolvedValue(null);
  mocks.clearStop.mockResolvedValue(undefined);
  mocks.reserve.mockImplementation(
    async (_env, _id, _db, _principal, _rate, seconds) => ({
      reserved_seconds: BigInt(seconds),
      closed: false,
    }),
  );
  mocks.charge.mockImplementation(async (_env, _id, seconds, closed) => ({
    confirmed_seconds: BigInt(seconds),
    closed,
  }));
  mocks.stop.mockImplementation(async (_env, _id, seconds) => ({
    confirmed_seconds: BigInt(seconds),
    stopped_seconds: [BigInt(seconds)],
    closed: true,
  }));
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
});
const question = () => ({
  requestId: crypto.randomUUID(),
  question: "What is the decision?",
  scope: "/Knowledge",
});
describe("conversation lifecycle", () => {
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
          consent: "2026-09-18",
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
it("bounds voice summaries including caveats without splitting Unicode characters", () => {
  const summary = voiceSummary({
    answer: "漢字😀".repeat(1000),
    insufficient: true,
    contradictions: [],
    unverified: [],
  });
  expect(new TextEncoder().encode(summary).length).toBeLessThanOrEqual(450);
  expect(summary).toContain("evidence is incomplete");
  expect(summary).not.toContain("\uFFFD");
});

afterEach(() => {
  vi.useRealTimers();
});
class ClosingSocket extends EventTarget {
  readyState = 1;
  seconds: unknown = 7;
  send = vi.fn((text: string) => {
    if (JSON.parse(text).type === "session.close")
      void Promise.resolve().then(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "session.closed",
              usage: { seconds: this.seconds },
            }),
          }),
        ),
      );
  });
  close() {
    this.readyState = 3;
  }
}
async function withVoice() {
  const h = await harness();
  const c = h.user["state"].conversation!;
  const ws = new ClosingSocket();
  c.live = {
    id: "live-1",
    usage: {
      started: Date.now(),
      reserved: 600,
      usageDay: h.user["state"].day,
      settled: false,
    },
    stopping: false,
  };
  h.user["state"].voiceSeconds = 600;
  h.user["sideband"] = ws as unknown as WebSocket;
  h.user["sidebandId"] = "live-1";
  await h.user["save"]();
  return { ...h, c, ws };
}
it("coalesces simultaneous stop requests into one provider close", async () => {
  const h = await withVoice();
  const spy = vi.spyOn(h.ws, "send");
  await Promise.all([h.user["stopVoice"](h.c), h.user["stopVoice"](h.c)]);
  expect(spy.mock.calls.filter(([data]) => JSON.parse(data).type === "session.close")).toHaveLength(1);
  expect(h.c.live).toBeNull();
});
it("never postpones an alarm under frequent saves and heartbeats", async () => {
  vi.useFakeTimers();
  const h = await withVoice();
  const first = h.alarmAt();
  for (let i = 0; i < 14; i++) {
    vi.setSystemTime(Date.now() + 1000);
    h.c.seen = Date.now();
    h.c.activity = Date.now();
    await h.user["save"]();
    expect(h.alarmAt()).toBe(first);
  }
  vi.setSystemTime(h.c.live!.usage.started + 600000);
  h.c.seen = h.c.activity = Date.now();
  mocks.authorize.mockImplementation(async () => {
    expect(h.c.live).toBeNull();
  });
  await h.fireAlarm();
  expect(h.c.live).toBeNull();
  expect(h.user["state"].voiceSeconds).toBe(7);
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
it("keeps the pending text answer when sideband reconnect fails", async () => {
  const h = await withVoice();
  const q = question();
  await h.call("/questions", q);
  await h.drain();
  h.c.pending!.delegationId = "delegation-1";
  h.user["sideband"] = null;
  h.user["sidebandId"] = null;
  mocks.attach.mockRejectedValue(new Error("network"));
  await h.fireAlarm();
  expect(h.c.live?.stopping).toBe(true);
  expect(h.c.pending).not.toBeNull();
  expect(mocks.cancel).not.toHaveBeenCalled();
  const answer = {
    answer: "根拠が不足しています",
    citations: [],
    insufficient: true,
    contradictions: [],
    unverified: [],
  };
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
    {
      type: "message",
      role: "assistant",
      turn_id: "current",
      phase: "final_answer",
      text: JSON.stringify(answer),
    },
  ]);
  mocks.turn.mockResolvedValue({ status: "completed" });
  await h.fireAlarm();
  expect(h.c.messages[0].answer?.answer).toBe(answer.answer);
  expect(h.user["state"].conversation).toBe(h.c);
  mocks.attach.mockResolvedValue(new ClosingSocket());
  await h.fireAlarm();
  expect(h.c.live).toBeNull();
});
it.each(["end", "db-change", "logout"])(
  "settles short voice use exactly once after %s",
  async (mode) => {
    const h = await withVoice();
    const usage = h.c.live!.usage;
    h.c.messages.push({
      voice: false,      requestId: crypto.randomUUID(),
      question: "private question",
      answer: null,
      error: null,
    });
    await h.user.endOwned("auth", mode === "logout" ? undefined : h.id);
    expect(h.user["state"].voiceSeconds).toBe(7);
    expect(JSON.stringify(h.storage.get("state"))).not.toContain(
      "private question",
    );
    h.user["settleVoice"](usage, 7);
    await h.fireAlarm();
    expect(h.user["state"].voiceSeconds).toBe(7);
  },
);
it("retains only voice accounting metadata during failed cleanup then settles on retry", async () => {
  const h = await withVoice();
  h.user["sideband"] = null;
  mocks.attach.mockRejectedValueOnce(new Error("network"));
  await h.user.endOwned("auth");
  expect(h.user["state"].voiceSeconds).toBe(600);
  expect(h.user["state"].cleanup[0].voiceUsage?.reserved).toBe(600);
  mocks.attach.mockResolvedValue(new ClosingSocket());
  await h.fireAlarm();
  expect(h.user["state"].voiceSeconds).toBe(600);
  vi.useFakeTimers();
  vi.setSystemTime(h.user["state"].cleanup[0].nextAttempt!);
  await h.fireAlarm();
  expect(h.user["state"].voiceSeconds).toBe(7);
  expect(h.user["state"].cleanup).toEqual([]);
});
it("keeps the reservation when closed usage is unavailable", async () => {
  const h = await withVoice();
  h.ws.seconds = undefined;
  await h.user.endOwned("auth");
  expect(h.user["state"].voiceSeconds).toBe(600);
});
it("does not refund yesterday's reservation against today's usage", async () => {
  const h = await withVoice();
  h.c.live!.usage.usageDay = "2000-01-01";
  h.user["state"].voiceSeconds = 123;
  await h.user.endOwned("auth");
  expect(h.user["state"].voiceSeconds).toBe(123);
});

async function withCharge() {
  const h = await withVoice();
  h.c.live!.usage.chargeId = "charge-1";
  const charge = {
    id: "charge-1",
    conversationId: h.c.id,
    databaseId: "db",
    principal: "owner",
    rate: "1",
    reserved: 60,
    started: Date.now(),
    stopped: null as number | null,
    expires: Date.now() + 86400000,
    confirmed: 0,
  };
  h.user["state"].charges.push(charge);
  await h.user["save"]();
  return { ...h, charge };
}
it("reserves the next minute when thirty funded seconds remain", async () => {
  vi.useFakeTimers();
  const h = await withCharge();
  vi.setSystemTime(h.charge.started + 30000);
  await h.fireAlarm();
  expect(mocks.reserve).toHaveBeenCalledWith(
    expect.anything(),
    "charge-1",
    "db",
    "owner",
    "1",
    120,
  );
  expect(h.charge.reserved).toBe(120);
});
it("stops at funded deadline when extensions fail without cancelling text", async () => {
  vi.useFakeTimers();
  const h = await withCharge();
  await h.call("/questions", question());
  await h.drain();
  mocks.reserve.mockRejectedValue(new Error("offline"));
  vi.setSystemTime(h.charge.started + 30000);
  await h.fireAlarm();
  vi.setSystemTime(h.charge.started + 60000);
  await h.fireAlarm();
  expect(h.c.live).toBeNull();
  expect(h.c.pending).not.toBeNull();
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenLastCalledWith(
    expect.anything(),
    "charge-1",
    60,
  );
});
it("fixes charge duration at logout even when cleanup takes longer", async () => {
  vi.useFakeTimers();
  const h = await withCharge();
  vi.setSystemTime(h.charge.started + 7000);
  await h.user.endOwned("auth");
  vi.setSystemTime(h.charge.started + 60000);
  await h.fireAlarm();
  expect(mocks.stop).toHaveBeenLastCalledWith(
    expect.anything(),
    "charge-1",
    7,
  );
  expect(h.user["state"].charges).toEqual([]);
});
it("retains content-free charge metadata on canister outage and retries idempotently", async () => {
  vi.useFakeTimers();
  const h = await withCharge();
  vi.setSystemTime(h.charge.started + 7000);
  await h.user.endOwned("auth");
  mocks.stop.mockRejectedValueOnce(new Error("offline"));
  await h.fireAlarm();
  expect(h.user["state"].charges).toHaveLength(1);
  expect(h.user["state"].conversation).toBeNull();
  await h.fireAlarm();
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  vi.setSystemTime(h.user["state"].charges[0].nextAttempt!);
  await h.fireAlarm();
  expect(h.user["state"].charges).toEqual([]);
  expect(mocks.stop).toHaveBeenLastCalledWith(
    expect.anything(),
    "charge-1",
    7,
  );
});

it("accepts only the owning cleanup binding and fixes a delayed stop request's billing cutoff", async () => {
  vi.useFakeTimers();
  const h = await withCharge();
  vi.setSystemTime(h.charge.started + 20000);
  await expect(
    h.user.stopVoiceOwned("other", h.c.id, h.charge.started + 7000),
  ).rejects.toThrow("conversation_not_owned");
  expect(h.charge.stopped).toBeNull();
  await h.user.stopVoiceOwned("auth", h.c.id, h.charge.started + 7000);
  await h.fireAlarm();
  expect(mocks.stop).toHaveBeenLastCalledWith(
    expect.anything(),
    "charge-1",
    7,
  );
});
it("re-reads a persisted stop before finalizing a charge", async () => {
  vi.useFakeTimers();
  const h = await withCharge();
  mocks.stopAt.mockResolvedValue(h.charge.started + 45000);
  vi.setSystemTime(h.charge.started + 50000);
  await h.fireAlarm();
  expect(mocks.stop).toHaveBeenLastCalledWith(
    expect.anything(),
    "charge-1",
    45,
  );
  expect(mocks.clearStop).toHaveBeenCalledWith(
    h.c.id,
    "charge-1",
    true,
    h.charge.started + 45000,
  );
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

it("starts billing only after a matching connection acknowledgment and keeps its first timestamp", async () => {
  vi.useFakeTimers();
  const h = await withCharge();
  const id = crypto.randomUUID();
  h.charge.id = id;
  h.c.live!.usage.chargeId = id;
  const createdAt = h.c.live!.usage.started;
  Object.assign(h.charge, { started: null });
  vi.setSystemTime(createdAt + 5000);
  expect(
    (await h.call("/voice/connected", { voiceId: crypto.randomUUID() })).status,
  ).toBe(409);
  expect((await h.call("/voice/connected", { voiceId: id })).status).toBe(200);
  const started = h.charge.started;
  vi.setSystemTime(createdAt + 8000);
  expect((await h.call("/voice/connected", { voiceId: id })).status).toBe(200);
  expect(h.charge.started).toBe(started);
  expect(h.user["snapshot"](h.c).voiceDeadline).toBe(started + 60000);
  await h.user.stopVoiceOwned("auth", h.c.id, Date.now());
  await h.fireAlarm();
  expect(mocks.stop).toHaveBeenLastCalledWith(expect.anything(), id, 3);
});
it("releases the reservation without billing if transport setup is never acknowledged", async () => {
  vi.useFakeTimers();
  const h = await withCharge();
  Object.assign(h.charge, { started: null });
  vi.setSystemTime(h.c.live!.usage.started + 30000);
  await h.fireAlarm();
  expect(h.c.live).toBeNull();
  expect(mocks.stop).toHaveBeenLastCalledWith(
    expect.anything(),
    "charge-1",
    0,
  );
  expect(h.user["state"].voiceSeconds).toBe(0);
});

it("returns the daily voice quota when Live setup fails before acknowledgment", async () => {
  const h = await harness();
  const c = h.user["state"].conversation!;
  c.native = true;
  mocks.create.mockRejectedValueOnce(new Error("transport failed"));
  await expect(
    h.user["startVoice"](c, "v=0", "1", crypto.randomUUID()),
  ).rejects.toThrow("voice_connection_failed");
  expect(h.user["state"].voiceSeconds).toBe(0);
});

it("does not stop the replacement connection for a delayed old native stop", async () => {
  const h = await withCharge();
  await h.user.stopVoiceOwned("auth", h.c.id, Date.now(), "old-voice");
  expect(h.c.live).not.toBeNull();
  expect(h.charge.stopped).toBeNull();
});

describe("sideband across D1 reloads", () => {
  async function connected() {
    const h = await withVoice();
    h.user["sideband"] = null;
    mocks.attach.mockResolvedValue(h.ws);
    await h.user["ensureSideband"](h.c);
    const emit = async (event: unknown) => {
      h.ws.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(event) }),
      );
      await h.drain();
    };
    const reload = async () => {
      const state = structuredClone(h.user["state"]);
      const revision = h.user["revision"] + 1;
      vi.spyOn(h.user["store"].db, "prepare").mockReturnValue({
        bind: () => ({ first: async () => ({ revision }) }),
      } as unknown as D1PreparedStatement);
      vi.spyOn(h.user["store"], "load").mockResolvedValue({ revision, state });
      h.user["nextWake"] = Infinity;
      await h.user["drive"]();
      return state.conversation!;
    };
    return { ...h, emit, reload };
  }
  const transcript = {
    type: "session.input_transcript.delta",
    delta: "Question",
    event_id: "transcript-1",
    start_ms: 0,
    end_ms: 100,
  };
  it("persists received final fragments before closing even if the socket closes immediately", async () => {
    const h = await connected();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const originalSave = h.user["save"].bind(h.user);
    let intercepted = false;
    vi.spyOn(h.user as unknown as { save: () => Promise<void> }, "save").mockImplementation(async () => {
      if (!intercepted) { intercepted = true; await blocked; }
      await originalSave();
    });
    const emit = (event: unknown) => h.ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    emit(transcript);
    emit({ type: "session.closed", usage: { seconds: 7 } });
    h.ws.dispatchEvent(new Event("close"));
    await Promise.resolve(); await Promise.resolve();
    expect(h.c.live).not.toBeNull();
    release();
    await h.drain();
    expect(h.c.utterances[0].text).toBe("Question");
    expect(h.c.live).toBeNull();
  });
  it("keeps transcripts and delegation on the current conversation after drive reloads D1", async () => {
    const h = await connected();
    await h.emit(transcript);
    const current = await h.reload();
    await h.user["ensureSideband"](current);
    await h.emit(transcript);
    expect(current.transcripts).toHaveLength(1);
    expect(current.utterances).toHaveLength(1);
    const originalID = current.utterances[0].id;
    await h.emit({ ...transcript, event_id: "transcript-2", delta: " continued", start_ms: 100, end_ms: 200 });
    expect(current.utterances[0].text).toBe("Question continued");
    expect(current.utterances[0].id).toBe(originalID);
    expect(
      h.user["historyPage"](current, h.user["revision"], 0).utterances[0].id,
    ).toBe(originalID);
    const delegate = vi
      .spyOn(
        h.user as unknown as { delegate: (typeof h.user)["delegate"] },
        "delegate",
      )
      .mockResolvedValue(undefined);
    await h.emit({
      type: "session.delegation.created",
      delegation: { id: "d", target: "client" },
      offset_ms: 100,
    });
    expect(delegate).toHaveBeenCalledWith(current, "d", 100);
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });
  it("settles a stopping session once and retains final transcript fragments", async () => {
    const h = await connected();
    const current = await h.reload();
    current.live!.stopping = true;
    await h.emit(transcript);
    expect(current.utterances).toHaveLength(1);
    await h.emit({ type: "session.closed", usage: { seconds: 7 } });
    expect(current.live).toBeNull();
    expect(h.user["state"].voiceSeconds).toBe(7);
    await h.emit({ type: "session.closed", usage: { seconds: 7 } });
    expect(h.user["state"].voiceSeconds).toBe(7);
  });
  it.each(["ended", "session", "socket", "lease"])(
    "rejects old events after %s changes",
    async (change) => {
      const h = await connected();
      const current = await h.reload();
      if (change === "ended") h.user["state"].conversation = null;
      if (change === "session") current.live!.id = "replacement";
      if (change === "socket")
        h.user["sideband"] = new ClosingSocket() as unknown as WebSocket;
      if (change === "lease")
        vi.spyOn(h.user["leases"], "valid").mockResolvedValue(false);
      await h.emit(transcript);
      await h.emit({ type: "session.closed", usage: { seconds: 7 } });
      expect(current.transcripts).toHaveLength(0);
      expect(current.live).not.toBeNull();
      expect(h.user["state"].voiceSeconds).toBe(600);
    },
  );
  it("adopts an in-flight attachment after the same session is reloaded", async () => {
    const h = await withVoice();
    h.user["sideband"] = null;
    let resolve!: (ws: WebSocket) => void;
    mocks.attach.mockImplementation(
      () =>
        new Promise<WebSocket>((r) => {
          resolve = r;
        }),
    );
    const pending = h.user["ensureSideband"](h.c);
    h.user["state"] = structuredClone(h.user["state"]);
    resolve(h.ws as unknown as WebSocket);
    await pending;
    expect(h.user["sideband"]).toBe(h.ws);
    expect(h.ws.send).not.toHaveBeenCalledWith(
      expect.stringContaining('"session.close"'),
    );
  });
  it.each(["ended", "session", "lease"])(
    "does not terminate a provider session from a stale pending attachment after %s",
    async (change) => {
      const h = await withVoice();
      h.user["sideband"] = null;
      let resolve!: (ws: WebSocket) => void;
      mocks.attach.mockImplementation(
        () =>
          new Promise<WebSocket>((r) => {
            resolve = r;
          }),
      );
      const pending = h.user["ensureSideband"](h.c);
      if (change === "ended") h.user["state"].conversation = null;
      if (change === "session") h.c.live!.id = "replacement";
      if (change === "lease")
        vi.spyOn(h.user["leases"], "valid").mockResolvedValue(false);
      resolve(h.ws as unknown as WebSocket);
      await pending;
      expect(h.user["sideband"]).toBeNull();
      expect(h.ws.readyState).toBe(3);
      expect(h.ws.send).not.toHaveBeenCalledWith(
        expect.stringContaining('"session.close"'),
      );
    },
  );
});

describe("sideband reconnection", () => {
  async function live() {
    const h = await withVoice();
    h.user["sideband"] = null;
    mocks.attach.mockResolvedValue(h.ws);
    await h.user["ensureSideband"](h.c);
    // withVoice seeds the socket directly; attach once so the close handler is
    // registered on a socket the retry path can actually re-attach.
    return h;
  }
  it("reattaches the sideband after an unexpected close", async () => {
    vi.useFakeTimers();
    const h = await live();
    expect(mocks.attach).toHaveBeenCalledTimes(1);
    h.ws.dispatchEvent(new Event("close"));
    expect(h.user["sideband"]).toBeNull();
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_BASE_MS + 1);
    await h.drain();
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    expect(h.user["sideband"]).toBe(h.ws);
  });
  it("does not reattach once the session is stopping", async () => {
    vi.useFakeTimers();
    const h = await live();
    h.c.live!.stopping = true;
    h.ws.dispatchEvent(new Event("close"));
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_MAX_MS + 1);
    await h.drain();
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });
  it("does not reattach after the conversation ended", async () => {
    vi.useFakeTimers();
    const h = await live();
    h.ws.dispatchEvent(new Event("close"));
    h.user["state"].conversation = null;
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_MAX_MS + 1);
    await h.drain();
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });
  it("does not reattach when the connection lease is gone", async () => {
    vi.useFakeTimers();
    const h = await live();
    vi.spyOn(h.user["leases"], "valid").mockResolvedValue(false);
    h.ws.dispatchEvent(new Event("close"));
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_MAX_MS + 1);
    await h.drain();
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });
  it("settles the session when the provider reports it is gone", async () => {
    vi.useFakeTimers();
    const h = await live();
    mocks.attach.mockRejectedValue(
      new AssistantError("voice_session_gone", 410),
    );
    h.ws.dispatchEvent(new Event("close"));
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_BASE_MS + 1);
    await h.drain();
    expect(h.c.live).toBeNull();
    const attempts = mocks.attach.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_MAX_MS * 2);
    await h.drain();
    expect(mocks.attach).toHaveBeenCalledTimes(attempts);
  });
  it("keeps the retry delay bounded when attachments keep failing", () => {
    expect(sidebandRetryDelay(0)).toBe(SIDEBAND_RETRY_BASE_MS);
    expect(sidebandRetryDelay(1)).toBe(SIDEBAND_RETRY_BASE_MS * 2);
    expect(sidebandRetryDelay(2)).toBe(SIDEBAND_RETRY_BASE_MS * 4);
    expect(sidebandRetryDelay(8)).toBe(SIDEBAND_RETRY_MAX_MS);
    expect(sidebandRetryDelay(50)).toBe(SIDEBAND_RETRY_MAX_MS);
  });


  it("never stalls when fresh attachments keep dying on arrival", async () => {
    vi.useFakeTimers();
    const h = await live();
    // Every reattachment is already closed when adopted, and such a socket may
    // never emit `close`. Recovery must still keep advancing.
    mocks.attach.mockImplementation(async () => {
      const socket = new ClosingSocket();
      socket.readyState = 3;
      return socket as unknown as WebSocket;
    });
    h.ws.dispatchEvent(new Event("close"));
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_MAX_MS + 1);
    await h.drain();
    const afterFirst = mocks.attach.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_MAX_MS * 6);
    await h.drain();
    expect(mocks.attach.mock.calls.length).toBeGreaterThan(afterFirst);
  });
  it("recovers onto a healthy attachment after a dead one", async () => {
    vi.useFakeTimers();
    const h = await live();
    let attempt = 0;
    mocks.attach.mockImplementation(async () => {
      const socket = new ClosingSocket();
      if (++attempt === 1) socket.readyState = 3; // dead on arrival
      return socket as unknown as WebSocket;
    });
    h.ws.dispatchEvent(new Event("close"));
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_MAX_MS * 2);
    await h.drain();
    const socket = h.user["sideband"] as unknown as { readyState: number } | null;
    expect(socket).not.toBeNull();
    expect(socket!.readyState).toBe(WebSocket.OPEN);
    expect(h.user["sidebandId"]).toBe("live-1");
  });
  it("does not resurrect a session that stopVoice just closed", async () => {
    vi.useFakeTimers();
    const h = await live();
    mocks.attach.mockClear();
    await h.user["stopVoice"](h.c);
    expect(h.c.live).toBeNull();
    await vi.advanceTimersByTimeAsync(SIDEBAND_RETRY_MAX_MS + 1);
    await h.drain();
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});

it("retires the previous temporary conversation format through cleanup", async () => {
  const h = await withVoice();
  const state = structuredClone(h.user["state"]);
  state.conversation!.format = 1 as 2;
  vi.spyOn(h.user["store"], "load").mockResolvedValue({ revision: h.user["revision"], state });
  await h.user.initialize();
  expect(h.user["state"].conversation).toBeNull();
});
