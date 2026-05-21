"use client";

import type { Identity } from "@icp-sdk/core/agent";
import type { FormEvent } from "react";
import { useState } from "react";
import { createUrlIngestRequest } from "@/lib/url-ingest";

export function IngestPanel({
  canisterId,
  databaseId,
  readIdentity
}: {
  canisterId: string;
  databaseId: string;
  readIdentity: Identity | null;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"error" | "info">("info");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!readIdentity || !url.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const created = await createUrlIngestRequest(canisterId, databaseId, readIdentity, url);
      setTone(created.triggered ? "info" : "error");
      setMessage(created.triggered ? `Queued and accepted ${created.requestPath}` : `Queued ${created.requestPath}. ${created.triggerError}`);
      setUrl("");
    } catch (cause) {
      setTone("error");
      setMessage(cause instanceof Error ? cause.message : "URL ingest failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!readIdentity) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 text-sm">
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-muted">Login is required to queue URL ingest for this database.</p>
        </div>
      </div>
    );
  }

  const submitDisabled = busy || !url.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 text-sm">
      <form className="grid gap-3" onSubmit={submit}>
        <div>
          <label className="text-xs uppercase tracking-[0.12em] text-muted" htmlFor="ingest-url">
            URL
          </label>
          <input
            id="ingest-url"
            className="mt-2 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-accent"
            placeholder="https://example.com/article"
            value={url}
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <button
          className="rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
          disabled={submitDisabled}
          type="submit"
        >
          {busy ? "Queueing..." : "Queue URL"}
        </button>
      </form>
      <div className="rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-muted">{databaseId}</div>
      {message ? <div className={`rounded-lg border px-3 py-2 text-xs ${tone === "error" ? "border-red-200 bg-red-50 text-red-900" : "border-line bg-white text-ink"}`}>{message}</div> : null}
    </div>
  );
}
