import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantUser, voiceSummary } from "../src/user";
import type { Env } from "../src/env";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  items: vi.fn(),
  retrieve: vi.fn(),
  turn: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  authorize: vi.fn(),
  read: vi.fn(),
  attach: vi.fn(),
}));
vi.mock("../src/openai", () => ({
  client: () => ({
    beta: {
      agents: {
        sessions: {
          retrieve: mocks.retrieve,
          events: { create: mocks.send },
          turns: { retrieve: mocks.turn },
          list: async function* () {},
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
  ) =>
    JSON.stringify({
      requestId,
      question,
      scope,
      selectedPath: selectedPath ?? null,
    }),
  messageText: (item: { text?: string }) => item.text ?? "",
  attachLive: mocks.attach,
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
async function harness() {
  const storage = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  let ready: Promise<unknown> = Promise.resolve();
  let alarmAt: number | null = null;
  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      put: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
      },
      getAlarm: async () => alarmAt,
      setAlarm: async (at: number) => {
        alarmAt = at;
      },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(ctx.storage),
      deleteAll: async () => {
        storage.clear();
      },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      ready = fn();
    },
    waitUntil: (p: Promise<unknown>) => {
      background.push(p);
    },
    getWebSockets: () => [],
  } as unknown as DurableObjectState;
  const env = {
    ASSISTANT_ENABLED: "true",
    OPENAI_API_KEY: "fake",
    ASSISTANT_KEY_ENCRYPTION_KEY: "fake",
    ASSISTANT_LIMITS: '{"questions":2}',
    ASSISTANT_DERIVATION_ORIGIN: "origin",
    ASSISTANT_AUTH: {
      getByName: () => ({
        material: async () => ({
          principal: "owner",
          material: { appKey: ["a", "b"] },
        }),
      }),
    },
  } as unknown as Env;
  const user = new AssistantUser(ctx, env);
  await ready;
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
    consent: "2026-09-14",
  });
  id = ((await created.json()) as { id: string }).id;
  return {
    user,
    alarmAt: () => alarmAt,
    fireAlarm: async () => {
      alarmAt = null;
      await user.alarm();
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
  mocks.cancel.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
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
          consent: "2026-09-14",
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
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });
  it("retains the daily quota across ended conversations", async () => {
    const h = await harness();
    const q1 = question();
    await h.call("/questions", q1);
    await h.drain();
    await h.call("/cancel", {});
    await h.call("/questions", question());
    await h.drain();
    await h.call("/cancel", {});
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
  expect(summary).toContain("根拠不足");
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
      requestId: crypto.randomUUID(),
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
