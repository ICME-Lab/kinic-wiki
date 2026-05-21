"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { hrefForPath } from "@/lib/paths";
import { nodeRequestKey } from "@/lib/request-keys";
import type { ChildNode } from "@/lib/types";
import { visibleChildren } from "@/lib/folder-index";
import { canExpandChildNode, errorMessage, rootChild, type LoadState } from "@/lib/wiki-helpers";

const WIKI_ROOT_NODE = rootChild("/Wiki");
const SOURCES_ROOT_NODE = rootChild("/Sources");

export function ExplorerTree({
  canisterId,
  databaseId,
  selectedPath,
  autoExpandSelected = true,
  readIdentity,
  readMode = null,
  childNodesCache,
  onSelectedNode
}: {
  canisterId: string;
  databaseId: string;
  selectedPath: string;
  autoExpandSelected?: boolean;
  readIdentity: Identity | null;
  readMode?: "anonymous" | null;
  childNodesCache: { current: Map<string, ChildNode[]> };
  onSelectedNode: (node: ChildNode) => void;
}) {
  const readPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
      <TreeNode key={`${canisterId}:${databaseId}:/Wiki:${readPrincipal ?? "anonymous"}`} canisterId={canisterId} databaseId={databaseId} node={WIKI_ROOT_NODE} selectedPath={selectedPath} depth={0} autoExpandSelected={autoExpandSelected} readIdentity={readIdentity} readMode={readMode} childNodesCache={childNodesCache} onSelectedNode={onSelectedNode} />
      <TreeNode key={`${canisterId}:${databaseId}:/Sources:${readPrincipal ?? "anonymous"}`} canisterId={canisterId} databaseId={databaseId} node={SOURCES_ROOT_NODE} selectedPath={selectedPath} depth={0} autoExpandSelected={autoExpandSelected} readIdentity={readIdentity} readMode={readMode} childNodesCache={childNodesCache} onSelectedNode={onSelectedNode} />
    </div>
  );
}

