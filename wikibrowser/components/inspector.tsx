"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, GitBranch, Info, Sparkles } from "lucide-react";
import { collectLintHints, provenancePathFor, rawSourceLinksFor } from "@/lib/lint-hints";
import { hrefForPath } from "@/lib/paths";
import type { ChildNode, LinkEdge, WikiNode } from "@/lib/types";
import { InspectorCard, Meta } from "@/components/panel";

type ProvenanceState = {
  path: string | null;
  links: string[];
};
export function Inspector({
  canisterId,
  databaseId,
  databaseName,
  path,
  node,
  childNodes,
  noteRole,
  incomingLinks,
  incomingError,
  outgoingLinks,
  readIdentity,
  readMode = null
}: {
  canisterId: string;
  databaseId: string;
  databaseName: string;
  path: string;
  node: WikiNode | null;
  childNodes: ChildNode[];
  noteRole: string;
  incomingLinks: LinkEdge[] | null;
  incomingError?: string | null;
  outgoingLinks: LinkEdge[];
  readIdentity: Identity | null;
  readMode?: "anonymous" | null;
}) {
  const kind = node?.kind ?? "directory";
  const size = node ? `${new TextEncoder().encode(node.content).length}` : null;
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

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-sm">
      <InspectorCard title="Identity" icon={<Info size={15} />}>
        <Meta label="database" value={databaseName} />
        <Meta label="database_id" value={databaseId} />
        <Meta label="path" value={path} />
        <Meta label="kind" value={kind} />
        <Meta label="role" value={noteRole} />
        {node ? <Meta label="size_bytes" value={size} /> : <Meta label="children" value={String(childNodes.length)} />}
      </InspectorCard>
      <InspectorCard title="Metadata" icon={<Sparkles size={15} />}>
        <Meta label="created_at" value={node?.createdAt ?? "virtual"} />
        <Meta label="updated_at" value={node?.updatedAt ?? "virtual"} />
        <Meta label="etag" value={node?.etag ?? "virtual"} />
        <Meta label="metadata_json" value={node?.metadataJson ?? "{}"} />
      </InspectorCard>
      <InspectorCard title="Lint Hints" icon={<AlertTriangle size={15} />}>
        {hints.length > 0 ? (
          <ul className="space-y-2">
            {hints.slice(0, 5).map((hint) => (
              <li key={`${hint.title}-${hint.line}`} className="rounded-lg border border-yellow-200 bg-yellow-50 p-2">
                <p className="text-xs font-semibold text-yellow-800">{hint.title}</p>
                <p className="mt-1 text-xs text-yellow-900">{hint.detail}</p>
                {hint.preview ? <p className="mt-1 rounded bg-white/70 p-2 font-mono text-[11px] text-yellow-950">{hint.preview}</p> : null}
                {hint.line ? <p className="mt-1 font-mono text-[11px] text-yellow-700">line {hint.line}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No lightweight warnings.</p>
        )}
      </InspectorCard>
      <InspectorCard title="Outgoing Links" icon={<GitBranch size={15} />}>
        {outgoingLinks.length > 0 ? (
          <ul className="space-y-1">
            {outgoingLinks.map((edge) => (
              <li key={`${edge.targetPath}-${edge.rawHref}`} className="truncate font-mono text-xs">
                <Link className="text-accent no-underline hover:underline" href={hrefForPath(canisterId, databaseId, edge.targetPath, undefined, undefined, undefined, undefined, readMode)}>
                  {edge.targetPath}
                </Link>
                <p className="truncate text-[11px] text-muted">{edge.linkText || edge.rawHref}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No outgoing links indexed.</p>
        )}
      </InspectorCard>
      <InspectorCard title="Incoming Links" icon={<GitBranch size={15} />}>
        {!node ? (
          <p className="text-xs text-muted">Select a file node to inspect backlinks.</p>
        ) : incomingLinks === null ? (
          <p className="text-xs text-muted">Loading backlinks...</p>
        ) : incomingError ? (
          <p className="text-xs text-red-700">{incomingError}</p>
        ) : incomingLinks.length > 0 ? (
          <ul className="space-y-1">
            {incomingLinks.map((edge) => (
              <li key={`${edge.sourcePath}-${edge.rawHref}`} className="truncate font-mono text-xs">
                <Link className="text-accent no-underline hover:underline" href={hrefForPath(canisterId, databaseId, edge.sourcePath, undefined, undefined, undefined, undefined, readMode)}>
                  {edge.sourcePath}
                </Link>
                <p className="truncate text-[11px] text-muted">{edge.linkText || edge.rawHref}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No backlinks indexed.</p>
        )}
      </InspectorCard>
      <InspectorCard title="Raw Source" icon={<GitBranch size={15} />}>
        {rawSourceLinks.length > 0 ? (
          <ul className="space-y-1">
            {rawSourceLinks.map((link) => (
              <li key={link} className="truncate font-mono text-xs">
                <Link className="text-accent no-underline hover:underline" href={hrefForPath(canisterId, databaseId, link, undefined, undefined, undefined, undefined, readMode)}>
                  {link}
                </Link>
              </li>
            ))}
          </ul>
        ) : loadingRawSource ? (
          <p className="text-xs text-muted">Checking provenance...</p>
        ) : (
          <p className="text-xs text-muted">No raw source path inferred.</p>
        )}
      </InspectorCard>
    </div>
  );
}
