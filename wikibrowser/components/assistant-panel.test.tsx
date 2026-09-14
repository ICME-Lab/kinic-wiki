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
  AssistantVoice,
  type AssistantSnapshot,
} from "@/lib/assistant";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const citationId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
function snapshot(): AssistantSnapshot {
  return {
    id,
    databaseId: "db",
    scope: "/Knowledge",
    status: "ready",
    error: null,
    generation: 1,
    reconnectGraceMs: 120000,
    voice: "off",
    progress: null,
    messages: [],
  };
}
class TestSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send() {}
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
          ? Response.json(active)
          : Response.json({ error: "conversation_ended" }, { status: 410 });
      if (path.endsWith("/conversations")) {
        active = snapshot();
        return Response.json(active);
      }
      if (path.endsWith("/citation"))
        return Response.json({ changed: true, missing: false });
      if (path.endsWith("/questions")) return Response.json(active);
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
  fireEvent.click(screen.getByRole("button", { name: /Ask AI 出典付き/ }));
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
    expect(screen.getByText(/WikiにInternet Identityでログイン/)).toBeTruthy();
    expect(screen.getByRole("checkbox").getAttribute("checked")).toBeNull();
    const button = screen.getByRole("button", {
      name: "Internet IdentityでAsk AIを接続",
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
    const start = await screen.findByRole("button", { name: "会話を始める" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(start);
    await screen.findByRole("textbox", { name: "Wikiへの質問" });
    expect(
      requests.find((r) => r.path.endsWith("/conversations"))?.body,
    ).toEqual({ databaseId: "db", scope: "/Knowledge", consent: "2026-09-14" });
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
    fireEvent.click(screen.getByText("現在の版を確認して開く"));
    await screen.findByText(/回答時に確認した版から更新/);
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
    await screen.findByRole("textbox", { name: "Wikiへの質問" });
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
    await screen.findByText(/WikiとAsk AIのアカウントが異なります/);
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
    const voice = new AssistantVoice(document.createElement("audio"), () => {});
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
    const voice = new AssistantVoice(document.createElement("audio"), () => {});
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
    "Ask AIの処理に失敗しました",
  );
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
        ? Response.json(active)
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
  act(() => sockets[1].message({ ...active, type: "snapshot" }));
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
      screen.getByRole("button", { name: "Internet IdentityでAsk AIを接続" }),
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
  expect(screen.getByText(/復帰猶予を過ぎた/)).toBeTruthy();
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
    resolve(Response.json(active));
  });
  expect(sockets).toHaveLength(1);
  expect(screen.queryByText("前の質問")).toBeNull();
});
it("releases browser audio immediately when the server marks voice stopping", async () => {
  await mountedConversation();
  vi.spyOn(AssistantVoice.prototype, "start").mockResolvedValue();
  const dispose = vi.spyOn(AssistantVoice.prototype, "dispose");
  fireEvent.click(screen.getByRole("button", { name: "音声を開始" }));
  await waitFor(() =>
    expect(AssistantVoice.prototype.start).toHaveBeenCalled(),
  );
  act(() =>
    sockets[0].message({ ...active, type: "snapshot", voice: "stopping" }),
  );
  expect(dispose).toHaveBeenCalled();
  expect(screen.getByText("前の質問")).toBeTruthy();
});
