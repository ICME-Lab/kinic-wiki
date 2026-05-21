"use client";

import type { Identity } from "@icp-sdk/core/agent";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { AlertTriangle, Clock3, Link2, MessageSquareText, Search, ShieldCheck } from "lucide-react";
import { RecentPanel } from "@/components/recent-panel";
import { createUrlIngestRequest } from "@/lib/url-ingest";
import { collectLintHints, type LintHint } from "@/lib/lint-hints";
import { classifyQueryInput, type QueryAction } from "@/lib/query-actions";
import { collectQueryAnswerContext } from "@/lib/query-context";
import { hrefForPath } from "@/lib/paths";
import type { ReadIdentityMode } from "@/lib/wiki-helpers";
import { errorMessage } from "@/lib/wiki-helpers";
import type { SearchNodeHit, WikiNode } from "@/lib/types";
import { authorizeQueryAnswerSession, readNode, searchNodes } from "@/lib/vfs-client";

type QueryResult =
  | { kind: "message"; text: string; tone: "info" | "error" }
  | { kind: "lint"; targetPath: string; hints: LintHint[] }
  | { kind: "search"; query: string; hits: SearchNodeHit[] }
  | { kind: "answer"; answer: string; citations: string[]; abstained: boolean };

export function QueryPanel({
  canisterId,
  databaseId,
  selectedPath,
  currentNode,
  readIdentity,
  writeIdentity,
  readMode,
  readIdentityMode
}: {
  canisterId: string;
  databaseId: string;
  selectedPath: string;
  currentNode: WikiNode | null;
  readIdentity: Identity | null;
  writeIdentity: Identity | null;
  readMode: "anonymous" | null;
  readIdentityMode: ReadIdentityMode;
}) {
  const [input, setInput] = useState("");
  const [activeAction, setActiveAction] = useState<QueryAction | null>(null);
  const [pendingAction, setPendingAction] = useState<QueryAction | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastAskAtMs, setLastAskAtMs] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = classifyQueryInput(input, selectedPath, readIdentityMode);
    if (!action) {
      setPendingAction(null);
      setResult({ kind: "message", tone: "error", text: "No supported operation found. Use recent, lint, a URL, or a wiki question." });
      return;
    }
    setInput("");
    await handleAction(action);
  }

  async function handleAction(action: QueryAction) {
    setResult(null);
    setActiveAction(action);
    if (action.kind === "queue_url") {
      setPendingAction(action);
      return;
    }
    setPendingAction(null);
    if (action.kind === "recent") return;
    if (action.kind === "search") {
      await searchWiki(action);
      return;
    }
    if (action.kind === "ask") {
      await answerQuestion(action);
      return;
    }
    setBusy(true);
    try {
      const node = action.targetPath === selectedPath ? currentNode : await readNode(canisterId, databaseId, action.targetPath, readIdentity ?? undefined);
      if (!node) {
        setResult({ kind: "message", tone: "error", text: `Node not found: ${action.targetPath}` });
        return;
      }
      setResult({ kind: "lint", targetPath: action.targetPath, hints: collectLintHints(action.targetPath, node.content) });
    } catch (cause) {
      setResult({ kind: "message", tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function searchWiki(action: Extract<QueryAction, { kind: "search" }>) {
    setBusy(true);
    try {
      const hits = await searchNodes(canisterId, databaseId, action.query, 10, action.targetPath, readIdentity ?? undefined);
      setResult({ kind: "search", query: action.query, hits });
    } catch (cause) {
      setResult({ kind: "message", tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function answerQuestion(action: Extract<QueryAction, { kind: "ask" }>) {
    if (!writeIdentity) {
      setResult({ kind: "message", tone: "error", text: "Login with Internet Identity to ask wiki questions." });
      return;
    }
    const now = Date.now();
    if (now - lastAskAtMs < 2_000) {
      setResult({ kind: "message", tone: "error", text: "Wait a moment before asking again." });
      return;
    }
    setLastAskAtMs(now);
    setBusy(true);
    try {
      const sessionNonce = crypto.randomUUID();
      await authorizeQueryAnswerSession(canisterId, writeIdentity, { databaseId, sessionNonce });
      const context = await collectQueryAnswerContext({ canisterId, databaseId, question: action.question, selectedPath, currentNode, readIdentity });
      const response = await fetch("/api/query/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: action.question, databaseId, selectedPath, sessionNonce, context })
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === "string" ? body.error : `answer failed: HTTP ${response.status}`;
        throw new Error(message);
      }
      if (!isAnswerBody(body)) throw new Error("answer response shape is invalid");
      setResult({ kind: "answer", answer: body.answer, citations: body.citations, abstained: body.abstained });
    } catch (cause) {
      setResult({ kind: "message", tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function confirmQueueUrl(action: QueryAction) {
    if (action.kind !== "queue_url") return;
    if (!writeIdentity) {
      setResult({ kind: "message", tone: "error", text: "Login with Internet Identity to queue URL ingest." });
      return;
    }
    setBusy(true);
    try {
      const created = await createUrlIngestRequest(canisterId, databaseId, writeIdentity, action.url);
      setPendingAction(null);
      setResult({
        kind: "message",
        tone: created.triggered ? "info" : "error",
        text: created.triggered ? `Queued and started ${created.requestPath}` : `Queued ${created.requestPath}. ${created.triggerError}`
      });
    } catch (cause) {
      setResult({ kind: "message", tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  const previewAction = pendingAction ?? activeAction;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden text-sm">
      <form className="border-b border-line p-3" onSubmit={submit}>
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-muted" htmlFor="query-command">Query</label>
          <span className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">Search by default</span>
        </div>
        <div className="mt-2 grid gap-2">
          <textarea
            id="query-command"
            className="min-h-[112px] w-full resize-none rounded-lg border border-line bg-white px-3 py-2.5 text-sm leading-5 outline-none placeholder:text-muted focus:border-accent"
            placeholder="Search keywords, or type: ask: question, lint facts, recent, https://..."
            rows={4}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <button className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-action bg-action px-3 text-sm font-bold text-white hover:border-accent hover:bg-accent disabled:opacity-60" disabled={busy || !input.trim()} type="submit" title="Run query">
            <ShieldCheck size={15} />
            <span>Run</span>
          </button>
        </div>
      </form>
      {previewAction ? <ActionPreview action={previewAction} busy={busy} onConfirm={pendingAction ? () => void confirmQueueUrl(pendingAction) : null} /> : null}
      <QueryResultView canisterId={canisterId} databaseId={databaseId} readMode={readMode} result={result} />
      {activeAction?.kind === "recent" ? <RecentPanel canisterId={canisterId} databaseId={databaseId} readIdentity={readIdentity} readMode={readMode} /> : null}
    </div>
  );
}

function ActionPreview({ action, busy, onConfirm }: { action: QueryAction; busy: boolean; onConfirm: (() => void) | null }) {
  const icon = action.kind === "ask" ? <MessageSquareText size={15} /> : action.kind === "search" ? <Search size={15} /> : action.kind === "lint" ? <AlertTriangle size={15} /> : action.kind === "queue_url" ? <Link2 size={15} /> : <Clock3 size={15} />;
  const title = action.kind === "ask" ? "LLM answer" : action.kind === "search" ? "Search wiki" : action.kind === "lint" ? "Lint note" : action.kind === "queue_url" ? "Queue URL" : "Recent nodes";
  const target = action.kind === "queue_url" ? action.url : action.targetPath ?? "current database";
  return (
    <div className="border-b border-line bg-paper px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-accent">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-ink">{title}</span>
            {action.kind === "ask" ? <MetaBadge>LLM</MetaBadge> : null}
            {action.kind === "search" ? <MetaBadge>non-LLM</MetaBadge> : null}
            <MetaBadge>{action.identityMode}</MetaBadge>
            <MetaBadge>{action.sideEffect === "none" ? "read-only" : action.sideEffect}</MetaBadge>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted">{target}</p>
        </div>
      </div>
      {onConfirm ? (
        <button className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-action bg-action px-3 text-xs font-bold text-white hover:border-accent hover:bg-accent disabled:opacity-60" disabled={busy} type="button" onClick={onConfirm}>
          <Link2 size={13} />
          {busy ? "Queueing..." : "Confirm queue"}
        </button>
      ) : null}
    </div>
  );
}

function MetaBadge({ children }: { children: ReactNode }) {
  return <span className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">{children}</span>;
}

function QueryResultView({ canisterId, databaseId, readMode, result }: { canisterId: string; databaseId: string; readMode: "anonymous" | null; result: QueryResult | null }) {
  if (!result) return null;
  if (result.kind === "message") {
    return <div className={`m-3 rounded-lg border px-3 py-2 text-xs leading-5 ${result.tone === "error" ? "border-red-200 bg-red-50 text-red-900" : "border-line bg-white text-ink"}`}>{result.text}</div>;
  }
  if (result.kind === "answer") {
    return (
      <div className={`m-3 space-y-3 rounded-lg border bg-white p-3 text-sm ${result.abstained ? "border-yellow-200" : "border-line"}`}>
        <p className="whitespace-pre-wrap leading-6 text-ink">{result.answer}</p>
        {result.abstained ? <p className="text-yellow-800">根拠不足を含む回答。</p> : null}
        {result.citations.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted">Citations</p>
            {result.citations.map((path) => (
              <a key={path} className="block truncate font-mono text-accent no-underline hover:underline" href={hrefForPath(canisterId, databaseId, path, undefined, "query", undefined, undefined, readMode)}>
                {path}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (result.kind === "search") {
    return (
      <div className="m-3 space-y-2 rounded-lg border border-line bg-white p-3 text-xs leading-5">
        <p className="font-semibold text-ink">Search results for {result.query}</p>
        {result.hits.length === 0 ? <p className="text-muted">No results.</p> : null}
        {result.hits.map((hit) => {
          const excerpt = resultExcerpt(hit);
          return (
            <a key={`${hit.path}:${hit.score}`} className="block rounded border border-line bg-paper p-2 no-underline hover:border-accent" href={hrefForPath(canisterId, databaseId, hit.path, undefined, "query", undefined, undefined, readMode)}>
              <span className="block truncate font-mono text-accent">{hit.path}</span>
              {excerpt ? <span className="mt-1 block text-ink">{excerpt}</span> : null}
            </a>
          );
        })}
      </div>
    );
  }
  return (
    <div className="m-3 space-y-2 rounded-lg border border-line bg-white p-3 text-xs leading-5">
      <a className="font-mono text-accent no-underline hover:underline" href={hrefForPath(canisterId, databaseId, result.targetPath, "raw", "query", undefined, undefined, readMode)}>
        {result.targetPath}
      </a>
      {result.hints.length === 0 ? <p className="text-green-700">No lightweight warnings.</p> : null}
      {result.hints.map((hint) => (
        <div key={`${hint.title}:${hint.line ?? "note"}`} className="rounded border border-yellow-200 bg-yellow-50 p-2 text-yellow-950">
          <p className="font-semibold">{hint.title}</p>
          <p className="mt-1">{hint.detail}</p>
          {hint.preview ? <p className="mt-1 font-mono">{hint.preview}</p> : null}
        </div>
      ))}
    </div>
  );
}

function resultExcerpt(hit: SearchNodeHit): string | null {
  if (hit.preview?.excerpt) return hit.preview.excerpt;
  if (hit.snippet && hit.snippet !== hit.path) return hit.snippet;
  return null;
}

function isAnswerBody(value: unknown): value is { answer: string; citations: string[]; abstained: boolean } {
  return isRecord(value) && typeof value.answer === "string" && Array.isArray(value.citations) && value.citations.every((item) => typeof item === "string") && typeof value.abstained === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
