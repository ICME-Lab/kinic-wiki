"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { type ReactNode, useEffect, useState } from "react";
import { WikiNavigationLink } from "@/components/wiki-navigation";
import { AlertTriangle, ChevronDown, CornerDownRight, FileSearch, GitBranch } from "lucide-react";
import { collectLintHints, provenancePathFor, rawSourceLinksFor } from "@/lib/lint-hints";
import { hrefForPath } from "@/lib/paths";
import { formatStoredTimestamp, isBlankMetadataJson } from "@/lib/relative-time";
import type { ChildNode, LinkEdge, WikiNode } from "@/lib/types";
import { Meta } from "@/components/panel";

type ProvenanceState = {
  path: string | null;
  links: string[];
};
export function Inspector({
  canisterId,
  databaseId,
  databaseTitle,
  path,
  node,
  childNodes,
  noteRole,
  incomingLinks,
  incomingError,
  outgoingLinks,
  readIdentity
}: {
  canisterId: string;
  databaseId: string;
  databaseTitle: string;
  path: string;
  node: WikiNode | null;
  childNodes: ChildNode[];
  noteRole: string;
  incomingLinks: LinkEdge[] | null;
  incomingError?: string | null;
  outgoingLinks: LinkEdge[];
  readIdentity: Identity | null;
}) {
  const kind = node?.kind ?? "directory";
  const size = node ? `${new TextEncoder().encode(node.content).length}` : null;
  const created = formatStoredTimestamp(node?.createdAt);
  const updated = formatStoredTimestamp(node?.updatedAt);
  const hasMetadata = !isBlankMetadataJson(node?.metadataJson);
  const hints = node ? collectLintHints(path, node.content) : [];
  const directRawSourceLinks = node ? rawSourceLinksFor(path, node.content) : [];
  const expectedProvenancePath = node && directRawSourceLinks.length === 0 ? provenancePathFor(path) : null;
  const [provenance, setProvenance] = useState<ProvenanceState>({ path: null, links: [] });
  const inferredRawSourceLinks = provenance.path === expectedProvenancePath ? provenance.links : [];
  const rawSourceLinks = directRawSourceLinks.length > 0 ? directRawSourceLinks : inferredRawSourceLinks;
  const loadingRawSource = Boolean(expectedProvenancePath && provenance.path !== expectedProvenancePath);

  useEffect(() => {
    if (!expectedProvenancePath) {
      return;
    }
    let cancelled = false;
    import("@/lib/vfs-client")
      .then(({ readNode }) => readNode(canisterId, databaseId, expectedProvenancePath, readIdentity ?? undefined))
      .then((provenanceNode) => {
        if (!cancelled) {
          setProvenance({
            path: expectedProvenancePath,
            links: provenanceNode ? rawSourceLinksFor(expectedProvenancePath, provenanceNode.content) : []
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProvenance({ path: expectedProvenancePath, links: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, expectedProvenancePath, readIdentity]);

  const linkClass = "block truncate text-[13px] text-ink no-underline hover:text-accentText";
  return (
    <div className="min-h-0 flex-1 divide-y divide-line overflow-auto text-sm">
      <section className="px-4 py-4">
        <p className="truncate text-[15px] font-semibold text-ink" title={path}>
          {path.split("/").filter(Boolean).pop() ?? path}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted">
          {[kind === "directory" ? "Folder" : kind === "file" ? "Note" : kind, noteRole.replace(/_/g, " "), node ? formatSize(size) : `${childNodes.length} items`, updated ? `Updated ${updated.relative}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </section>
      <InspectorSection count={node && incomingLinks ? incomingLinks.length : null} icon={<CornerDownRight size={13} />} title="Backlinks">
        {!node ? (
          <p className="text-xs text-muted">Select a note to see what links here.</p>
        ) : incomingLinks === null ? (
          <p className="text-xs text-muted">Loading backlinks...</p>
        ) : incomingError ? (
          <p className="text-xs text-dangerText">{incomingError}</p>
        ) : incomingLinks.length > 0 ? (
          <ul className="space-y-1.5">
            {incomingLinks.map((edge) => (
              <li key={`${edge.sourcePath}-${edge.rawHref}`} className="min-w-0">
                <WikiNavigationLink className={linkClass} href={hrefForPath(canisterId, databaseId, edge.sourcePath)} title={edge.sourcePath}>
                  {edge.sourcePath}
                </WikiNavigationLink>
                {edge.linkText ? <p className="truncate text-[11px] text-muted">{edge.linkText}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No backlinks indexed.</p>
        )}
      </InspectorSection>
      <InspectorSection count={outgoingLinks.length} icon={<GitBranch size={13} />} title="Outgoing Links">
        {outgoingLinks.length > 0 ? (
          <ul className="space-y-1.5">
            {outgoingLinks.map((edge) => (
              <li key={`${edge.targetPath}-${edge.rawHref}`} className="min-w-0">
                <WikiNavigationLink className={linkClass} href={hrefForPath(canisterId, databaseId, edge.targetPath)} title={edge.targetPath}>
                  {edge.targetPath}
                </WikiNavigationLink>
                {edge.linkText ? <p className="truncate text-[11px] text-muted">{edge.linkText}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No outgoing links indexed.</p>
        )}
      </InspectorSection>
      <InspectorSection count={null} icon={<FileSearch size={13} />} title="Raw Source">
        {rawSourceLinks.length > 0 ? (
          <ul className="space-y-1.5">
            {rawSourceLinks.map((link) => (
              <li key={link} className="min-w-0">
                <WikiNavigationLink className={linkClass} href={hrefForPath(canisterId, databaseId, link)} title={link}>
                  {link}
                </WikiNavigationLink>
              </li>
            ))}
          </ul>
        ) : loadingRawSource ? (
          <p className="text-xs text-muted">Checking provenance...</p>
        ) : (
          <p className="text-xs text-muted">No raw source path inferred.</p>
        )}
      </InspectorSection>
      {hints.length > 0 ? (
        <InspectorSection count={hints.length} icon={<AlertTriangle size={13} />} title="Lint Hints">
          <ul className="space-y-2">
            {hints.slice(0, 5).map((hint) => (
              <li key={`${hint.title}-${hint.line}`} className="rounded-lg border border-warnLine bg-warnSoft p-2">
                <p className="text-xs font-semibold text-warnText">{hint.title}</p>
                <p className="mt-1 text-xs text-warnText">{hint.detail}</p>
                {hint.preview ? <p className="mt-1 rounded bg-white/70 p-2 font-mono text-[11px] text-warnText">{hint.preview}</p> : null}
                {hint.line ? <p className="mt-1 font-mono text-[11px] text-warnText">line {hint.line}</p> : null}
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}
      {/* Storage identifiers matter to operators, not readers, so they live behind a disclosure. */}
      <details className="group px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold uppercase tracking-[0.08em] text-muted hover:text-ink">
          Details
          <ChevronDown aria-hidden className="transition-transform group-open:rotate-180" size={14} />
        </summary>
        <div className="mt-3 space-y-2.5">
          <Meta label="database" value={databaseTitle} />
          <Meta label="database_id" value={databaseId} />
          <Meta label="path" value={path} />
          <Meta label="kind" value={kind} />
          <Meta label="role" value={noteRole} />
          {node ? <Meta label="size_bytes" value={size} /> : <Meta label="children" value={String(childNodes.length)} />}
          {node ? (
            <>
              <Meta label="created_at" title={created?.absolute} value={created ? `${created.relative} · ${created.absolute}` : null} />
              <Meta label="updated_at" title={updated?.absolute} value={updated ? `${updated.relative} · ${updated.absolute}` : null} />
              <Meta label="etag" value={node.etag} />
              {hasMetadata ? <Meta label="metadata_json" value={node.metadataJson} /> : null}
            </>
          ) : (
            <p className="text-xs leading-5 text-muted">Virtual folder. It is derived from its children, so it has no etag or stored timestamps.</p>
          )}
        </div>
      </details>
    </div>
  );
}

function InspectorSection({ children, count, icon, title }: { children: ReactNode; count: number | null; icon: ReactNode; title: string }) {
  return (
    <section className="px-4 py-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
        {icon}
        {title}
        {count !== null && count > 0 ? <span className="ml-auto font-mono font-normal normal-case tracking-normal">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function formatSize(bytes: string | null): string | null {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
