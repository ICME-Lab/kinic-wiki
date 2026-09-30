// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./assistant-panel";
import {
  assistantRequest,
  assistantSnapshot,
  AssistantVoice,
  AssistantControl,
  type AssistantSnapshot,
  type AssistantState,
} from "@/lib/assistant";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const citationId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
function snapshot(): AssistantSnapshot {
  return {
    revision: 1,
    id,
    databaseId: "db",
    scope: "/Knowledge",
    status: "ready",
    error: null,
    generation: 1,
    reconnectGraceMs: 120000,
    voice: "off",
    progress: null,
    utterances: [],
    messages: [],
  };
}
function state(value: AssistantSnapshot): AssistantState {
  const { messages: _messages, utterances: _utterances, ...metadata } = value;
  return metadata;
}
class TestSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send(_message: string) {}
  close() {
    this.readyState = 3;
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  disconnect() {
    this.readyState = 3;
    this.onclose?.();
  }
}
let sockets: TestSocket[];
let active: AssistantSnapshot | null;
let requests: { path: string; body: unknown }[];
beforeEach(() => {
  sockets = [];
  active = null;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, body });
      if (path.endsWith("/status")) return Response.json({ available: true });
      if (path.endsWith("/auth")) return Response.json({ principal: "owner" });
      if (path.endsWith("/active"))
        return active
          ? Response.json(state(active))
          : Response.json({ error: "conversation_ended" }, { status: 410 });
      if (path.endsWith("/conversations")) {
        active = snapshot();
        return Response.json(state(active));
      }
      if (path.endsWith("/conversation"))
        return active
          ? Response.json(state(active))
          : Response.json({ error: "conversation_ended" }, { status: 410 });
      if (path.endsWith("/history"))
        return active
          ? Response.json({
              revision: active.revision,
              messages: active.messages,
              utterances: active.utterances,
              nextCursor: null,
            })
          : Response.json({ error: "conversation_ended" }, { status: 410 });
      if (path.endsWith("/citation"))
        return Response.json({ changed: true, missing: false });
      if (path.endsWith("/questions"))
        return Response.json({ revision: active?.revision ?? 0 });
      return Response.json({ ended: true });
    }),
  );
  vi.stubGlobal("WebSocket", TestSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const openPanel = () =>
  fireEvent.click(
    screen.getByRole("button", { name: /Ask AI Answers with sources/ }),
  );
describe("Ask AI panel", () => {
  it("requires Wiki login and explicit data-transfer consent", async () => {
    render(
      <AssistantPanel
        databaseId="db"
        principal={null}
        selectedPath="/Knowledge"
        onOpenSource={() => {}}
      />,
    );
    openPanel();
    expect(
      screen.getByText(/Sign in to the Wiki with Internet Identity/),
    ).toBeTruthy();
    expect(screen.getByRole("checkbox").getAttribute("checked")).toBeNull();
    expect(
      screen.getByText(/necessary Wiki paths and previews for focused search ranking/),
    ).toBeTruthy();
    const button = screen.getByRole("button", {
      name: "Connect Ask AI with Internet Identity",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button.disabled).toBe(true);
    await waitFor(() =>
      expect(requests.some((r) => r.path.endsWith("/status"))).toBe(true),
    );
    expect(requests.some((r) => r.path.endsWith("/auth/start"))).toBe(false);
  });
  it("creates a DB-bound conversation only after consent", async () => {
    render(
      <AssistantPanel
        databaseId="db"
        principal="owner"
        selectedPath="/Knowledge"
        onOpenSource={() => {}}
      />,
    );
    openPanel();
    const start = await screen.findByRole("button", {
      name: "Start conversation",
    });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(start);
    await screen.findByRole("textbox", { name: "Question about the Wiki" });
    expect(
      requests.find((r) => r.path.endsWith("/conversations"))?.body,
    ).toEqual({ databaseId: "db", scope: "/Knowledge", consent: "2026-09-22" });
  });
  it("shows the exact citation excerpt and a changed-version notice", async () => {
    active = snapshot();
    active.messages = [
      {
        requestId: id,
        question: "色は？",
        error: null,
        answer: {
          answer: "青です。",
          insufficient: false,
          contradictions: [],
          unverified: [],
          citations: [
            {
              id: citationId,
              databaseId: "db",
              path: "/Sources/design.md",
              excerpt: "承認済みの色は青。",
              start: 0,
              end: 10,
              etag: "v1",
              retrievedAt: "2026-09-14T00:00:00Z",
            },
          ],
        },
      },
    ];
    const openSource = vi.fn();
    render(
      <AssistantPanel
        databaseId="db"
        principal="owner"
        selectedPath="/Knowledge"
        onOpenSource={openSource}
      />,
    );
    openPanel();
    await screen.findByText("承認済みの色は青。");
    fireEvent.click(screen.getByText("Check current version and open"));
    await screen.findByText(
      /This page has changed since the answer was generated/,
    );
    expect(openSource).toHaveBeenCalledWith("/Sources/design.md");
  });
  it("ends the previous conversation when the selected database changes", async () => {
    active = snapshot();
    const { rerender } = render(
      <AssistantPanel
        databaseId="db"
        principal="owner"
        selectedPath="/Knowledge"
        onOpenSource={() => {}}
      />,
    );
    openPanel();
    await screen.findByRole("textbox", { name: "Question about the Wiki" });
    rerender(
      <AssistantPanel
        databaseId="other-db"
        principal="owner"
        selectedPath="/Knowledge"
        onOpenSource={() => {}}
      />,
    );
    await waitFor(() =>
      expect(requests.some((r) => r.path.endsWith("/end"))).toBe(true),
    );
  });
  it("blocks a different II principal from starting or resuming a conversation", async () => {
    render(
      <AssistantPanel
        databaseId="db"
        principal="someone-else"
        selectedPath="/Knowledge"
        onOpenSource={() => {}}
      />,
    );
    openPanel();
    await screen.findByText(/Your Wiki and Ask AI accounts do not match/);
    expect(requests.some((r) => r.path.endsWith("/active"))).toBe(false);
  });
});
describe("voice cleanup", () => {
  it("stops a late microphone stream after the component is disposed", async () => {
    let resolve!: (stream: MediaStream) => void;
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<MediaStream>((r) => {
            resolve = r;
          }),
      },
    });
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        addEventListener() {}
        close() {}
      },
    );
    const voice = new AssistantVoice(
      document.createElement("audio"),
      () => {},
      new AssistantControl(),
    );
    const pending = voice.start(id);
    voice.dispose();
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await pending;
    expect(stop).toHaveBeenCalledOnce();
    expect(requests.some((r) => r.path.endsWith("/voice"))).toBe(false);
  });
  it("does not create a paid session when microphone permission is denied", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () => Promise.reject(new Error("microphone denied")),
      },
    });
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        addEventListener() {}
        close() {}
      },
    );
    const voice = new AssistantVoice(
      document.createElement("audio"),
      () => {},
      new AssistantControl(),
    );
    await expect(voice.start(id)).rejects.toThrow("microphone denied");
    expect(requests.some((r) => r.path.endsWith("/voice"))).toBe(false);
  });
});

