// Where: wikibrowser/components/sources-panel.tsx
// What: Sidebar workflow for saving and searching source URL clips.
// Why: Source clips should be one-step source capture, not a separate app model.

"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { Loader2, Plus, Search } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { ErrorBox } from "@/components/panel";
import { SearchPanel } from "@/components/search-panel";
import { hrefForPath } from "@/lib/paths";
import {
  buildSourceClipDocument,
  extractSourceContentFromHtml,
  parseTags,
  sourceClipSiteFromMetadata,
  sourceClipTagsFromMetadata,
  sourceClipTitleFromMetadata,
  SOURCE_CLIP_PREFIX
} from "@/lib/source-clips";
import type { WikiNode } from "@/lib/types";
import { errorHint, errorMessage, type LoadState } from "@/lib/wiki-helpers";
import { mkdirNodeAuthenticated, readNode, recentNodes, writeNodeAuthenticated } from "@/lib/vfs-client";

type SaveStatus = "idle" | "extracting" | "saving" | "saved" | "error";

type ExtractResponse = {
  url: string;
  html: string;
};

export function SourcesPanel({
  canisterId,
  databaseId,
  readIdentity,
  writeIdentity = readIdentity,
  readMode = null
}: {
  canisterId: string;
  databaseId: string;
  readIdentity: Identity | null;
  writeIdentity?: Identity | null;
  readMode?: "anonymous" | null;
}) {
  const [url, setUrl] = useState("");
  const [userNote, setUserNote] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [query, setQuery] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function saveClip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writeIdentity) {
      setSaveStatus("error");
      setSaveError("Login is required to save source clips.");
      return;
    }
    setSaveStatus("extracting");
    setSaveError(null);
    setSavedPath(null);
    try {
      const extracted = await fetchExtractedHtml(url);
      const content = extractSourceContentFromHtml(extracted.html, extracted.url);
      if (!content.text.trim()) {
        throw new Error("Extracted text is empty.");
      }
      setSaveStatus("saving");
      const document = await buildSourceClipDocument({
        url: extracted.url,
        title: content.title,
        site: new URL(extracted.url).hostname,
        capturedAt: new Date().toISOString(),
        tags: parseTags(tagInput),
        userNote,
        extractedText: content.text
      });
      const current = await readNode(canisterId, databaseId, document.path, writeIdentity);
      await ensureParentFolders(canisterId, databaseId, writeIdentity, document.path);
      await writeNodeAuthenticated(canisterId, writeIdentity, {
        databaseId,
        path: document.path,
        kind: "source",
        content: document.markdown,
        metadataJson: document.metadataJson,
        expectedEtag: current?.etag ?? null
      });
      setSaveStatus("saved");
      setSavedPath(document.path);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setSaveStatus("error");
      setSaveError(errorMessage(error));
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="space-y-3">
        <form className="space-y-2 rounded-xl border border-line bg-white p-3" onSubmit={saveClip}>
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Plus size={15} className="text-accent" />
            Save source URL
          </div>
          <input
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
            inputMode="url"
            placeholder="https://example.com/article"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <textarea
            className="min-h-16 w-full resize-y rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
            placeholder="自分用メモ"
            value={userNote}
            onChange={(event) => setUserNote(event.target.value)}
          />
          <input
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
            placeholder="tags: research reference"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <StatusText status={saveStatus} error={saveError} />
            <button
              className="inline-flex items-center gap-1 rounded-2xl bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
              disabled={!url.trim() || saveStatus === "extracting" || saveStatus === "saving"}
              type="submit"
            >
              {saveStatus === "extracting" || saveStatus === "saving" ? <Loader2 size={14} className="animate-spin" /> : null}
              Save
            </button>
          </div>
          {savedPath ? (
            <Link className="block truncate text-xs text-accent no-underline hover:underline" href={hrefForPath(canisterId, databaseId, savedPath, undefined, undefined, undefined, undefined, readMode)}>
              {savedPath}
            </Link>
          ) : null}
        </form>

        <form className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2" onSubmit={(event) => event.preventDefault()}>
          <Search size={15} className="shrink-0 text-muted" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            placeholder="Search saved sources"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </form>

        {query.trim() ? (
          <SearchPanel
            canisterId={canisterId}
            databaseId={databaseId}
            query={query}
            initialKind="full"
            readIdentity={readIdentity}
            prefix={SOURCE_CLIP_PREFIX}
            eyebrow="Sources"
            title="Source search"
            emptyMessage="Search saved source clips."
            readMode={readMode}
          />
        ) : (
          <SourceRecentList
            key={`${refreshKey}:${readIdentity?.getPrincipal().toText() ?? "anonymous"}`}
            canisterId={canisterId}
            databaseId={databaseId}
            readIdentity={readIdentity}
            readMode={readMode}
          />
        )}
      </div>
    </div>
  );
}

