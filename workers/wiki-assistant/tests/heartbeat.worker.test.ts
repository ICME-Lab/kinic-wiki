import { expect, it, vi } from "vitest";

// The heartbeat exchange is what lets the client tell a quiet voice session
// from a dead peer, so it is exercised against the real control-message path.
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  touch: vi.fn(),
}));
vi.mock("../src/billing", () => ({
  voiceReservation: async () => null,
  reserveVoice: async () => ({}),
  settleVoiceCharge: async () => ({ confirmed_seconds: 0n, closed: false }),
  stopVoiceCharge: async (_env: unknown, _id: string, seconds: number) => ({
    confirmed_seconds: BigInt(seconds),
    stopped_seconds: [BigInt(seconds)],
    closed: true,
  }),
  voicePolicy: async () => ({ enabled: true, daily_budget_cycles: 1000n }),
  voiceRate: async () => ({ version: 1n, cycles_per_minute: 60n }),
}));
vi.mock("@kinic/ii-server/internet-identity", () => ({
  restoreKinicIdentity: () => ({}),
}));
vi.mock("../src/auth", () => ({
  requireEnabled: () => {},
  AssistantAuth: class {
    async material() {
      return { principal: "owner", material: { appKey: ["a", "b"] } };
    }
  },
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
        expires_at: Infinity,
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

const { AssistantUser } = await import("../src/user");

function harness() {
  const state = {
    principal: "owner",
    day: new Date().toISOString().slice(0, 10),
    questions: 0,
    voiceSeconds: 0,
    cleanup: [],
    charges: [],
    conversation: {
      id: "conversation-1",
      authId: "auth",
      principal: "owner",
      databaseId: "db",
      scope: "/Knowledge",
      sessionId: null,
      status: "ready",
      error: null,
      generation: 1,
      activity: Date.now(),
      seen: Date.now(),
      messages: [],
      live: null,
      transcripts: [],
      delegations: [],
      native: true,
    },
  };
  const user = Object.create(AssistantUser.prototype) as {
    state: unknown;
    save: () => Promise<void>;
    connectionLease: unknown;
    controlMessage: (
      ws: WebSocket,
      original: unknown,
      message: string | ArrayBuffer,
    ) => Promise<void>;
    store: { touch: typeof mocks.touch };
    leases: unknown;
    reader: () => Promise<{ authorize: typeof mocks.authorize }>;
    background: (p: Promise<unknown>) => void;
  };
  user.state = state;
  user.save = async () => {};
  user.connectionLease = {
    scope: "connection",
    id: "test",
    owner: "test",
    generation: 1,
    expires_at: Infinity,
  };
  user.store = { touch: mocks.touch };
  user.leases = { valid: async () => true };
  user.background = (p) => void p.catch(() => {});
  user.reader = async () => ({ authorize: mocks.authorize });
  return { user, state };
}

async function exchange(payload: string) {
  const { user, state } = harness();
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const replies: string[] = [];
  // Observe on the client end: sends made through the accepted server socket
  // arrive at its peer.
  client.accept();
  client.addEventListener("message", (event) => {
    if (typeof event.data === "string") replies.push(event.data);
  });
  await user.controlMessage(
    server as unknown as WebSocket,
    state.conversation,
    payload,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { replies, server };
}

it("echoes a heartbeat so the client can detect a dead peer", async () => {
  const requestId = crypto.randomUUID();
  const { replies } = await exchange(
    JSON.stringify({ type: "heartbeat", requestId }),
  );
  expect(replies.map((r) => JSON.parse(r))).toContainEqual({
    type: "heartbeat",
    requestId,
  });
  expect(mocks.touch).toHaveBeenCalled();
});

it("answers every heartbeat, not just the first", async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const requestId of ids) {
    const { replies } = await exchange(
      JSON.stringify({ type: "heartbeat", requestId }),
    );
    expect(replies.map((r) => JSON.parse(r))).toContainEqual({
      type: "heartbeat",
      requestId,
    });
  }
});

it("does not answer a bare heartbeat string from the retired protocol", async () => {
  const { replies } = await exchange("heartbeat");
  expect(replies.map((r) => JSON.parse(r) as { type?: string })).not.toContainEqual(
    expect.objectContaining({ type: "heartbeat" }),
  );
});

it("does not answer a heartbeat with a malformed request id", async () => {
  const { replies } = await exchange(
    JSON.stringify({ type: "heartbeat", requestId: "not-a-uuid" }),
  );
  expect(replies.map((r) => JSON.parse(r) as { type?: string })).not.toContainEqual(
    expect.objectContaining({ type: "heartbeat" }),
  );
});