it("does not expose an upstream HTML or text error as a JSON parser error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Worker unavailable", { status: 503 })),
  );
  await expect(assistantRequest("/status")).rejects.toThrow(
    "Ask AI could not complete the request",
  );
});

it("restarts paged history when its revision changes", async () => {
  const metadata = state(snapshot());
  let currentRevision = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(url, "https://example.test");
      if (parsed.pathname.endsWith("/conversation"))
        return Response.json({ ...metadata, revision: currentRevision });
      if (!parsed.pathname.endsWith("/history"))
        return Response.json({ error: "request_failed" }, { status: 500 });
      const revision = Number(parsed.searchParams.get("revision"));
      const cursor = parsed.searchParams.get("cursor");
      if (revision === 1 && cursor === "0")
        return Response.json({
          revision: 1,
          messages: [
            { requestId: "old", question: "old", answer: null, error: null },
          ],
          utterances: [],
          nextCursor: "1",
        });
      if (revision === 1) {
        currentRevision = 2;
        return Response.json({ error: "stale_state" }, { status: 409 });
      }
      return Response.json({
        revision: 2,
        messages: [
          { requestId: "new", question: "new", answer: null, error: null },
        ],
        utterances: [{ id: "speech", role: "user", text: "hello" }],
        nextCursor: null,
      });
    }),
  );

  const result = await assistantSnapshot(id, metadata);

  expect(result.revision).toBe(2);
  expect(result.messages.map((message) => message.requestId)).toEqual(["new"]);
  expect(result.utterances.map((utterance) => utterance.id)).toEqual([
    "speech",
  ]);
});

