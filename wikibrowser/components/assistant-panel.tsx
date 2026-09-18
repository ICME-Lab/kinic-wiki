"use client";
import { useEffect, useRef, useState } from "react";
import { MessageCircle, Mic, Send, Square, X } from "lucide-react";
import {
  assistantRequest,
  assistantSnapshot,
  assistantUrl,
  assistantError,
  AssistantRequestError,
  AssistantVoice,
  AssistantControl,
  CONSENT_VERSION,
  type AssistantSnapshot,
  type AssistantState,
  type AssistantCommandResult,
  type Citation,
  type Scope,
} from "@/lib/assistant";

export function AssistantPanel({
  databaseId,
  principal,
  selectedPath,
  onOpenSource,
}: {
  databaseId: string;
  principal: string | null;
  selectedPath: string;
  onOpenSource: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="border-t border-line bg-paper/50"
      data-tid="assistant-panel"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-semibold text-ink hover:bg-paper focus-visible:outline focus-visible:outline-2"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MessageCircle size={16} />
        Ask AI{" "}
        <span className="ml-auto text-xs font-normal text-muted">
          Answers with sources · Invite only
        </span>
      </button>
      {open && (
        <Conversation
          key={`${databaseId}:${principal ?? "guest"}`}
          databaseId={databaseId}
          principal={principal}
          selectedPath={selectedPath}
          onOpenSource={onOpenSource}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
function Conversation({
  databaseId,
  principal,
  selectedPath,
  onOpenSource,
  onClose,
}: {
  databaseId: string;
  principal: string | null;
  selectedPath: string;
  onOpenSource: (path: string) => void;
  onClose: () => void;
}) {
  const [consent, setConsent] = useState(false);
  const [scope, setScope] = useState<Scope>("/Knowledge");
  const [available, setAvailable] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [snapshot, setSnapshot] = useState<AssistantSnapshot | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const idRef = useRef<string | null>(null);
  const [control] = useState(() => new AssistantControl());
  const voice = useRef<AssistantVoice | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const live = useRef(true);
  const popup = useRef<Window | null>(null);
  const pendingQuestion = useRef<{
    requestId: string;
    question: string;
    scope: Scope;
    selectedPath: string;
  } | null>(null);
  const refreshSnapshot = useRef<
    ((revision: number) => Promise<void>) | null
  >(null);
  const latestRevision = useRef<{ id: string; revision: number } | null>(null);
  useEffect(() => {
    if (
      snapshot &&
      (latestRevision.current?.id !== snapshot.id ||
        latestRevision.current.revision < snapshot.revision)
    )
      latestRevision.current = { id: snapshot.id, revision: snapshot.revision };
  }, [snapshot]);
  const report = (cause: unknown) => {
    if (live.current)
      setError(cause instanceof Error ? cause.message : "Unable to connect.");
  };
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    void assistantRequest("/status", { signal: controller.signal })
      .then(() => {
        if (live.current) setAvailable(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) report(cause);
      });
    const checkAuth = async () => {
      try {
        const result = await assistantRequest<{ principal: string }>("/auth", {
          signal: controller.signal,
        });
        if (!live.current || controller.signal.aborted) return;
        if (result.principal !== principal) {
          setAuthorized(false);
          setError(assistantError("identity_changed"));
          return;
        }
        setAuthorized(true);
        try {
          const metadata = await assistantRequest<AssistantState>("/active", {
            signal: controller.signal,
          });
          const active = await assistantSnapshot(
            metadata.id,
            metadata,
            controller.signal,
          );
          if (!live.current || controller.signal.aborted) return;
          if (active.databaseId !== databaseId) {
            await assistantRequest("/end", {
              conversationId: active.id,
              body: {},
            });
            return;
          }
          idRef.current = active.id;
          setScope(active.scope);
          setConsent(true);
          setSnapshot(active);
        } catch (cause) {
          if (!(
            cause instanceof AssistantRequestError &&
            cause.code === "conversation_ended"
          ))
            report(cause);
        }
      } catch {
        /* An unconnected user can explicitly authorize below. */
      }
    };
    if (principal) void checkAuth();
    const receive = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.source === popup.current &&
        event.data?.type === "kinic-assistant-connected"
      ) {
        setError(null);
        void checkAuth();
      }
    };
    window.addEventListener("message", receive);
    const unload = () => {
      voice.current?.dispose();
      if (idRef.current)
        void assistantRequest("/end", {
          conversationId: idRef.current,
          body: {},
          keepalive: true,
        }).catch(() => {});
    };
    window.addEventListener("pagehide", unload);
    return () => {
      live.current = false;
      controller.abort();
      window.removeEventListener("message", receive);
      window.removeEventListener("pagehide", unload);
      unload();
      popup.current?.close();
    };
  }, [databaseId, principal]);
  useEffect(() => {
    const id = snapshot?.id;
    if (!id) return;
    const grace = snapshot.reconnectGraceMs;
    let disposed = false;
    let generation = 0;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const stateController = new AbortController();
    let appliedRevision =
      latestRevision.current?.id === id ? latestRevision.current.revision : 0;
    let requestedRevision = appliedRevision;
    let stateRefresh: Promise<void> | null = null;
    const applySnapshot = (next: AssistantSnapshot) => {
      if (next.revision <= appliedRevision) return;
      appliedRevision = next.revision;
      setSnapshot((current) =>
        current && current.revision >= next.revision ? current : next,
      );
    };
    const requestRefresh = (revision: number): Promise<void> => {
      requestedRevision = Math.max(requestedRevision, revision);
      if (stateRefresh) return stateRefresh;
      let failed = false;
      stateRefresh = (async () => {
        try {
          while (!disposed && appliedRevision < requestedRevision) {
            const next = await assistantSnapshot(
              id,
              undefined,
              stateController.signal,
            );
            if (disposed) return;
            applySnapshot(next);
          }
        } catch (cause) {
          failed = true;
          throw cause;
        } finally {
          stateRefresh = null;
          if (!failed && !disposed && appliedRevision < requestedRevision)
            void requestRefresh(requestedRevision).catch(report);
        }
      })();
      return stateRefresh;
    };
    refreshSnapshot.current = requestRefresh;
    const release = () => {
      clearTimeout(retry);
      clearTimeout(deadline);
      controller?.abort();
      stateController.abort();
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.close();
      }
    };
    const ended = (code: string) => {
      if (disposed) return;
      disposed = true;
      generation++;
      release();
      idRef.current = null;
      pendingQuestion.current = null;
      setQuestion("");
      setSnapshot(null);
      voice.current?.dispose();
      voice.current = null;
      setVoiceStatus("");
      if (
        ["authentication_required", "identity_changed"].includes(code)
      )
        setAuthorized(false);
      if (["assistant_disabled", "assistant_not_configured"].includes(code))
        setAvailable(false);
      setError(assistantError(code));
    };
    const terminal = new Set([
      "conversation_ended",
      "conversation_not_owned",
      "authentication_required",
      "identity_changed",
      "assistant_disabled",
      "assistant_not_configured",
      "wiki_read_denied",
    ]);
    const reconnect = async () => {
      if (disposed) return;
      const attempt = ++generation;
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await assistantSnapshot(id, undefined, controller.signal);
        applySnapshot(next);
        if (!disposed && attempt === generation) connect();
      } catch (cause) {
        if (disposed || attempt !== generation) return;
        if (cause instanceof AssistantRequestError && terminal.has(cause.code))
          ended(cause.code);
        else retry = setTimeout(() => void reconnect(), 3000);
      }
    };
    const connect = () => {
      const attempt = ++generation;
      const url = new URL(assistantUrl("/events", id), location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket = ws;
      control.attach(ws);
      ws.onmessage = (event) => {
        if (disposed || attempt !== generation) return;
        try {
          const value = JSON.parse(event.data);
          if (control.receive(value)) return;
          if (value.type === "snapshot" && value.id === id) {
            clearTimeout(deadline);
            deadline = undefined;
            if (typeof value.revision !== "number")
              throw new Error("Unable to read the conversation state.");
            if (value.revision > appliedRevision)
              void requestRefresh(value.revision).catch(report);
          }
          if (value.type === "ended") ended("conversation_ended");
        } catch {
          setError("Unable to read the conversation state.");
        }
      };
      ws.onclose = () => {
        if (disposed || attempt !== generation) return;
        generation++;
        control.detach();
        voice.current?.dispose();
        voice.current = null;
        if (deadline === undefined)
          deadline = setTimeout(() => ended("reconnect_expired"), grace);
        retry = setTimeout(() => void reconnect(), 3000);
      };
    };
    connect();
    const heartbeat = setInterval(() => {
      if (!disposed && socket?.readyState === WebSocket.OPEN)
        socket.send("heartbeat");
    }, 10000);
    return () => {
      disposed = true;
      generation++;
      release();
      control.detach();
      if (refreshSnapshot.current === requestRefresh)
        refreshSnapshot.current = null;
      clearInterval(heartbeat);
    };
  }, [snapshot?.id, snapshot?.reconnectGraceMs, control]);
  useEffect(() => {
    if (snapshot?.voice === "stopping" || snapshot?.voice === "off") {
      if (voice.current)
        setVoiceStatus("Voice has ended. You can continue in text.");
      voice.current?.dispose();
      voice.current = null;
    }
  }, [snapshot?.voice]);
  async function authorize() {
    setBusy(true);
    setError(null);
    popup.current = window.open(
      "about:blank",
      "kinic-assistant-auth",
      "width=520,height=720",
    );
    try {
      const result = await assistantRequest<{ url: string }>("/auth/start", {
        body: { consent: CONSENT_VERSION },
      });
      if (!popup.current)
        throw new Error("Allow pop-ups and try connecting again.");
      popup.current.location.href = result.url;
    } catch (cause) {
      popup.current?.close();
      report(cause);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const metadata = await assistantRequest<AssistantState>("/conversations", {
        body: { databaseId, scope, consent: CONSENT_VERSION },
      });
      const c = await assistantSnapshot(metadata.id, metadata);
      if (!live.current) {
        void assistantRequest("/end", { conversationId: c.id, body: {} }).catch(
          () => {},
        );
        return;
      }
      idRef.current = c.id;
      setSnapshot(c);
    } catch (cause) {
      report(cause);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function ask() {
    if (!snapshot || !question.trim()) return;
    setBusy(true);
    setError(null);
    const previous = pendingQuestion.current;
    const body =
      previous?.question === question.trim()
        ? previous
        : {
            requestId: crypto.randomUUID(),
            question: question.trim(),
            scope: snapshot.scope,
            selectedPath,
          };
    pendingQuestion.current = body;
    try {
      const result = await control.command<AssistantCommandResult>(
        "questions",
        body,
        body.requestId,
      );
      await refreshSnapshot.current?.(result.revision);
      if (live.current && idRef.current === snapshot.id) {
        setQuestion("");
        pendingQuestion.current = null;
      }
    } catch (cause) {
      report(cause);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!snapshot) return;
    voice.current?.muteOutput();
    try {
      const result = await control.command<AssistantCommandResult>(
        "cancel",
        {},
      );
      await refreshSnapshot.current?.(result.revision);
    } catch (cause) {
      report(cause);
    }
  }
  async function toggleVoice() {
    if (!snapshot || !audio.current) return;
    setBusy(true);
    setError(null);
    try {
      if (
        snapshot.voice !== "off" ||
        (voice.current && !voice.current.isClosed)
      ) {
        if (voice.current) await voice.current.stop(snapshot.id);
        else
          await assistantRequest("/voice/stop", {
            conversationId: snapshot.id,
            body: { voiceId: snapshot.voiceId },
          });
        voice.current = null;
      } else {
        audio.current.muted = false;
        voice.current = new AssistantVoice(
          audio.current,
          (status) => {
            if (live.current) setVoiceStatus(status);
          },
          control,
        );
        setVoiceStatus("Connecting voice…");
        await voice.current.start(snapshot.id);
      }
    } catch (cause) {
      voice.current = null;
      report(cause);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function end() {
    setBusy(true);
    try {
      if (idRef.current)
        await assistantRequest("/end", {
          conversationId: idRef.current,
          body: {},
        });
      idRef.current = null;
      voice.current?.dispose();
      onClose();
    } catch (cause) {
      report(cause);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Ask AI conversation"
      className="flex max-h-[65vh] min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4 text-sm"
    >
      {!principal && (
        <p className="text-muted">
          Sign in to the Wiki with Internet Identity to use Ask AI.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800"
        >
          {error}
        </p>
      )}
      {!snapshot && (
        <>
          <p className="text-muted">
            Answers use verified content and sources from the selected database.
            Ask AI cannot edit your Wiki.
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-1"
            />
            <span>
              I consent to sending my questions, necessary Wiki paths and
              previews to TypeSafe, and questions, audio, and necessary Wiki
              excerpts to OpenAI. Both providers process this data in the United
              States. TypeSafe does not train or fine-tune models on Input, but
              retains data as reasonably necessary rather than offering Zero
              Data Retention. Ending a conversation requests deletion of its
              OpenAI session, but does not mean all provider records are erased
              immediately. The app does not retain audio recordings.
            </span>
          </label>
          <label className="flex items-center gap-2">
            Search scope
            <select
              className="rounded border border-line bg-white p-2"
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
            >
              <option value="/Knowledge">Knowledge</option>
              <option value="/Memory">Memory</option>
            </select>
          </label>
          <p className="text-xs text-muted">
            Default limits: 50 questions and 20 minutes of voice per day, with
            10 minutes per voice session. Select “Questions only” when
            connecting with Internet Identity.
          </p>
          <button
            type="button"
            disabled={!principal || !available || !consent || busy}
            className="rounded-lg bg-ink px-4 py-2 font-semibold text-white disabled:opacity-40"
            onClick={() => void (authorized ? start() : authorize())}
          >
            {busy
              ? "Connecting…"
              : authorized
                ? "Start conversation"
                : "Connect Ask AI with Internet Identity"}
          </button>
        </>
      )}
      {snapshot && (
        <>
          <div className="flex items-center justify-between text-xs text-muted">
            <span>{scope} · This database only</span>
            <button
              type="button"
              onClick={() => void end()}
              disabled={busy}
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-paper"
            >
              <X size={14} />
              End conversation
            </button>
          </div>
          <div className="space-y-4" aria-live="polite">
            {snapshot.messages.length === 0 && (
              <p className="py-5 text-muted">
                Ask a question about this Wiki. Verified content and sources
                will appear here.
              </p>
            )}
            {snapshot.messages.map((m) => (
              <article key={m.requestId} className="space-y-2">
                <p className="whitespace-pre-wrap rounded-lg bg-paper p-3 font-medium">
                  {m.question}
                </p>
                {m.error && (
                  <p className="text-muted">{assistantError(m.error)}</p>
                )}
                {m.answer && (
                  <>
                    <p className="whitespace-pre-wrap leading-relaxed">
                      {m.answer.answer}
                    </p>
                    {m.answer.insufficient && (
                      <p className="font-medium text-amber-800">
                        There is not enough verified evidence.
                      </p>
                    )}
                    {m.answer.contradictions.map((text, i) => (
                      <p key={i} className="text-amber-800">
                        Conflicts: {text}
                      </p>
                    ))}
                    {m.answer.unverified.map((text, i) => (
                      <p key={i} className="text-muted">
                        Unverified: {text}
                      </p>
                    ))}
                    <div className="space-y-2">
                      {m.answer.citations.map((citation) => (
                        <Source
                          key={citation.id}
                          citation={citation}
                          conversationId={snapshot.id}
                          onOpenSource={onOpenSource}
                        />
                      ))}
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
          {snapshot.progress && (
            <output className="text-muted">
              Checking Wiki sources… ({snapshot.progress.calls} tool calls)
            </output>
          )}
          {snapshot.error && (
            <output className="text-amber-800">
              {assistantError(snapshot.error)}
            </output>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
            className="flex items-end gap-2"
          >
            <label className="flex-1">
              <span className="sr-only">Question about the Wiki</span>
              <textarea
                rows={2}
                maxLength={4000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask a question about this Wiki…"
                className="w-full resize-y rounded-lg border border-line bg-white p-3"
              />
            </label>
            <button
              type="submit"
              aria-label="Send question"
              disabled={busy || !question.trim() || snapshot.status !== "ready"}
              className="rounded-lg bg-ink p-3 text-white disabled:opacity-40"
            >
              <Send size={18} />
            </button>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={
                busy ||
                (snapshot.voice === "off" && snapshot.status !== "ready")
              }
              onClick={() => void toggleVoice()}
              className="flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-2 disabled:opacity-40"
            >
              <Mic size={16} />
              {snapshot.voice === "off" ? "Start voice" : "Stop voice"}
            </button>
            {snapshot.status !== "ready" && (
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={snapshot.status === "cancelling"}
                className="flex items-center gap-1 rounded-lg border border-line px-3 py-2"
              >
                <Square size={13} />
                {snapshot.status === "cancelling"
                  ? "Cancelling…"
                  : "Cancel request"}
              </button>
            )}
          </div>
        </>
      )}
      <output className="text-xs text-muted">{voiceStatus}</output>
      <audio
        ref={audio}
        controls
        className={
          snapshot?.voice !== "off" && snapshot ? "h-9 w-full" : "hidden"
        }
      >
        <track kind="captions" />
      </audio>
    </section>
  );
}
function Source({
  citation,
  conversationId,
  onOpenSource,
}: {
  citation: Citation;
  conversationId: string;
  onOpenSource: (path: string) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  async function openSource() {
    try {
      const result = await assistantRequest<{
        changed: boolean;
        missing: boolean;
      }>("/citation", { conversationId, body: { citationId: citation.id } });
      setNotice(
        result.missing
          ? "The source page is no longer available."
          : result.changed
            ? "This page has changed since the answer was generated. The excerpt below is from the version used for the answer."
            : "This is the same version used for the answer.",
      );
      if (!result.missing) onOpenSource(citation.path);
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : "Unable to check the current version.",
      );
    }
  }
  return (
    <details className="rounded-lg border border-line bg-white p-3">
      <summary className="cursor-pointer break-all font-medium">
        {citation.path}
      </summary>
      <blockquote className="my-2 whitespace-pre-wrap border-l-2 border-line pl-3 text-muted">
        {citation.excerpt}
      </blockquote>
      <p className="break-all text-xs text-muted">
        Position {citation.start}–{citation.end} · etag {citation.etag} ·{" "}
        {citation.retrievedAt}
      </p>
      <button
        type="button"
        className="mt-2 underline"
        onClick={() => void openSource()}
      >
        Check current version and open
      </button>
      {notice && <output className="mt-2 text-amber-800">{notice}</output>}
    </details>
  );
}
