import type { Answer, Scope } from "../../workers/wiki-assistant/src/contracts";
export type {
  Answer,
  Citation,
  Scope,
} from "../../workers/wiki-assistant/src/contracts";
export type AssistantSnapshot = {
  id: string;
  databaseId: string;
  scope: Scope;
  status: "ready" | "working" | "cancelling";
  error: string | null;
  generation: number;
  reconnectGraceMs: number;
  voiceId?: string | null;
  voiceDeadline?: number | null;
  voice: "off" | "connected" | "stopping";
  progress: { calls: number; stage: string } | null;
  messages: {
    requestId: string;
    question: string;
    answer: Answer | null;
    error: string | null;
  }[];
};
export const CONSENT_VERSION = "2026-09-14";
const errors: Record<string, string> = {
  assistant_disabled: "Ask AI is not available yet.",
  assistant_not_configured: "Ask AI has not been configured yet.",
  authentication_required: "Connect with Internet Identity to use Ask AI.",
  choose_questions_only: "Select “Questions only” in Internet Identity.",
  identity_changed:
    "Your Wiki and Ask AI accounts do not match. Connect with the same account.",
  reconnect_expired:
    "The reconnect window has expired. Start a new conversation.",
  conversation_ended: "The conversation has ended.",
  conversation_already_active:
    "A conversation is already open. End it in the original tab or wait two minutes after disconnecting.",
  conversation_not_owned: "You do not have access to this conversation.",
  cleanup_pending:
    "Confirming deletion of the previous conversation. Please wait.",
  turn_in_progress: "A question is being processed. Please wait or cancel it.",
  question_limit: "You have reached your daily question limit.",
  voice_limit: "You have reached your daily voice limit.",
  turn_timeout: "The request timed out. Try a more specific question.",
  wiki_read_denied: "Unable to verify read access to this Wiki.",
  voice_connection_failed: "Unable to connect voice. You can continue in text.",
  voice_close_pending: "Confirming that the voice session has ended.",
  invalid_citation:
    "The sources could not be verified, so the answer cannot be displayed.",
  unsupported_answer: "No verified sources support this answer.",
  checking_request_status:
    "The connection was interrupted. Checking the request status.",
  cancel_requested: "Cancellation requested.",
  voice_transcript_missing:
    "The spoken question could not be identified. Please try again.",
  voice_context_limit:
    "The voice conversation has reached its length limit. You can continue in text.",
};
export function assistantError(code: string): string {
  return (
    errors[code] ??
    "Ask AI could not complete the request. Check your connection and settings."
  );
}
export class AssistantRequestError extends Error {
  constructor(readonly code: string) {
    super(assistantError(code));
  }
}
export function assistantUrl(path: string, conversationId?: string): string {
  return `/api/assistant${path}${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`;
}
export async function assistantRequest<T>(
  path: string,
  options: {
    body?: unknown;
    conversationId?: string;
    signal?: AbortSignal;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const response = await fetch(assistantUrl(path, options.conversationId), {
    method: options.body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    signal: options.signal,
    keepalive: options.keepalive,
    headers:
      options.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = await response.json().catch(() => {
    throw new AssistantRequestError("request_failed");
  });
  if (!response.ok)
    throw new AssistantRequestError(
      typeof value?.error === "string" ? value.error : "request_failed",
    );
  return value as T;
}

export class AssistantControl {
  private socket: WebSocket | null = null;
  private generation = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  attach(socket: WebSocket) {
    this.detach();
    this.generation = 0;
    this.socket = socket;
  }
  detach() {
    this.socket = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AssistantRequestError("connection_lost"));
    }
    this.pending.clear();
  }
  receive(value: {
    type?: string;
    generation?: number;
    requestId?: string;
    status?: number;
    body?: unknown;
  }) {
    if (value.type === "snapshot" && typeof value.generation === "number")
      this.generation = Math.max(this.generation, value.generation);
    if (value.type !== "command.result" || !value.requestId) return false;
    const p = this.pending.get(value.requestId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(value.requestId);
      if ((value.status ?? 500) < 300) p.resolve(value.body);
      else
        p.reject(
          new AssistantRequestError(
            (value.body as { error?: string })?.error ?? "request_failed",
          ),
        );
    }
    return true;
  }
  command<T>(
    action: string,
    payload: Record<string, unknown>,
    requestId: string = crypto.randomUUID(),
  ): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new AssistantRequestError("connection_lost"));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AssistantRequestError("command_outcome_pending"));
      }, 95000);
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.socket!.send(
          JSON.stringify({
            type: "command",
            action,
            payload,
            requestId,
            generation: this.generation,
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
}

export class AssistantVoice {
  private peer: RTCPeerConnection | null = null;
  private microphone: MediaStream | null = null;
  private channel: RTCDataChannel | null = null;
  private disposed = false;
  private opened = false;
  private voiceId: string | null = null;
  constructor(
    private audio: HTMLAudioElement,
    private onStatus: (status: string) => void,
    private control: AssistantControl,
  ) {}
  get isClosed(): boolean {
    return this.disposed;
  }
  async start(conversationId: string): Promise<void> {
    try {
      const peer = new RTCPeerConnection();
      this.peer = peer;
      peer.addEventListener("track", (event) => {
        if (this.disposed) return;
        this.audio.srcObject = new MediaStream([event.track]);
        void this.audio
          .play()
          .catch(() => this.onStatus("Press Play on the audio player."));
      });
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (this.disposed) {
        microphone.getTracks().forEach((track) => track.stop());
        return;
      }
      this.microphone = microphone;
      for (const track of microphone.getAudioTracks())
        peer.addTrack(track, microphone);
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.addEventListener("message", (event) => {
        try {
          const value = JSON.parse(event.data);
          if (value.type === "session.started") {
            this.opened = true;
            this.onStatus("Voice is ready. Sources will appear on screen.");
          }
          if (value.type === "session.closed") {
            this.dispose();
            this.onStatus("Voice has ended.");
          }
        } catch {
          this.onStatus("Unable to read the voice event.");
        }
      });
      channel.addEventListener("close", () => {
        if (!this.disposed) {
          this.dispose();
          this.onStatus("Voice disconnected. You can continue in text.");
        }
      });
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete")
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            peer.removeEventListener("icegatheringstatechange", check);
            reject(new Error("Voice connection setup timed out."));
          }, 10000);
          const check = () => {
            if (peer.iceGatheringState === "complete") {
              clearTimeout(timer);
              peer.removeEventListener("icegatheringstatechange", check);
              resolve();
            }
          };
          peer.addEventListener("icegatheringstatechange", check);
          check();
        });
      if (this.disposed) return;
      const result = await this.control.command<{
        sdp: string;
        voiceId: string;
      }>("voice", { sdp: peer.localDescription?.sdp });
      this.voiceId = result.voiceId;
      if (this.disposed) {
        void assistantRequest("/voice/stop", {
          conversationId,
          body: { voiceId: this.voiceId },
        }).catch(() => {});
        return;
      }
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
    } catch (error) {
      this.dispose();
      void assistantRequest("/voice/stop", {
        conversationId,
        body: { voiceId: this.voiceId },
      }).catch(() => {});
      throw error;
    }
  }
  async stop(conversationId: string): Promise<void> {
    this.audio.muted = true;
    this.microphone?.getTracks().forEach((track) => {
      track.enabled = false;
    });
    if (this.opened && this.channel?.readyState === "open")
      this.channel.send(JSON.stringify({ type: "session.close" }));
    try {
      if (this.voiceId)
        await assistantRequest("/voice/stop", {
          conversationId,
          body: { voiceId: this.voiceId },
        });
    } finally {
      this.dispose();
    }
  }
  muteOutput(): void {
    this.audio.muted = true;
  }
  dispose(): void {
    this.disposed = true;
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.channel?.close();
    this.peer?.close();
    this.audio.srcObject = null;
  }
}
