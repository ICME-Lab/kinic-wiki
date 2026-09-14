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
  assistant_disabled: "Ask AIはまだ公開されていません。",
  assistant_not_configured: "Ask AIのAPI設定がまだ完了していません。",
  authentication_required: "Ask AI用のInternet Identity接続が必要です。",
  invitation_required: "Ask AIは招待された利用者のみ利用できます。",
  choose_questions_only:
    "Internet Identityで「Questions only」を選んでください。",
  identity_changed:
    "WikiとAsk AIのアカウントが異なります。同じアカウントで接続してください。",
  reconnect_expired:
    "復帰猶予を過ぎたため接続を終了しました。会話を開始し直してください。",
  conversation_ended: "会話は終了しました。",
  conversation_already_active:
    "既に会話が開かれています。元の画面で終了するか、切断後2分お待ちください。",
  conversation_not_owned: "この会話にはアクセスできません。",
  cleanup_pending: "前の会話の削除を確認中です。しばらくお待ちください。",
  turn_in_progress: "回答を確認しています。待つか、処理を取り消してください。",
  question_limit: "本日の質問回数の上限に達しました。",
  voice_limit: "本日の音声時間の上限に達しました。",
  turn_timeout:
    "確認に時間がかかりすぎました。質問を絞って再度お試しください。",
  wiki_read_denied: "Wikiの読み取り権限を確認できませんでした。",
  voice_connection_failed:
    "音声に接続できませんでした。テキストで続けられます。",
  voice_close_pending: "音声の終了を確認しています。",
  invalid_citation: "出典を検証できないため、回答を表示できません。",
  unsupported_answer: "回答を支える出典を確認できませんでした。",
  checking_request_status: "通信が途切れたため、処理結果を確認しています。",
  cancel_requested: "処理の取消を要求しました。",
  voice_transcript_missing:
    "音声の質問を確認できませんでした。もう一度お話しください。",
  voice_context_limit:
    "音声会話の長さの上限に達しました。テキストで続けられます。",
};
export function assistantError(code: string): string {
  return (
    errors[code] ?? "Ask AIの処理に失敗しました。接続と設定を確認してください。"
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

export class AssistantVoice {
  private peer: RTCPeerConnection | null = null;
  private microphone: MediaStream | null = null;
  private channel: RTCDataChannel | null = null;
  private disposed = false;
  private opened = false;
  constructor(
    private audio: HTMLAudioElement,
    private onStatus: (status: string) => void,
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
          .catch(() =>
            this.onStatus("音声プレーヤーの再生ボタンを押してください。"),
          );
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
            this.onStatus("音声で話せます。出典は画面に表示します。");
          }
          if (value.type === "session.closed") {
            this.dispose();
            this.onStatus("音声を終了しました。");
          }
        } catch {
          this.onStatus("音声イベントを確認できませんでした。");
        }
      });
      channel.addEventListener("close", () => {
        if (!this.disposed) {
          this.dispose();
          this.onStatus("音声接続が切れました。テキストで続けられます。");
        }
      });
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete")
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            peer.removeEventListener("icegatheringstatechange", check);
            reject(new Error("音声接続の準備がタイムアウトしました。"));
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
      const result = await assistantRequest<{ sdp: string }>("/voice", {
        conversationId,
        body: { sdp: peer.localDescription?.sdp },
      });
      if (this.disposed) {
        void assistantRequest("/voice/stop", {
          conversationId,
          body: {},
        }).catch(() => {});
        return;
      }
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
    } catch (error) {
      this.dispose();
      void assistantRequest("/voice/stop", { conversationId, body: {} }).catch(
        () => {},
      );
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
      await assistantRequest("/voice/stop", { conversationId, body: {} });
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