async function mountedConversation() {
  active = snapshot();
  active.messages = [
    {
      requestId: "old-question",
      question: "前の質問",
      answer: null,
      error: null,
    },
  ];
  const view = render(
    <AssistantPanel
      databaseId="db"
      principal="owner"
      selectedPath="/Knowledge"
      onOpenSource={() => {}}
    />,
  );
  openPanel();
  await screen.findByText("前の質問");
  await waitFor(() => expect(sockets).toHaveLength(1));
  return view;
}
it("checks HTTP state before reconnecting and accepts a fresh WebSocket snapshot", async () => {
  await mountedConversation();
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      url.includes("/conversation?")
        ? Response.json(state(active!))
        : original(url, init),
    ),
  );
  vi.useFakeTimers();
  act(() => sockets[0].disconnect());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(sockets).toHaveLength(2);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/conversation?"),
    expect.anything(),
  );
  act(() => sockets[1].message({ ...state(active!), type: "snapshot" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120000);
  });
  expect(screen.getByText("前の質問")).toBeTruthy();
});
it.each([
  "conversation_ended",
  "authentication_required",
  "conversation_not_owned",
  "assistant_disabled",
])("clears disconnected state after %s", async (code) => {
  await mountedConversation();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: code }, { status: 403 })),
  );
  vi.useFakeTimers();
  act(() => sockets[0].disconnect());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.queryByText("前の質問")).toBeNull();
  expect(sockets).toHaveLength(1);
  if (code === "authentication_required")
    expect(
      screen.getByRole("button", {
        name: "Connect Ask AI with Internet Identity",
      }),
    ).toBeTruthy();
});
it("stops retries at the server-provided reconnect deadline while offline", async () => {
  await mountedConversation();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
  vi.useFakeTimers();
  act(() => sockets[0].disconnect());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120000);
  });
  expect(screen.queryByText("前の質問")).toBeNull();
  expect(screen.getByText(/The reconnect window has expired/)).toBeTruthy();
  const attempts = vi.mocked(fetch).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(vi.mocked(fetch).mock.calls.length).toBe(attempts);
});
it("ignores an old reconnect response after changing DB", async () => {
  const view = await mountedConversation();
  const original = fetch;
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      url.includes("/conversation?")
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : original(url, init),
    ),
  );
  vi.useFakeTimers();
  act(() => sockets[0].disconnect());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  view.rerender(
    <AssistantPanel
      databaseId="other"
      principal="owner"
      selectedPath="/Knowledge"
      onOpenSource={() => {}}
    />,
  );
  await act(async () => {
    resolve(Response.json(state(active!)));
  });
  expect(sockets).toHaveLength(1);
  expect(screen.queryByText("前の質問")).toBeNull();
});
it("releases browser audio immediately when the server marks voice stopping", async () => {
  await mountedConversation();
  vi.spyOn(AssistantVoice.prototype, "start").mockResolvedValue();
  const dispose = vi.spyOn(AssistantVoice.prototype, "dispose");
  fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
  await waitFor(() =>
    expect(AssistantVoice.prototype.start).toHaveBeenCalled(),
  );
  active = { ...active!, revision: active!.revision + 1, voice: "stopping" };
  act(() =>
    sockets[0].message({ ...state(active!), type: "snapshot" }),
  );
  await waitFor(() => expect(dispose).toHaveBeenCalled());
  expect(screen.getByText("前の質問")).toBeTruthy();
});

it("keeps the displayed history when a newer revision cannot be fetched", async () => {
  await mountedConversation();
  const historyRequests = () =>
    requests.filter((request) => request.path.endsWith("/history")).length;
  const before = historyRequests();
  act(() =>
    sockets[0].message({ ...state(active!), revision: 1, type: "snapshot" }),
  );
  await act(async () => Promise.resolve());
  expect(historyRequests()).toBe(before);

  const original = fetch;
  active = { ...active!, revision: 2 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      url.includes("/history?")
        ? Response.json({ error: "request_failed" }, { status: 503 })
        : original(url, init),
    ),
  );
  act(() => sockets[0].message({ ...state(active!), type: "snapshot" }));

  await screen.findByRole("alert");
  expect(screen.getByText("前の質問")).toBeTruthy();
});

it("uses a revision-only command response to fetch the next snapshot", async () => {
  await mountedConversation();
  const sent = vi.spyOn(sockets[0], "send");
  fireEvent.change(screen.getByRole("textbox", { name: "Question about the Wiki" }), {
    target: { value: "次の質問" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  await waitFor(() => expect(sent).toHaveBeenCalled());
  const command = JSON.parse(String(sent.mock.calls.at(-1)?.[0]));
  active = {
    ...active!,
    revision: 2,
    messages: [
      ...active!.messages,
      {
        requestId: command.requestId,
        question: "次の質問",
        answer: null,
        error: null,
      },
    ],
  };
  act(() =>
    sockets[0].message({
      type: "command.result",
      requestId: command.requestId,
      status: 200,
      body: { revision: 2 },
    }),
  );

  await screen.findByText("次の質問");
  expect(requests.some((request) => request.path.endsWith("/history"))).toBe(
    true,
  );
});

it("routes command responses over the control socket and rejects disconnected requests", async () => {
  const control = new AssistantControl();
  const socket = new TestSocket();
  const sent = vi.spyOn(socket, "send");
  control.attach(socket as unknown as WebSocket);
  control.receive({ type: "snapshot", generation: 4 });
  const result = control.command<{ ok: boolean }>("cancel", {}, id);
  expect(sent).toHaveBeenCalledWith(expect.stringContaining('"generation":4'));
  control.receive({
    type: "command.result",
    requestId: id,
    status: 200,
    body: { ok: true },
  });
  await expect(result).resolves.toEqual({ ok: true });
  const lost = control.command("voice", {}, citationId);
  const rejected = expect(lost).rejects.toThrow();
  control.detach();
  await rejected;
});