function TreeNode({
  canisterId,
  databaseId,
  node,
  selectedPath,
  depth,
  autoExpandSelected,
  readIdentity,
  readMode,
  childNodesCache,
  onSelectedNode
}: {
  canisterId: string;
  databaseId: string;
  node: ChildNode;
  selectedPath: string;
  depth: number;
  autoExpandSelected: boolean;
  readIdentity: Identity | null;
  readMode: "anonymous" | null;
  childNodesCache: { current: Map<string, ChildNode[]> };
  onSelectedNode: (node: ChildNode) => void;
}) {
  const {
    path: nodePath,
    name: nodeName,
    kind: nodeKind,
    updatedAt: nodeUpdatedAt,
    etag: nodeEtag,
    sizeBytes: nodeSizeBytes,
    isVirtual: nodeIsVirtual,
    hasChildren: nodeHasChildren
  } = node;
  const readPrincipal = readMode === "anonymous" ? null : readIdentity?.getPrincipal().toText() ?? null;
  const requestKey = nodeRequestKey(canisterId, databaseId, nodePath, readPrincipal);
  const [expanded, setExpanded] = useState(autoExpandSelected && (nodePath === selectedPath || selectedPath.startsWith(`${nodePath}/`)));
  const [children, setChildren] = useState<LoadState<ChildNode[]>>(() => {
    const cached = childNodesCache.current.get(requestKey);
    return cached ? { data: cached, error: null, loading: false } : { data: null, error: null, loading: false };
  });
  const autoExpandedKey = useRef<string | null>(expanded ? selectedPath : null);
  const requestedKey = useRef<string | null>(null);
  const canExpand = canExpandChildNode(node);
  const selected = selectedPath === nodePath;
  const selectedAncestor = nodePath === selectedPath || selectedPath.startsWith(`${nodePath}/`);

  useEffect(() => {
    if (!autoExpandSelected || !selectedAncestor || autoExpandedKey.current === selectedPath) return;
    const timeout = window.setTimeout(() => {
      autoExpandedKey.current = selectedPath;
      setExpanded(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [autoExpandSelected, selectedAncestor, selectedPath]);

  useEffect(() => {
    if (selected) {
      onSelectedNode({
        path: nodePath,
        name: nodeName,
        kind: nodeKind,
        updatedAt: nodeUpdatedAt,
        etag: nodeEtag,
        sizeBytes: nodeSizeBytes,
        isVirtual: nodeIsVirtual,
        hasChildren: nodeHasChildren
      });
    }
  }, [nodeEtag, nodeHasChildren, nodeIsVirtual, nodeKind, nodeName, nodePath, nodeSizeBytes, nodeUpdatedAt, onSelectedNode, selected]);

  useEffect(() => {
    if (!expanded || !canExpand || children.data || children.error || requestedKey.current === requestKey) return;
    const cached = childNodesCache.current.get(requestKey);
    if (cached) {
      let cancelled = false;
      Promise.resolve().then(() => {
        if (!cancelled) {
          setChildren({ data: cached, error: null, loading: false });
        }
      });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    requestedKey.current = requestKey;
    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setChildren({ data: null, error: null, loading: true });
        return import("@/lib/vfs-client");
      })
      .then((module) => {
        if (!module) return [];
        return module.listChildren(canisterId, databaseId, node.path, readIdentity ?? undefined);
      })
      .then((data) => {
        if (!cancelled) {
          childNodesCache.current.set(requestKey, data);
          setChildren({ data, error: null, loading: false });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setChildren({ data: null, error: errorMessage(error), loading: false });
          requestedKey.current = null;
        }
      });
    return () => {
      cancelled = true;
      if (requestedKey.current === requestKey) requestedKey.current = null;
    };
  }, [canisterId, databaseId, canExpand, childNodesCache, children.data, children.error, expanded, node.path, readIdentity, requestKey]);

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${
          selected ? "bg-accentSoft text-accentText" : "text-ink hover:bg-white"
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {canExpand ? <Toggle expanded={expanded} setExpanded={setExpanded} /> : <span className="w-[18px]" />}
        {directoryIcon(canExpand, expanded)}
        <Link
          className="min-w-0 flex-1 truncate no-underline"
          href={hrefForPath(canisterId, databaseId, node.path, undefined, undefined, undefined, undefined, readMode)}
          aria-current={selected ? "page" : undefined}
        >
          {node.name}
        </Link>
      </div>
      {expanded && canExpand ? (
        <ChildrenList
          canisterId={canisterId}
          databaseId={databaseId}
          childrenState={children}
          depth={depth}
          selectedPath={selectedPath}
          autoExpandSelected={autoExpandSelected}
          readIdentity={readIdentity}
          readMode={readMode}
          childNodesCache={childNodesCache}
          onSelectedNode={onSelectedNode}
        />
      ) : null}
    </div>
  );
}

function Toggle({ expanded, setExpanded }: { expanded: boolean; setExpanded: (value: boolean) => void }) {
  return (
    <button
      className="rounded p-0.5 text-muted hover:bg-canvas"
      type="button"
      onClick={() => setExpanded(!expanded)}
      aria-label={expanded ? "Collapse directory" : "Expand directory"}
    >
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  );
}

function ChildrenList({
  canisterId,
  databaseId,
  childrenState,
  depth,
  selectedPath,
  autoExpandSelected,
  readIdentity,
  readMode,
  childNodesCache,
  onSelectedNode
}: {
  canisterId: string;
  databaseId: string;
  childrenState: LoadState<ChildNode[]>;
  depth: number;
  selectedPath: string;
  autoExpandSelected: boolean;
  readIdentity: Identity | null;
  readMode: "anonymous" | null;
  childNodesCache: { current: Map<string, ChildNode[]> };
  onSelectedNode: (node: ChildNode) => void;
}) {
  return (
    <div>
      {!childrenState.data && !childrenState.error ? <TreeStatus depth={depth + 1} label="Loading" /> : null}
      {childrenState.error ? <TreeStatus depth={depth + 1} label={childrenState.error} /> : null}
      {childrenState.data ? visibleChildren(childrenState.data).map((child) => (
        <TreeNode
          key={child.path}
          canisterId={canisterId}
          databaseId={databaseId}
          node={child}
          selectedPath={selectedPath}
          depth={depth + 1}
          autoExpandSelected={autoExpandSelected}
          readIdentity={readIdentity}
          readMode={readMode}
          childNodesCache={childNodesCache}
          onSelectedNode={onSelectedNode}
        />
      )) : null}
    </div>
  );
}

function TreeStatus({ depth, label }: { depth: number; label: string }) {
  return (
    <div className="truncate px-2 py-1 font-mono text-[11px] text-muted" style={{ paddingLeft: `${26 + depth * 16}px` }}>
      {label}
    </div>
  );
}

function directoryIcon(isDirectory: boolean, expanded: boolean) {
  if (!isDirectory) return <FileText size={15} className="text-muted" />;
  return expanded ? <FolderOpen size={15} className="text-accent" /> : <Folder size={15} className="text-muted" />;
}