async function ensureParentFolders(canisterId: string, databaseId: string, identity: Identity, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    await mkdirNodeAuthenticated(canisterId, identity, { databaseId, path: current });
  }
}

function StatusText({ status, error }: { status: SaveStatus; error: string | null }) {
  if (status === "extracting") {
    return <p className="text-xs text-muted">Extracting...</p>;
  }
  if (status === "saving") {
    return <p className="text-xs text-muted">Saving...</p>;
  }
  if (status === "saved") {
    return <p className="text-xs text-green-700">Saved</p>;
  }
  if (status === "error") {
    return <p className="min-w-0 truncate text-xs text-red-700">{error ?? "Save failed"}</p>;
  }
  return <p className="text-xs text-muted">Full text will be saved.</p>;
}

function SourceRecentList({ canisterId, databaseId, readIdentity, readMode }: { canisterId: string; databaseId: string; readIdentity: Identity | null; readMode: "anonymous" | null }) {
  const [state, setState] = useState<LoadState<WikiNode[]>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    recentNodes(canisterId, databaseId, 20, readIdentity ?? undefined, SOURCE_CLIP_PREFIX)
      .then((recent) => Promise.all(recent.map((item) => readNode(canisterId, databaseId, item.path, readIdentity ?? undefined))))
      .then((nodes) => {
        if (!cancelled) {
          setState({ data: nodes.filter(isWikiNode), error: null, loading: false });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setState({ data: null, error: errorMessage(error), hint: errorHint(error), loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, readIdentity]);

  if (state.error) {
    return <ErrorBox message={state.error} hint={state.hint} />;
  }
  if (state.loading) {
    return <p className="rounded-xl border border-line bg-white p-3 text-sm text-muted">Loading sources...</p>;
  }
  if (!state.data || state.data.length === 0) {
    return <p className="rounded-xl border border-line bg-white p-3 text-sm text-muted">No saved sources yet.</p>;
  }
  return (
    <div className="space-y-2">
      {state.data.map((node) => (
        <SourceCard key={node.path} canisterId={canisterId} databaseId={databaseId} node={node} readMode={readMode} />
      ))}
    </div>
  );
}

function SourceCard({ canisterId, databaseId, node, readMode }: { canisterId: string; databaseId: string; node: WikiNode; readMode: "anonymous" | null }) {
  const title = sourceClipTitleFromMetadata(node.metadataJson, node.path);
  const site = sourceClipSiteFromMetadata(node.metadataJson);
  const tags = sourceClipTagsFromMetadata(node.metadataJson);
  return (
    <Link href={hrefForPath(canisterId, databaseId, node.path, undefined, undefined, undefined, undefined, readMode)} className="block rounded-xl border border-line bg-white p-3 text-sm no-underline hover:border-accent">
      <div className="line-clamp-2 font-medium text-ink">{title}</div>
      <div className="mt-1 truncate font-mono text-[11px] text-muted">{site || node.path}</div>
      {tags.length > 0 ? <div className="mt-2 truncate text-xs text-muted">{tags.map((tag) => `#${tag}`).join(" ")}</div> : null}
    </Link>
  );
}

async function fetchExtractedHtml(url: string): Promise<ExtractResponse> {
  const response = await fetch("/api/sources/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string" ? body.error : "extract failed";
    throw new Error(message);
  }
  if (!isRecord(body) || typeof body.url !== "string" || typeof body.html !== "string") {
    throw new Error("invalid extract response");
  }
  return { url: body.url, html: body.html };
}

function isWikiNode(value: WikiNode | null): value is WikiNode {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
