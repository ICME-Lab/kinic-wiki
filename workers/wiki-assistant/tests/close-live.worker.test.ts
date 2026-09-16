import { expect, it, vi } from "vitest";
import { closeLiveSession } from "../src/openai";
import { AssistantError } from "../src/contracts";
class Socket extends EventTarget {
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  emit(event: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(event) }),
    );
  }
}
it("returns the reported usage seconds from session.closed", async () => {
  const ws = new Socket();
  const pending = closeLiveSession("key", "live-1", ws as unknown as WebSocket);
  expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
    type: "session.close",
  });
  ws.emit({ type: "session.closed", usage: { seconds: 42 } });
  expect(await pending).toBe(42);
  expect(ws.close).toHaveBeenCalled();
});
it("ignores unrelated events until the lifecycle event arrives", async () => {
  const ws = new Socket();
  const pending = closeLiveSession("key", "live-1", ws as unknown as WebSocket);
  ws.emit({ type: "session.input_transcript.delta", delta: "hi" });
  ws.emit({ type: "session.closed", usage: { seconds: 5 } });
  expect(await pending).toBe(5);
});
it("rejects when the provider never confirms the close", async () => {
  vi.useFakeTimers();
  try {
    const ws = new Socket();
    const pending = closeLiveSession("key", "live-1", ws as unknown as WebSocket);
    const assertion = expect(pending).rejects.toThrow(
      "voice_close_unconfirmed",
    );
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(ws.close).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("surfaces a gone session as a terminal provider error", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 410 }));
  try {
    await expect(closeLiveSession("key", "live-1")).rejects.toMatchObject({
      code: "voice_session_gone",
      status: 410,
    });
  } finally {
    fetchMock.mockRestore();
  }
});
it("attaches on demand when no socket is supplied", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => {
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      server.addEventListener("message", () => {
        server.send(
          JSON.stringify({ type: "session.closed", usage: { seconds: 11 } }),
        );
      });
      return { status: 101, webSocket: pair[0] } as unknown as Response;
    },
  );
  try {
    expect(await closeLiveSession("key", "live-1")).toBe(11);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/live/sessions/live-1/attach",
      expect.objectContaining({
        headers: expect.objectContaining({ Upgrade: "websocket" }),
      }),
    );
  } finally {
    fetchMock.mockRestore();
  }
});
it("keeps voice_session_gone unchanged as an AssistantError", () => {
  const error = new AssistantError("voice_session_gone", 410);
  expect(error).toBeInstanceOf(AssistantError);
  expect(error.code).toBe("voice_session_gone");
});

it("waits for durable event processing before resolving or closing the socket", async () => {
  const ws = new Socket();
  let release!: () => void;
  const durable = new Promise<void>((resolve) => { release = resolve; });
  let finished = false;
  const pending = closeLiveSession("key", "live-1", ws as unknown as WebSocket, () => durable).then(() => { finished = true; });
  ws.emit({ type: "session.closed", usage: { seconds: 9 } });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(ws.close).not.toHaveBeenCalled();
  release();
  await pending;
  expect(finished).toBe(true);
  expect(ws.close).toHaveBeenCalledOnce();
});
