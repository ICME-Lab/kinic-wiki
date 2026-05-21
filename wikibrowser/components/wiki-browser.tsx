"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, FilePlus, FolderPlus, GitBranch, Menu, MoveRight, Network, PanelRight, Pencil, Search, Share2, Trash2, X } from "lucide-react";
import { CycleBattery } from "@/components/cycle-battery";
import { DocumentHeader, DocumentPane, type DocumentEditState } from "@/components/document-pane";
import { ExplorerTree } from "@/components/explorer-tree";
import { Inspector } from "@/components/inspector";
import { IngestPanel } from "@/components/ingest-panel";
import { QueryPanel } from "@/components/query-panel";
import { PanelHeader } from "@/components/panel";
import { SourcesPanel } from "@/components/sources-panel";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import { readBrowserNodeCache } from "@/lib/browser-node-cache";
import { hrefForDatabaseSwitch, hrefForGraph, hrefForPath, hrefForSearch, parentPath } from "@/lib/paths";
import { nodeRequestKey } from "@/lib/request-keys";
import { xShareDatabaseHref } from "@/lib/share-links";
import type { ChildNode, DatabaseRole, DatabaseSummary, NodeContext, WikiNode } from "@/lib/types";
import { listDatabasesAuthenticated, listDatabasesPublic } from "@/lib/vfs-client";
import { folderIndexPath, isReservedFolderIndexName, visibleChildren } from "@/lib/folder-index";
import {
  errorHint,
  errorMessage,
  inferNoteRole,
  isNotFoundError,
  loadingState,
  parseModeTab,
  readIdentityMode as resolveReadIdentityMode,
  ApiError,
  type ModeTab,
  type PathLoadState,
  type ViewMode
} from "@/lib/wiki-helpers";

const SIDEBAR_TABS: ModeTab[] = ["explorer", "query", "ingest", "sources"];
const HEADER_ICON_LINK_CLASS = "inline-flex h-9 items-center justify-center gap-1 rounded-lg border px-3 text-sm no-underline";
const EMPTY_EDIT_STATE: DocumentEditState = { dirty: false, saveState: "idle" };
const UNSAVED_MARKDOWN_MESSAGE = "You have unsaved Markdown changes. Leave edit mode?";
const GraphPanel = dynamic(() => import("@/components/graph-panel").then((module) => module.GraphPanel), {
  ssr: false,
  loading: () => <p className="min-h-0 flex-1 p-5 text-sm text-muted">Loading graph view...</p>
});
const SearchPanel = dynamic(() => import("@/components/search-panel").then((module) => module.SearchPanel), {
  ssr: false,
  loading: () => <p className="min-h-0 flex-1 p-5 text-sm text-muted">Loading search...</p>
});

type BrowserLoadState<T> = PathLoadState<T> & {
  requestKey: string;
};

export function WikiBrowser() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeState = useMemo(() => parseWikiRoute(pathname), [pathname]);
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const databaseId = routeState.databaseId ?? "";
  const isSearchPage = useMemo(() => isBrowserSearchPathname(canisterId, databaseId, pathname), [canisterId, databaseId, pathname]);
  const isGraphPage = useMemo(() => isBrowserGraphPathname(canisterId, databaseId, pathname), [canisterId, databaseId, pathname]);
  const graphCenter = isGraphPage ? searchParams.get("center") : null;
  const graphDepth = parseGraphDepth(searchParams.get("depth"));
  const readMode = parseReadMode(searchParams.get("read"));
  const selectedPath = useMemo(
    () => isSearchPage ? "/Wiki" : isGraphPage ? graphCenter ?? "/Wiki" : routeState.nodePath,
    [graphCenter, isGraphPage, isSearchPage, routeState.nodePath]
  );
  const view = parseView(searchParams.get("view"));
  const tab = parseTab(searchParams.get("tab"));
  const query = isSearchPage ? searchParams.get("q") ?? "" : "";
  const searchKind = parseSearchKind(searchParams.get("kind"));
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [readIdentity, setReadIdentity] = useState<Identity | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  const [memberDatabases, setMemberDatabases] = useState<DatabaseSummary[]>([]);
  const [publicDatabaseIds, setPublicDatabaseIds] = useState<Set<string>>(() => new Set());
  const [memberDatabasesLoaded, setMemberDatabasesLoaded] = useState(false);
  const [databaseListError, setDatabaseListError] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const currentDatabaseRole = useMemo(
    () => readIdentity ? memberDatabases.find((database) => database.databaseId === databaseId)?.role ?? null : null,
    [databaseId, memberDatabases, readIdentity]
  );
  const currentReadIdentityMode = resolveReadIdentityMode(readMode, Boolean(readIdentity), Boolean(currentDatabaseRole), memberDatabasesLoaded, publicDatabaseIds.has(databaseId));
  const effectiveReadIdentity = currentReadIdentityMode === "user" ? readIdentity : null;
  const authPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const readPrincipal = effectiveReadIdentity?.getPrincipal().toText() ?? null;
  const currentRequestKey = nodeRequestKey(canisterId, databaseId, selectedPath, readPrincipal);
  const folderIndexRequestKey = nodeRequestKey(canisterId, databaseId, folderIndexPath(selectedPath), readPrincipal);
  const [node, setNode] = useState<BrowserLoadState<WikiNode>>(browserLoadingState(canisterId, databaseId, selectedPath));
  const [nodeContext, setNodeContext] = useState<BrowserLoadState<NodeContext>>(browserLoadingState(canisterId, databaseId, selectedPath));
  const [childNodes, setChildNodes] = useState<BrowserLoadState<ChildNode[]>>(browserLoadingState(canisterId, databaseId, selectedPath));
  const [folderIndexNode, setFolderIndexNode] = useState<BrowserLoadState<WikiNode>>(browserLoadingState(canisterId, databaseId, folderIndexPath(selectedPath)));
  const [editState, setEditState] = useState<DocumentEditState>({ dirty: false, saveState: "idle" });
  const [explorerRevision, setExplorerRevision] = useState(0);
  const [selectedExplorerState, setSelectedExplorerState] = useState<{ key: string; node: ChildNode } | null>(null);
  const [explorerActionMode, setExplorerActionMode] = useState<"file" | "folder" | "rename" | null>(null);
  const [explorerMoveOpen, setExplorerMoveOpen] = useState(false);
  const [explorerMoveTarget, setExplorerMoveTarget] = useState("/Wiki");
  const [explorerMoveTargets, setExplorerMoveTargets] = useState<string[]>(["/Wiki"]);
  const [explorerDraftName, setExplorerDraftName] = useState("");
  const [explorerActionError, setExplorerActionError] = useState<string | null>(null);
  const [explorerBusyAction, setExplorerBusyAction] = useState<"file" | "folder" | "rename" | "move" | "delete" | null>(null);
  const nodeContextCache = useRef(new Map<string, NodeContext>());
  const childNodesCache = useRef(new Map<string, ChildNode[]>());
  const folderIndexNodeCache = useRef(new Map<string, WikiNode | null>());
  const invalidCanister = validateCanisterText(canisterId);

  useEffect(() => {
    let cancelled = false;
    AuthClient.create(AUTH_CLIENT_CREATE_OPTIONS)
      .then(async (client) => {
        if (cancelled) return;
        setAuthClient(client);
        if (await client.isAuthenticated()) {
          if (!cancelled) setReadIdentity(client.getIdentity());
        }
      })
      .catch((cause) => {
        if (!cancelled) setAuthError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!canisterId) return;
    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setMemberDatabasesLoaded(false);
        setDatabaseListError(null);
        return Promise.allSettled([
          listDatabasesPublic(canisterId),
          readIdentity ? listDatabasesAuthenticated(canisterId, readIdentity) : Promise.resolve<DatabaseSummary[]>([])
        ]);
      })
      .then((results) => {
        if (cancelled || !results) return;
        const [publicResult, memberResult] = results;
        if (publicResult.status === "rejected" && memberResult.status === "rejected") {
          setDatabases([]);
          setMemberDatabases([]);
          setPublicDatabaseIds(new Set());
          setMemberDatabasesLoaded(false);
          setDatabaseListError(`${errorMessage(publicResult.reason)}; ${errorMessage(memberResult.reason)}`);
          return;
        }
        const publicDatabases = publicResult.status === "fulfilled" ? publicResult.value : [];
        const authenticatedDatabases = memberResult.status === "fulfilled" ? memberResult.value : [];
        setDatabases(mergeDatabaseSummaries(authenticatedDatabases, publicDatabases));
        setMemberDatabases(authenticatedDatabases);
        setPublicDatabaseIds(new Set(publicDatabases.map((database) => database.databaseId)));
        setMemberDatabasesLoaded(memberResult.status === "fulfilled");
        setDatabaseListError(databaseListWarning(publicResult, memberResult));
      })
      .catch((cause) => {
        if (!cancelled) {
          setDatabases([]);
          setMemberDatabases([]);
          setPublicDatabaseIds(new Set());
          setMemberDatabasesLoaded(false);
          setDatabaseListError(errorMessage(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, readIdentity, authPrincipal]);

  useEffect(() => {
    let cancelled = false;
    if (typeof invalidCanister === "string") {
      return;
    }
    if (isGraphPage && !graphCenter) {
      return;
    }
    const requestKey = nodeRequestKey(canisterId, databaseId, selectedPath, readPrincipal);
    const indexPath = folderIndexPath(selectedPath);
    const indexRequestKey = nodeRequestKey(canisterId, databaseId, indexPath, readPrincipal);
    const cached = readBrowserNodeCache(nodeContextCache.current, childNodesCache.current, requestKey);
    const cachedFolderNeedsChildren = cached?.kind === "node" && cached.context.node.kind === "folder" && !childNodesCache.current.has(requestKey);
    const cachedFolderNeedsIndex = cached?.kind === "node" && cached.context.node.kind === "folder" && !folderIndexNodeCache.current.has(indexRequestKey);
    if (cached && !cachedFolderNeedsChildren && !cachedFolderNeedsIndex) {
      if (cached.kind === "node") {
        setNode({ requestKey, path: selectedPath, data: cached.context.node, error: null, loading: false });
        setNodeContext({ requestKey, path: selectedPath, data: cached.context, error: null, loading: false });
        setChildNodes({ requestKey, path: selectedPath, data: childNodesCache.current.get(requestKey) ?? [], error: null, loading: false });
        setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: cached.context.node.kind === "folder" ? folderIndexNodeCache.current.get(indexRequestKey) ?? null : null, error: null, loading: false });
      } else {
        setNode({ requestKey, path: selectedPath, data: null, error: null, loading: false });
        setNodeContext({ requestKey, path: selectedPath, data: null, error: null, loading: false });
        setChildNodes({ requestKey, path: selectedPath, data: cached.children, error: null, loading: false });
        setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: null, loading: false });
      }
      return;
    }
    import("@/lib/vfs-client")
      .then(({ readNodeContext }) => readNodeContext(canisterId, databaseId, selectedPath, 20, effectiveReadIdentity ?? undefined))
      .then(async (data) => {
        if (!cancelled) {
          if (!data) {
            throw new ApiError(`node not found: ${selectedPath}`, 404);
          }
          nodeContextCache.current.set(requestKey, data);
          setNode({ requestKey, path: selectedPath, data: data.node, error: null, loading: false });
          setNodeContext({ requestKey, path: selectedPath, data, error: null, loading: false });
          if (data.node.kind === "folder") {
            const { listChildren, readNode } = await import("@/lib/vfs-client");
            const children = await listChildren(canisterId, databaseId, selectedPath, effectiveReadIdentity ?? undefined);
            if (!cancelled) {
              childNodesCache.current.set(requestKey, children);
              setChildNodes({ requestKey, path: selectedPath, data: children, error: null, loading: false });
            }
            try {
              const indexNode = await readNode(canisterId, databaseId, indexPath, effectiveReadIdentity ?? undefined);
              if (!cancelled) {
                folderIndexNodeCache.current.set(indexRequestKey, indexNode);
                setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: indexNode, error: null, loading: false });
              }
            } catch (indexError) {
              if (!cancelled) {
                setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: errorMessage(indexError), hint: errorHint(indexError), loading: false });
              }
            }
          } else {
            setChildNodes({ requestKey, path: selectedPath, data: [], error: null, loading: false });
            setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: null, loading: false });
          }
        }
      })
      .catch((nodeError: Error) => {
        if (!isNotFoundError(nodeError)) {
          if (!cancelled) {
            setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
            setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
            setChildNodes({ requestKey, path: selectedPath, data: null, error: null, loading: false });
            setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: null, loading: false });
          }
          return;
        }
        import("@/lib/vfs-client")
          .then(({ listChildren }) => listChildren(canisterId, databaseId, selectedPath, effectiveReadIdentity ?? undefined))
          .then((data) => {
            if (!cancelled) {
              if (data.length === 0 && looksLikeFilePath(selectedPath)) {
                setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
                setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
                setChildNodes({ requestKey, path: selectedPath, data: null, error: `path not found: ${selectedPath}`, loading: false });
                setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: null, loading: false });
              } else {
                setNode({ requestKey, path: selectedPath, data: null, error: null, loading: false });
                setNodeContext({ requestKey, path: selectedPath, data: null, error: null, loading: false });
                childNodesCache.current.set(requestKey, data);
                setChildNodes({ requestKey, path: selectedPath, data, error: null, loading: false });
                setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: null, loading: false });
              }
            }
          })
          .catch((childrenError: Error) => {
            if (!cancelled) {
              setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
              setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
              setChildNodes({ requestKey, path: selectedPath, data: null, error: errorMessage(childrenError), hint: errorHint(childrenError), loading: false });
              setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: null, loading: false });
            }
          });
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, effectiveReadIdentity, graphCenter, invalidCanister, isGraphPage, readPrincipal, selectedPath]);

  async function login() {
    if (!authClient) return;
    setAuthError(null);
    await authClient.login({
      ...authLoginOptions(),
      onSuccess: () => {
        setReadIdentity(authClient.getIdentity());
      },
      onError: (cause) => {
        setAuthError(errorMessage(cause));
      }
    });
  }

  const logout = useCallback(async () => {
    if (!authClient) return;
    await authClient.logout();
    setReadIdentity(null);
    setAuthError(null);
  }, [authClient]);

  const refreshSelectedNodeContext = useCallback(async (): Promise<WikiNode> => {
    const requestKey = nodeRequestKey(canisterId, databaseId, selectedPath, readPrincipal);
    const { readNodeContext } = await import("@/lib/vfs-client");
    const data = await readNodeContext(canisterId, databaseId, selectedPath, 20, effectiveReadIdentity ?? undefined);
    if (!data) {
      throw new ApiError(`node not found: ${selectedPath}`, 404);
    }
    nodeContextCache.current.set(requestKey, data);
    childNodesCache.current.delete(requestKey);
    setNode({ requestKey, path: selectedPath, data: data.node, error: null, loading: false });
    setNodeContext({ requestKey, path: selectedPath, data, error: null, loading: false });
    setChildNodes({ requestKey, path: selectedPath, data: [], error: null, loading: false });
    return data.node;
  }, [canisterId, databaseId, effectiveReadIdentity, readPrincipal, selectedPath]);

  const refreshSelectedFolderIndex = useCallback(async (): Promise<WikiNode> => {
    const indexPath = folderIndexPath(selectedPath);
    const requestKey = nodeRequestKey(canisterId, databaseId, indexPath, readPrincipal);
    const { readNode } = await import("@/lib/vfs-client");
    const data = await readNode(canisterId, databaseId, indexPath, effectiveReadIdentity ?? undefined);
    if (!data) {
      throw new ApiError(`node not found: ${indexPath}`, 404);
    }
    folderIndexNodeCache.current.set(requestKey, data);
    setFolderIndexNode({ requestKey, path: indexPath, data, error: null, loading: false });
    return data;
  }, [canisterId, databaseId, effectiveReadIdentity, readPrincipal, selectedPath]);

  const invalidateBrowserCaches = useCallback(() => {
    nodeContextCache.current.clear();
    childNodesCache.current.clear();
    folderIndexNodeCache.current.clear();
    setSelectedExplorerState(null);
    setExplorerRevision((current) => current + 1);
  }, []);

  const currentNode = currentNodeState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, node);
  const currentNodeContext = currentNodeContextState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, nodeContext);
  const currentChildren = currentChildrenState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, childNodes);
  const currentFolderIndexNode = currentNodeState(invalidCanister, canisterId, databaseId, folderIndexPath(selectedPath), folderIndexRequestKey, folderIndexNode);
  const noteRole = inferNoteRole(selectedPath);
  const authPrompt = authPromptMode(readIdentity, currentNode.error || currentChildren.error);
  const activeEditState = view === "edit" ? editState : EMPTY_EDIT_STATE;
  const canLeaveDirtyEdit = useCallback(() => !activeEditState.dirty || window.confirm(UNSAVED_MARKDOWN_MESSAGE), [activeEditState.dirty]);
  const guardedLogout = useCallback(() => {
    if (canLeaveDirtyEdit()) {
      void logout();
    }
  }, [canLeaveDirtyEdit, logout]);
  const databaseOptions = useMemo(() => withCurrentDatabase(databases, databaseId), [databaseId, databases]);
  const currentDatabase = useMemo(() => databaseOptions.find((database) => database.databaseId === databaseId) ?? null, [databaseId, databaseOptions]);
  const explorerSelectionKey = nodeRequestKey(canisterId, databaseId, selectedPath, readPrincipal);
  const selectedExplorerNode = selectedExplorerState?.key === explorerSelectionKey
    ? selectedExplorerState.node
    : explorerNodeFromSelection(selectedPath, currentNode, currentChildren);
  const explorerWriteDisabledReason = writeDisabledReason(
    readMode,
    readIdentity,
    currentDatabaseRole,
    readIdentity && !currentDatabaseRole ? databaseListError : null
  );
  const explorerCreateDirectory = createDirectoryForExplorerNode(selectedExplorerNode);
  const explorerMutationTarget = selectedExplorerNode && isMutableWikiExplorerNode(selectedExplorerNode) ? selectedExplorerNode : null;
  const selectedExplorerChildren = selectedExplorerNode?.kind === "folder"
    && currentChildren.path === selectedExplorerNode.path
    ? currentChildren.data ?? undefined
    : undefined;
  const explorerDeleteTarget = explorerMutationTarget && isDeletableWikiExplorerNode(explorerMutationTarget, selectedExplorerChildren) ? explorerMutationTarget : null;
  useEffect(() => {
    const nextTargets = loadedWikiFolders(childNodesCache.current, explorerMutationTarget);
    setExplorerMoveTargets((currentTargets) => sameStringList(currentTargets, nextTargets) ? currentTargets : nextTargets);
  }, [explorerMutationTarget, explorerRevision]);
  const rememberSelectedExplorerNode = useCallback((nextNode: ChildNode) => {
    const key = nodeRequestKey(canisterId, databaseId, nextNode.path, readPrincipal);
    setSelectedExplorerState((current) => {
      if (
        current?.key === key &&
        current.node.path === nextNode.path &&
        current.node.kind === nextNode.kind &&
        current.node.etag === nextNode.etag &&
        current.node.isVirtual === nextNode.isVirtual
      ) {
        return current;
      }
      return { key, node: nextNode };
    });
  }, [canisterId, databaseId, readPrincipal, setSelectedExplorerState]);
  const createMarkdownFile = useCallback(async (directoryPath: string, fileName: string) => {
    if (!canLeaveDirtyEdit()) return false;
    if (readMode === "anonymous") throw new Error("Authenticated mode is required.");
    if (!readIdentity) throw new Error("Login with Internet Identity to create Markdown files.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    const nextPath = wikiMarkdownChildPath(directoryPath, fileName);
    const { writeNodeAuthenticated } = await import("@/lib/vfs-client");
    await writeNodeAuthenticated(canisterId, readIdentity, {
      databaseId,
      path: nextPath,
      kind: "file",
      content: "",
      metadataJson: "{}",
      expectedEtag: null
    });
    invalidateBrowserCaches();
    setEditState(EMPTY_EDIT_STATE);
    router.replace(hrefForPath(canisterId, databaseId, nextPath, "edit", tab, undefined, undefined, readMode));
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, readMode, router, setEditState, tab]);
  const createFolderNode = useCallback(async (directoryPath: string, folderName: string) => {
    if (!canLeaveDirtyEdit()) return false;
    if (readMode === "anonymous") throw new Error("Authenticated mode is required.");
    if (!readIdentity) throw new Error("Login with Internet Identity to create folders.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    const nextPath = wikiChildPath(directoryPath, folderName, "folder");
    const { mkdirNodeAuthenticated } = await import("@/lib/vfs-client");
    await mkdirNodeAuthenticated(canisterId, readIdentity, {
      databaseId,
      path: nextPath
    });
    invalidateBrowserCaches();
    setEditState(EMPTY_EDIT_STATE);
    router.replace(hrefForPath(canisterId, databaseId, nextPath, undefined, tab, undefined, undefined, readMode));
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, readMode, router, setEditState, tab]);
  const renameExplorerNode = useCallback(async (target: ChildNode, nextName: string) => {
    if (!canLeaveDirtyEdit()) return false;
    if (readMode === "anonymous") throw new Error("Authenticated mode is required.");
    if (!readIdentity) throw new Error("Login with Internet Identity to rename nodes.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    if (!isMutableWikiExplorerNode(target)) throw new Error("Only /Wiki Markdown files and folders can be renamed.");
    if (!target.etag) throw new Error("Cannot rename a node without an etag.");
    const normalizedName = target.kind === "file" ? normalizeMarkdownFileName(nextName) : normalizePathSegment(nextName);
    if (!normalizedName) throw new Error("Enter a single valid name.");
    if (target.kind === "file" && isReservedFolderIndexName(normalizedName)) throw new Error("Use folder Edit to create index.md.");
    const nextPath = `${parentPath(target.path) ?? "/Wiki"}/${normalizedName}`;
    const { moveNodeAuthenticated } = await import("@/lib/vfs-client");
    await moveNodeAuthenticated(canisterId, readIdentity, {
      databaseId,
      fromPath: target.path,
      toPath: nextPath,
      expectedEtag: target.etag,
      overwrite: false
    });
    invalidateBrowserCaches();
    setEditState(EMPTY_EDIT_STATE);
    router.replace(hrefForPath(canisterId, databaseId, nextPath, target.kind === "file" ? view : undefined, tab, undefined, undefined, readMode));
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, readMode, router, setEditState, tab, view]);
  const moveExplorerNode = useCallback(async (target: ChildNode, targetDirectory: string) => {
    if (!canLeaveDirtyEdit()) return false;
    if (readMode === "anonymous") throw new Error("Authenticated mode is required.");
    if (!readIdentity) throw new Error("Login with Internet Identity to move nodes.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    if (!isMutableWikiExplorerNode(target)) throw new Error("Only /Wiki Markdown files and folders can be moved.");
    if (!target.etag) throw new Error("Cannot move a node without an etag.");
    if (!isWikiPath(targetDirectory)) throw new Error("Move destination must be under /Wiki.");
    const nextPath = `${targetDirectory}/${target.name}`;
    if (nextPath === target.path) return false;
    const { moveNodeAuthenticated } = await import("@/lib/vfs-client");
    await moveNodeAuthenticated(canisterId, readIdentity, {
      databaseId,
      fromPath: target.path,
      toPath: nextPath,
      expectedEtag: target.etag,
      overwrite: false
    });
    invalidateBrowserCaches();
    setEditState(EMPTY_EDIT_STATE);
    router.replace(hrefForPath(canisterId, databaseId, nextPath, target.kind === "file" ? view : undefined, tab, undefined, undefined, readMode));
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, readMode, router, setEditState, tab, view]);
  const deleteExplorerNode = useCallback(async (target: ChildNode) => {
    if (!canLeaveDirtyEdit()) return false;
    if (readMode === "anonymous") throw new Error("Authenticated mode is required.");
    if (!readIdentity) throw new Error("Login with Internet Identity to delete nodes.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    const targetChildren = target.kind === "folder"
      ? childNodesCache.current.get(nodeRequestKey(canisterId, databaseId, target.path, readPrincipal))
      : undefined;
    if (!isDeletableWikiExplorerNode(target, targetChildren)) throw new Error("Only /Wiki Markdown files and folders without visible children can be deleted.");
    if (!target.etag) throw new Error("Cannot delete a node without an etag.");
    if (!window.confirm(`Delete ${target.path}?`)) return false;
    const { deleteNodeAuthenticated, readNode } = await import("@/lib/vfs-client");
    const indexNode = target.kind === "folder"
      ? await readNode(canisterId, databaseId, folderIndexPath(target.path), readIdentity)
      : null;
    await deleteNodeAuthenticated(canisterId, readIdentity, {
      databaseId,
      path: target.path,
      expectedEtag: target.etag,
      expectedFolderIndexEtag: indexNode?.etag ?? null
    });
    invalidateBrowserCaches();
    setEditState(EMPTY_EDIT_STATE);
    if (selectedPath === target.path) {
      router.replace(hrefForPath(canisterId, databaseId, parentPath(target.path) ?? "/Wiki", undefined, tab, undefined, undefined, readMode));
    }
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, readMode, readPrincipal, router, selectedPath, setEditState, tab]);

  async function submitExplorerCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExplorerActionError(null);
    if (!explorerActionMode) return;
    const normalizedName = explorerActionMode === "folder" || (explorerActionMode === "rename" && explorerMutationTarget?.kind === "folder")
      ? normalizePathSegment(explorerDraftName)
      : normalizeMarkdownFileName(explorerDraftName);
    if (!normalizedName) {
      setExplorerActionError(explorerActionMode === "folder" ? "Enter a folder name, not a path." : "Enter a Markdown file name, not a path.");
      return;
    }
    setExplorerBusyAction(explorerActionMode);
    try {
      const created = explorerActionMode === "rename" && explorerMutationTarget
        ? await renameExplorerNode(explorerMutationTarget, normalizedName)
        : explorerActionMode === "folder"
          ? await createFolderNode(explorerCreateDirectory, normalizedName)
          : await createMarkdownFile(explorerCreateDirectory, normalizedName);
      if (created) {
        setExplorerActionMode(null);
        setExplorerDraftName("");
      }
    } catch (cause) {
      setExplorerActionError(errorMessage(cause));
    } finally {
      setExplorerBusyAction(null);
    }
  }

  async function runExplorerDelete() {
    if (!explorerDeleteTarget) return;
    setExplorerActionError(null);
    setExplorerBusyAction("delete");
    try {
      const deleted = await deleteExplorerNode(explorerDeleteTarget);
      if (deleted) {
        setExplorerActionMode(null);
      }
    } catch (cause) {
      setExplorerActionError(errorMessage(cause));
    } finally {
      setExplorerBusyAction(null);
    }
  }

  async function runExplorerMove() {
    if (!explorerMutationTarget) return;
    setExplorerActionError(null);
    setExplorerBusyAction("move");
    try {
      const moved = await moveExplorerNode(explorerMutationTarget, explorerMoveTarget);
      if (moved) {
        setExplorerMoveOpen(false);
      }
    } catch (cause) {
      setExplorerActionError(errorMessage(cause));
    } finally {
      setExplorerBusyAction(null);
    }
  }

  useEffect(() => {
    const loadError = currentNode.error || currentChildren.error;
    if (readMode === "anonymous" || !isPermissionError(loadError)) return;
    const anonymousHref = hrefForCurrentReadRoute(canisterId, databaseId, {
      graphCenter,
      graphDepth,
      isGraphPage,
      isSearchPage,
      query,
      searchKind,
      selectedPath,
      tab,
      view
    });
    if (anonymousHref) {
      router.replace(anonymousHref);
    }
  }, [canisterId, currentChildren.error, currentNode.error, databaseId, graphCenter, graphDepth, isGraphPage, isSearchPage, query, readMode, router, searchKind, selectedPath, tab, view]);

  return (
    <main className="flex min-h-screen flex-col bg-canvas text-ink lg:h-screen lg:overflow-hidden">
      <TopBar
        canisterId={canisterId}
        databaseId={databaseId}
        authError={authError}
        principal={authPrincipal}
        query={query}
        searchKind={searchKind}
        graphDepth={graphDepth}
        isGraphPage={isGraphPage}
        isSearchPage={isSearchPage}
        graphCenter={graphCenter}
        readMode={readMode}
        databaseOptions={databaseOptions}
        currentDatabaseName={currentDatabase?.name ?? databaseId}
        publicReadable={publicDatabaseIds.has(databaseId)}
        databaseListError={databaseListError}
        selectedPath={selectedPath}
        authReady={Boolean(authClient)}
        mobileSidebarOpen={mobileSidebarOpen}
        onLogin={login}
        onLogout={guardedLogout}
        onMobileSidebarToggle={() => setMobileSidebarOpen((open) => !open)}
        canLeaveDirtyEdit={canLeaveDirtyEdit}
      />
      <section className={`grid min-h-0 grid-cols-1 gap-3 p-3 lg:flex-1 ${isSearchPage || isGraphPage ? "lg:grid-cols-[320px_minmax(0,1fr)]" : "lg:grid-cols-[320px_minmax(0,1fr)_320px]"}`}>
        <aside
          id="wiki-mobile-sidebar"
          data-tid="wiki-explorer-panel"
          className={`${mobileSidebarOpen ? "order-1 flex" : "hidden"} min-h-0 flex-col rounded-2xl border border-line bg-paper/90 shadow-sm lg:order-1 lg:flex lg:overflow-hidden`}
        >
          <PanelHeader
            icon={<GitBranch size={15} />}
            title={tabTitle(tab)}
            actions={tab === "explorer" ? (
              <ExplorerHeaderActions
                fileDisabled={Boolean(explorerWriteDisabledReason) || explorerBusyAction !== null}
                folderDisabled={Boolean(explorerWriteDisabledReason) || explorerBusyAction !== null}
                renameDisabled={Boolean(explorerWriteDisabledReason) || explorerBusyAction !== null || !explorerMutationTarget}
                moveDisabled={Boolean(explorerWriteDisabledReason) || explorerBusyAction !== null || !explorerMutationTarget || explorerMoveTargets.length === 0}
                deleteDisabled={Boolean(explorerWriteDisabledReason) || explorerBusyAction !== null || !explorerDeleteTarget}
                fileTitle={explorerWriteDisabledReason ?? `New file in ${explorerCreateDirectory}`}
                folderTitle={explorerWriteDisabledReason ?? `New folder in ${explorerCreateDirectory}`}
                renameTitle={explorerWriteDisabledReason ?? (explorerMutationTarget ? `Rename ${explorerMutationTarget.path}` : "Select a /Wiki Markdown file or folder to rename")}
                moveTitle={explorerWriteDisabledReason ?? (explorerMutationTarget ? `Move ${explorerMutationTarget.path}` : "Select a /Wiki Markdown file or folder to move")}
                deleteTitle={explorerWriteDisabledReason ?? (explorerDeleteTarget ? `Delete ${explorerDeleteTarget.path}` : "Select a /Wiki Markdown file or folder without visible children to delete")}
                onNewFile={() => {
                  setExplorerActionError(null);
                  setExplorerActionMode("file");
                  setExplorerDraftName("");
                  setExplorerMoveOpen(false);
                }}
                onNewFolder={() => {
                  setExplorerActionError(null);
                  setExplorerActionMode("folder");
                  setExplorerDraftName("");
                  setExplorerMoveOpen(false);
                }}
                onRename={() => {
                  if (!explorerMutationTarget) return;
                  setExplorerActionError(null);
                  setExplorerActionMode("rename");
                  setExplorerDraftName(explorerMutationTarget.name);
                  setExplorerMoveOpen(false);
                }}
                onMove={() => {
                  if (!explorerMutationTarget) return;
                  setExplorerActionError(null);
                  setExplorerActionMode(null);
                  setExplorerMoveTarget(explorerMoveTargets[0] ?? "/Wiki");
                  setExplorerMoveOpen(true);
                }}
                onDelete={() => void runExplorerDelete()}
              />
            ) : undefined}
          />
          <ModeTabs canisterId={canisterId} databaseId={databaseId} selectedPath={selectedPath} tab={tab} readMode={readMode} />
          {tab === "explorer" && explorerActionMode ? (
            <ExplorerCreateForm
              mode={explorerActionMode}
              directoryPath={explorerCreateDirectory}
              draftName={explorerDraftName}
              error={explorerActionError}
              busy={explorerBusyAction === explorerActionMode}
              onCancel={() => {
                setExplorerActionMode(null);
                setExplorerDraftName("");
                setExplorerActionError(null);
              }}
              onChange={setExplorerDraftName}
              onSubmit={submitExplorerCreate}
            />
          ) : tab === "explorer" && explorerMoveOpen && explorerMutationTarget ? (
            <ExplorerMoveForm
              target={explorerMutationTarget}
              folders={explorerMoveTargets}
              value={explorerMoveTarget}
              error={explorerActionError}
              busy={explorerBusyAction === "move"}
              onCancel={() => {
                setExplorerMoveOpen(false);
                setExplorerActionError(null);
              }}
              onChange={setExplorerMoveTarget}
              onSubmit={() => void runExplorerMove()}
            />
          ) : tab === "explorer" && explorerActionError ? (
            <ExplorerActionError message={explorerActionError} />
          ) : null}
          <LeftPane
            tab={tab}
            canisterId={canisterId}
            databaseId={databaseId}
            selectedPath={selectedPath}
            childNodesCache={childNodesCache}
            autoExpandExplorer={!(isGraphPage && !graphCenter)}
            readIdentity={readIdentity}
            effectiveReadIdentity={effectiveReadIdentity}
            currentNode={currentNode.data}
            readIdentityMode={currentReadIdentityMode}
            readMode={readMode}
            explorerRevision={explorerRevision}
            onSelectedExplorerNode={rememberSelectedExplorerNode}
          />
        </aside>
        <section data-tid="wiki-document-panel" className={`${mobileSidebarOpen ? "order-2" : "order-1"} flex min-h-0 flex-col rounded-2xl border border-line bg-white shadow-sm lg:order-2 lg:overflow-hidden`}>
          {isGraphPage ? (
            <GraphPanel canisterId={canisterId} databaseId={databaseId} centerPath={graphCenter} depth={graphDepth} readIdentity={effectiveReadIdentity} readMode={readMode} />
          ) : isSearchPage ? (
            <SearchPanel canisterId={canisterId} databaseId={databaseId} query={query} initialKind={searchKind} readIdentity={effectiveReadIdentity} readMode={readMode} />
          ) : (
            <>
              <DocumentHeader
                canisterId={canisterId}
                databaseId={databaseId}
                path={selectedPath}
                view={view}
                editState={activeEditState}
                rawContent={currentNode.data?.kind === "file" ? currentNode.data.content : null}
                onViewChange={(nextView) => {
                  if (nextView !== "edit" && !canLeaveDirtyEdit()) {
                    return;
                  }
                  router.replace(hrefForPath(canisterId, databaseId, selectedPath, nextView, tab, undefined, undefined, readMode));
                }}
                isDirectory={currentNode.data?.kind === "folder" || (!currentNode.data && Boolean(currentChildren.data))}
                canEditDirectory={currentNode.data?.kind === "folder" && isWikiPath(selectedPath)}
              />
              <DocumentBreadcrumbs canisterId={canisterId} databaseId={databaseId} path={selectedPath} readMode={readMode} />
              <DocumentPane
                node={currentNode}
                folderIndexNode={currentFolderIndexNode}
                childrenState={currentChildren}
                view={view}
                canisterId={canisterId}
                databaseId={databaseId}
                authPrompt={authPrompt}
                onLogin={login}
                authReady={Boolean(authClient)}
                writeIdentity={readIdentity}
                currentDatabaseRole={currentDatabaseRole}
                databaseRoleError={readIdentity && !currentDatabaseRole ? databaseListError : null}
                onNodeSaved={refreshSelectedNodeContext}
                onFolderIndexSaved={refreshSelectedFolderIndex}
                onEditStateChange={setEditState}
                tab={tab}
                readMode={readMode}
              />
            </>
          )}
        </section>
        {!isSearchPage && !isGraphPage ? (
          <aside data-tid="wiki-inspector-panel" className="order-3 hidden min-h-0 flex-col rounded-2xl border border-line bg-paper/90 shadow-sm lg:flex lg:overflow-hidden">
            <PanelHeader icon={<PanelRight size={15} />} title="Inspector" subtitle="metadata and hints" />
            <Inspector
              canisterId={canisterId}
              databaseId={databaseId}
              databaseName={currentDatabase?.name ?? databaseId}
              path={selectedPath}
              node={currentNode.data}
              childNodes={currentChildren.data ?? []}
              noteRole={noteRole}
              incomingLinks={currentNodeContext.data?.incomingLinks ?? null}
              incomingError={currentNodeContext.error}
              outgoingLinks={currentNodeContext.data?.outgoingLinks ?? []}
              readIdentity={effectiveReadIdentity}
              readMode={readMode}
            />
          </aside>
        ) : null}
      </section>
    </main>
  );
}

function LeftPane({
  tab,
  canisterId,
  databaseId,
  selectedPath,
  childNodesCache,
  autoExpandExplorer,
  readIdentity,
  effectiveReadIdentity,
  currentNode,
  readIdentityMode,
  readMode,
  explorerRevision,
  onSelectedExplorerNode
}: {
  tab: ModeTab;
  canisterId: string;
  databaseId: string;
  selectedPath: string;
  childNodesCache: { current: Map<string, ChildNode[]> };
  autoExpandExplorer: boolean;
  readIdentity: Identity | null;
  effectiveReadIdentity: Identity | null;
  currentNode: WikiNode | null;
  readIdentityMode: "anonymous" | "user";
  readMode: "anonymous" | null;
  explorerRevision: number;
  onSelectedExplorerNode: (node: ChildNode) => void;
}) {
  if (tab === "query") {
    return (
      <QueryPanel
        canisterId={canisterId}
        databaseId={databaseId}
        selectedPath={selectedPath}
        currentNode={currentNode}
        readIdentity={effectiveReadIdentity}
        writeIdentity={readIdentity}
        readMode={readMode}
        readIdentityMode={readIdentityMode}
      />
    );
  }
  if (tab === "ingest") return <IngestPanel canisterId={canisterId} databaseId={databaseId} readIdentity={readIdentity} />;
  if (tab === "sources") return <SourcesPanel canisterId={canisterId} databaseId={databaseId} readIdentity={effectiveReadIdentity} writeIdentity={readIdentity} readMode={readMode} />;
  return (
    <ExplorerTree
      key={explorerRevision}
      canisterId={canisterId}
      databaseId={databaseId}
      selectedPath={selectedPath}
      autoExpandSelected={autoExpandExplorer}
      readIdentity={effectiveReadIdentity}
      readMode={readMode}
      childNodesCache={childNodesCache}
      onSelectedNode={onSelectedExplorerNode}
    />
  );
}

function ExplorerHeaderActions({
  fileDisabled,
  folderDisabled,
  renameDisabled,
  moveDisabled,
  deleteDisabled,
  fileTitle,
  folderTitle,
  renameTitle,
  moveTitle,
  deleteTitle,
  onNewFile,
  onNewFolder,
  onRename,
  onMove,
  onDelete
}: {
  fileDisabled: boolean;
  folderDisabled: boolean;
  renameDisabled: boolean;
  moveDisabled: boolean;
  deleteDisabled: boolean;
  fileTitle: string;
  folderTitle: string;
  renameTitle: string;
  moveTitle: string;
  deleteTitle: string;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onNewFile}
        disabled={fileDisabled}
        title={fileTitle}
        aria-label="New Markdown file"
      >
        <FilePlus size={15} />
      </button>
      <button
        type="button"
        className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onNewFolder}
        disabled={folderDisabled}
        title={folderTitle}
        aria-label="New folder"
      >
        <FolderPlus size={15} />
      </button>
      <button
        type="button"
        className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onRename}
        disabled={renameDisabled}
        title={renameTitle}
        aria-label="Rename selected node"
      >
        <Pencil size={15} />
      </button>
      <button
        type="button"
        className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onMove}
        disabled={moveDisabled}
        title={moveTitle}
        aria-label="Move selected node"
      >
        <MoveRight size={15} />
      </button>
      <button
        type="button"
        className="rounded-md p-1 text-muted hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onDelete}
        disabled={deleteDisabled}
        title={deleteTitle}
        aria-label="Delete selected Markdown file"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function ExplorerCreateForm({
  mode,
  directoryPath,
  draftName,
  error,
  busy,
  onCancel,
  onChange,
  onSubmit
}: {
  mode: "file" | "folder" | "rename";
  directoryPath: string;
  draftName: string;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const label = mode === "rename" ? "Rename selected node" : mode === "folder" ? `New folder in ${directoryPath}` : `New file in ${directoryPath}`;
  const placeholder = mode === "folder" ? "project" : "note.md";
  const submitLabel = mode === "rename" ? "Rename selected node" : mode === "folder" ? "Create folder" : "Create Markdown file";
  return (
    <form className="border-b border-line px-3 py-2" onSubmit={onSubmit}>
      <div className="mb-1 truncate text-[11px] text-muted">{label}</div>
      <div className="flex items-center gap-1">
        <input
          className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-xs outline-none focus:border-accent"
          value={draftName}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          autoFocus
        />
        <button
          type="submit"
          className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy}
          aria-label={submitLabel}
          title={submitLabel}
        >
          <Check size={15} />
        </button>
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel Explorer action"
          title="Cancel"
        >
          <X size={15} />
        </button>
      </div>
      {error ? <div className="mt-1 text-xs text-red-600">{error}</div> : null}
    </form>
  );
}

function ExplorerMoveForm({
  target,
  folders,
  value,
  error,
  busy,
  onCancel,
  onChange,
  onSubmit
}: {
  target: ChildNode;
  folders: string[];
  value: string;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="border-b border-line px-3 py-2">
      <div className="mb-1 truncate text-[11px] text-muted">Move {target.path}</div>
      <div className="flex items-center gap-1">
        <select
          className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-xs outline-none focus:border-accent"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Move destination folder"
        >
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy || !value}
          aria-label="Move selected node"
          title="Move selected node"
          onClick={onSubmit}
        >
          <Check size={15} />
        </button>
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel move"
          title="Cancel"
        >
          <X size={15} />
        </button>
      </div>
      {error ? <div className="mt-1 text-xs text-red-600">{error}</div> : null}
    </div>
  );
}

function ExplorerActionError({ message }: { message: string }) {
  return <div className="border-b border-line px-3 py-2 text-xs text-red-600">{message}</div>;
}

function wikiMarkdownChildPath(directoryPath: string, fileName: string): string {
  const markdownFileName = normalizeMarkdownFileName(fileName);
  if (!markdownFileName) throw new Error("Enter a Markdown file name, not a path.");
  if (isReservedFolderIndexName(markdownFileName)) throw new Error("Use folder Edit to create index.md.");
  return wikiChildPath(directoryPath, markdownFileName, "Markdown files");
}

function wikiChildPath(directoryPath: string, name: string, label: string): string {
  if (!isWikiPath(directoryPath)) {
    throw new Error(`${label} can only be created under /Wiki.`);
  }
  return `${directoryPath}/${name}`;
}

function normalizeMarkdownFileName(fileName: string): string | null {
  const trimmed = fileName.trim();
  if (!trimmed || trimmed.includes("/") || trimmed === "." || trimmed === ".." || trimmed === ".md") {
    return null;
  }
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function normalizePathSegment(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed === "." || trimmed === "..") {
    return null;
  }
  return trimmed;
}

function createDirectoryForExplorerNode(node: ChildNode | null): string {
  if (!node) {
    return "/Wiki";
  }
  if ((node.kind === "directory" || node.kind === "folder") && isWikiPath(node.path)) {
    return node.path;
  }
  if (node.kind === "file" && isWikiPath(node.path)) {
    return parentPath(node.path) ?? "/Wiki";
  }
  return "/Wiki";
}

function isMutableWikiExplorerNode(node: ChildNode): boolean {
  if (node.isVirtual || !node.etag || isProtectedRootFolder(node.path) || !node.path.startsWith("/Wiki/")) return false;
  return (node.kind === "file" && node.path.endsWith(".md")) || node.kind === "folder";
}

function isDeletableWikiExplorerNode(node: ChildNode, loadedChildren?: ChildNode[]): boolean {
  if (!isMutableWikiExplorerNode(node)) return false;
  if (node.kind === "folder") {
    return loadedChildren ? visibleChildren(loadedChildren, node.path).length === 0 : !node.hasChildren;
  }
  return true;
}

function loadedWikiFolders(cache: Map<string, ChildNode[]>, excludedNode: ChildNode | null): string[] {
  const paths = new Set<string>(["/Wiki"]);
  for (const children of cache.values()) {
    for (const child of children) {
      if (child.kind === "folder" && isWikiPath(child.path) && !isExcludedMoveFolder(child.path, excludedNode)) {
        paths.add(child.path);
      }
    }
  }
  const excludedParent = excludedNode ? parentPath(excludedNode.path) : null;
  if (excludedParent && isWikiPath(excludedParent)) {
    paths.add(excludedParent);
  }
  return [...paths].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isExcludedMoveFolder(path: string, node: ChildNode | null): boolean {
  if (!node) return false;
  if (node.kind !== "folder") return false;
  return path === node.path || path.startsWith(`${node.path}/`);
}

function isWikiPath(path: string): boolean {
  return path === "/Wiki" || path.startsWith("/Wiki/");
}

function isProtectedRootFolder(path: string): boolean {
  return path === "/Wiki" || path === "/Sources";
}

function writeDisabledReason(
  readMode: "anonymous" | null,
  writeIdentity: Identity | null,
  currentDatabaseRole: DatabaseRole | null,
  databaseRoleError: string | null
): string | null {
  if (readMode === "anonymous") return "Switch to authenticated mode to change files.";
  if (!writeIdentity) return "Login with Internet Identity to change files.";
  if (databaseRoleError) return databaseRoleError;
  if (!currentDatabaseRole) return "Database role unavailable.";
  if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") return "Writer or owner access required.";
  return null;
}

function explorerNodeFromSelection(
  selectedPath: string,
  node: PathLoadState<WikiNode>,
  children: PathLoadState<ChildNode[]>
): ChildNode | null {
  if (node.data) {
    return {
      path: node.data.path,
      name: pathName(node.data.path),
      kind: node.data.kind,
      updatedAt: node.data.updatedAt,
      etag: node.data.etag,
      sizeBytes: null,
      isVirtual: false,
      hasChildren: node.data.kind === "folder" && Boolean(children.data && visibleChildren(children.data, node.data.path).length)
    };
  }
  if (children.data) {
    return {
      path: selectedPath,
      name: pathName(selectedPath),
      kind: "directory",
      updatedAt: null,
      etag: null,
      sizeBytes: null,
      isVirtual: true,
      hasChildren: true
    };
  }
  return null;
}

function pathName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function TopBar({
  canisterId,
  databaseId,
  authError,
  principal,
  query,
  searchKind,
  graphDepth,
  isGraphPage,
  isSearchPage,
  graphCenter,
  readMode,
  databaseOptions,
  currentDatabaseName,
  publicReadable,
  databaseListError,
  selectedPath,
  authReady,
  mobileSidebarOpen,
  onLogin,
  onLogout,
  onMobileSidebarToggle,
  canLeaveDirtyEdit
}: {
  canisterId: string;
  databaseId: string;
  authError: string | null;
  principal: string | null;
  query: string;
  searchKind: "path" | "full";
  graphDepth: 1 | 2;
  isGraphPage: boolean;
  isSearchPage: boolean;
  graphCenter: string | null;
  readMode: "anonymous" | null;
  databaseOptions: DatabaseSummary[];
  currentDatabaseName: string;
  publicReadable: boolean;
  databaseListError: string | null;
  selectedPath: string;
  authReady: boolean;
  mobileSidebarOpen: boolean;
  onLogin: () => void;
  onLogout: () => void;
  onMobileSidebarToggle: () => void;
  canLeaveDirtyEdit: () => boolean;
}) {
  const router = useRouter();
  const graphLinkCenter = isGraphPage ? graphCenter : selectedPath;
  const graphHref = isGraphPage
    ? hrefForPath(canisterId, databaseId, graphLinkCenter ?? "/Wiki", undefined, undefined, undefined, undefined, readMode)
    : hrefForGraph(canisterId, databaseId, graphLinkCenter, undefined, readMode);
  const visibleError = authError ?? databaseListError;

  function switchDatabase(event: ChangeEvent<HTMLSelectElement>) {
    const nextDatabaseId = event.target.value;
    if (!nextDatabaseId || nextDatabaseId === databaseId) return;
    if (!canLeaveDirtyEdit()) return;
    router.replace(
      hrefForDatabaseSwitch(canisterId, nextDatabaseId, {
        isSearchPage,
        isGraphPage,
        query,
        searchKind,
        graphDepth,
        readMode
      })
    );
  }

  return (
    <header className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-line bg-paper/80 px-3 py-2 backdrop-blur lg:grid-cols-[auto_minmax(280px,720px)_auto] lg:items-center lg:gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className={`inline-flex items-center justify-center rounded-lg border p-2 lg:hidden ${mobileSidebarOpen ? "border-accent bg-accent text-white" : "border-line bg-white text-ink hover:border-accent hover:bg-accentSoft"}`}
          aria-controls="wiki-mobile-sidebar"
          aria-expanded={mobileSidebarOpen}
          aria-label="Toggle Explorer tabs"
          data-tid="mobile-sidebar-toggle"
          onClick={onMobileSidebarToggle}
        >
          <Menu size={18} aria-hidden />
        </button>
        <Link
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm font-semibold leading-tight text-ink no-underline hover:border-accent"
          href="/"
          aria-label="Back to database dashboard"
        >
          <Image className="h-5 w-5 rounded-md" src="/icon.png" alt="" width={20} height={20} unoptimized />
          Kinic Wiki
        </Link>
        <div className="flex min-w-0 shrink-0 items-center gap-1 text-xs text-muted">
          <label className="hidden font-mono sm:inline" htmlFor="database-switcher">
            db:
          </label>
          <select
            id="database-switcher"
            className="w-[132px] rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-xs text-ink outline-none sm:w-[180px]"
            value={databaseId}
            onChange={switchDatabase}
            aria-label="Switch database"
          >
            {databaseOptions.map((database) => (
              <option key={database.databaseId} value={database.databaseId}>
                {database.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="col-span-2 min-w-0 lg:col-span-1 lg:col-start-2 lg:row-start-1">
        <HeaderSearch canisterId={canisterId} databaseId={databaseId} query={query} searchKind={searchKind} readMode={readMode} canLeaveDirtyEdit={canLeaveDirtyEdit} />
      </div>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:justify-end">
        {visibleError ? <span className="hidden max-w-[220px] truncate text-xs text-red-700 md:inline">{visibleError}</span> : null}
        {publicReadable ? (
          <a
            aria-label={`Share ${currentDatabaseName} on X`}
            className={`${HEADER_ICON_LINK_CLASS} border-line bg-white text-ink hover:border-accent hover:bg-accentSoft`}
            href={xShareDatabaseHref({ databaseId, databaseName: currentDatabaseName })}
            rel="noreferrer"
            target="_blank"
            title="Share on X"
          >
            <Share2 aria-hidden size={18} />
            <span className="hidden sm:inline">Share</span>
          </a>
        ) : null}
        <Link
          className={`${HEADER_ICON_LINK_CLASS} ${isGraphPage ? "border-accent bg-accent text-white" : "border-line bg-white text-ink hover:border-accent hover:bg-accentSoft"}`}
          href={graphHref}
          aria-label="Graph"
          title={isGraphPage ? "Close graph" : "Graph"}
        >
          <Network size={18} aria-hidden />
          <span className="sr-only sm:not-sr-only">Graph</span>
        </Link>
        <CycleBattery canisterId={canisterId} />
        {principal ? (
          <button className="ml-auto rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink lg:ml-0" type="button" onClick={onLogout}>
            Logout
          </button>
        ) : (
          <button
            className="ml-auto rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60 lg:ml-0"
            data-tid="header-login-button"
            disabled={!authReady}
            type="button"
            onClick={onLogin}
          >
            Login
          </button>
        )}
      </div>
    </header>
  );
}

function mergeDatabaseSummaries(memberDatabases: DatabaseSummary[], publicDatabases: DatabaseSummary[]): DatabaseSummary[] {
  const rows = new Map<string, DatabaseSummary>();
  for (const database of publicDatabases) {
    rows.set(database.databaseId, database);
  }
  for (const database of memberDatabases) {
    rows.set(database.databaseId, database);
  }
  return [...rows.values()].sort((left, right) => left.databaseId.localeCompare(right.databaseId));
}

function withCurrentDatabase(databases: DatabaseSummary[], databaseId: string): DatabaseSummary[] {
  if (!databaseId || databases.some((database) => database.databaseId === databaseId)) {
    return databases;
  }
  return [
    {
      databaseId,
      name: databaseId,
      role: "reader",
      status: "hot",
      logicalSizeBytes: "0",
      archivedAtMs: null,
      deletedAtMs: null
    },
    ...databases
  ];
}

function databaseListWarning(publicResult: PromiseSettledResult<DatabaseSummary[]>, memberResult: PromiseSettledResult<DatabaseSummary[]>): string | null {
  if (publicResult.status === "rejected") return `Public database list unavailable: ${errorMessage(publicResult.reason)}`;
  if (memberResult.status === "rejected") return `Member database list unavailable: ${errorMessage(memberResult.reason)}`;
  return null;
}

export function isPermissionError(message: string | null): boolean {
  return Boolean(message && /access|auth|permission|principal|unauthorized|not allowed|forbidden/i.test(message));
}

function HeaderSearch({
  canisterId,
  databaseId,
  query,
  searchKind,
  readMode,
  canLeaveDirtyEdit
}: {
  canisterId: string;
  databaseId: string;
  query: string;
  searchKind: "path" | "full";
  readMode: "anonymous" | null;
  canLeaveDirtyEdit: () => boolean;
}) {
  const router = useRouter();
  const draftKey = `${query}\n${searchKind}`;
  const [draft, setDraft] = useState({ key: draftKey, text: query, kind: searchKind });
  const text = draft.key === draftKey ? draft.text : query;
  const kind = draft.key === draftKey ? draft.kind : searchKind;

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canLeaveDirtyEdit()) return;
    router.replace(hrefForSearch(canisterId, databaseId, text.trim(), kind, readMode));
  }

  return (
    <form className="flex min-w-0 flex-1 basis-full items-center gap-1.5 rounded-xl border border-line bg-white px-2 py-1.5 text-sm sm:basis-[360px] sm:gap-2 lg:max-w-[720px]" onSubmit={submitSearch}>
      <div className="flex shrink-0 rounded-lg border border-line bg-paper p-1 text-xs">
        <SearchKindButton active={kind === "path"} label="Path" onClick={() => setDraft({ key: draftKey, text, kind: "path" })} />
        <SearchKindButton active={kind === "full"} label="Full text" onClick={() => setDraft({ key: draftKey, text, kind: "full" })} />
      </div>
      <Search size={15} className="hidden shrink-0 text-muted min-[360px]:block" />
      <input
        className="min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-muted"
        value={text}
        onChange={(event) => setDraft({ key: draftKey, text: event.target.value, kind })}
        placeholder="Search wiki"
        aria-label="Search wiki"
      />
      <button className="inline-flex shrink-0 items-center justify-center gap-1 rounded-2xl bg-action px-2.5 py-1.5 font-bold text-white hover:-translate-y-[3px] hover:bg-accent sm:px-3" type="submit">
        <Search size={15} aria-hidden />
        <span className="sr-only sm:not-sr-only">Search</span>
      </button>
    </form>
  );
}

function SearchKindButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`rounded-md px-2 py-1 ${active ? "bg-white text-accentText shadow-sm" : "text-muted hover:text-accentText"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ModeTabs({
  canisterId,
  databaseId,
  selectedPath,
  tab,
  readMode
}: {
  canisterId: string;
  databaseId: string;
  selectedPath: string;
  tab: ModeTab;
  readMode: "anonymous" | null;
}) {
  return (
    <nav className="border-b border-line px-3 py-2" aria-label="Left sidebar mode">
      <div className="grid grid-cols-4 gap-1 rounded-xl border border-line bg-white p-1 text-center text-xs">
        {SIDEBAR_TABS.map((value) => (
          <Link
            key={value}
            href={hrefForPath(canisterId, databaseId, selectedPath, undefined, value, undefined, undefined, readMode)}
            className={`rounded-lg px-1.5 py-1.5 no-underline ${tab === value ? "bg-accent text-white" : "text-muted hover:bg-accentSoft hover:text-accentText"}`}
          >
            {tabLabel(value)}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function DocumentBreadcrumbs({
  canisterId,
  databaseId,
  path,
  readMode
}: {
  canisterId: string;
  databaseId: string;
  path: string;
  readMode: "anonymous" | null;
}) {
  const segments = path.split("/").filter(Boolean);
  const crumbs = segments.map((segment, index) => ({
    segment,
    path: `/${segments.slice(0, index + 1).join("/")}`,
    last: index === segments.length - 1
  }));
  return (
    <nav className="flex min-h-[36px] items-center gap-1 overflow-x-auto border-b border-line bg-white px-5 py-2 text-xs" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => {
        return (
          <span key={crumb.path} className="flex items-center gap-1">
            {index > 0 ? <span className="text-muted">/</span> : null}
            {crumb.last ? (
              <span className="max-w-[180px] truncate font-medium text-ink">{crumb.segment}</span>
            ) : (
              <Link
                className="max-w-[180px] truncate rounded px-1 py-0.5 text-muted no-underline hover:bg-paper hover:text-ink"
                href={hrefForPath(canisterId, databaseId, crumb.path, undefined, undefined, undefined, undefined, readMode)}
              >
                {crumb.segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function tabTitle(tab: ModeTab): string {
  if (tab === "query") return "Query";
  if (tab === "ingest") return "Ingest";
  if (tab === "sources") return "Sources";
  return "Explorer";
}

function tabLabel(tab: ModeTab): string {
  if (tab === "query") return "query";
  return tab;
}

function authPromptMode(readIdentity: Identity | null, loadError: string | null): "private" | null {
  if (readIdentity) return null;
  return isPermissionError(loadError) ? "private" : null;
}

function parseTab(value: string | null): ModeTab {
  return parseModeTab(value);
}

function parseView(value: string | null): ViewMode {
  if (value === "edit") return "edit";
  return value === "raw" ? "raw" : "preview";
}

function parseSearchKind(value: string | null): "path" | "full" {
  return value === "full" ? "full" : "path";
}

function parseReadMode(value: string | null): "anonymous" | null {
  return value === "anonymous" ? "anonymous" : null;
}

function parseGraphDepth(value: string | null): 1 | 2 {
  return value === "2" ? 2 : 1;
}

function hrefForCurrentReadRoute(
  canisterId: string,
  databaseId: string,
  state: {
    graphCenter: string | null;
    graphDepth: 1 | 2;
    isGraphPage: boolean;
    isSearchPage: boolean;
    query: string;
    searchKind: "path" | "full";
    selectedPath: string;
    tab: ModeTab;
    view: ViewMode;
  }
): string | null {
  if (state.isSearchPage) {
    return hrefForSearch(canisterId, databaseId, state.query, state.searchKind, "anonymous");
  }
  if (state.isGraphPage) {
    return state.graphCenter ? hrefForGraph(canisterId, databaseId, state.graphCenter, state.graphDepth, "anonymous") : null;
  }
  return hrefForPath(canisterId, databaseId, state.selectedPath, state.view, state.tab, undefined, undefined, "anonymous");
}

function currentNodeState(
  invalidCanister: string | null,
  canisterId: string,
  databaseId: string,
  selectedPath: string,
  requestKey: string,
  node: BrowserLoadState<WikiNode>
): PathLoadState<WikiNode> {
  if (typeof invalidCanister === "string") {
    return { path: selectedPath, data: null, error: "Invalid canister ID", hint: invalidCanister, loading: false };
  }
  return node.requestKey === requestKey ? node : browserLoadingState<WikiNode>(canisterId, databaseId, selectedPath);
}

function currentNodeContextState(
  invalidCanister: string | null,
  canisterId: string,
  databaseId: string,
  selectedPath: string,
  requestKey: string,
  nodeContext: BrowserLoadState<NodeContext>
): PathLoadState<NodeContext> {
  if (typeof invalidCanister === "string") {
    return { path: selectedPath, data: null, error: "Invalid canister ID", hint: invalidCanister, loading: false };
  }
  return nodeContext.requestKey === requestKey ? nodeContext : browserLoadingState<NodeContext>(canisterId, databaseId, selectedPath);
}

function currentChildrenState(
  invalidCanister: string | null,
  canisterId: string,
  databaseId: string,
  selectedPath: string,
  requestKey: string,
  childNodes: BrowserLoadState<ChildNode[]>
): PathLoadState<ChildNode[]> {
  if (typeof invalidCanister === "string") {
    return { path: selectedPath, data: null, error: null, loading: false };
  }
  return childNodes.requestKey === requestKey ? childNodes : browserLoadingState<ChildNode[]>(canisterId, databaseId, selectedPath);
}

function browserLoadingState<T>(canisterId: string, databaseId: string, path: string): BrowserLoadState<T> {
  return { ...loadingState<T>(path), requestKey: nodeRequestKey(canisterId, databaseId, path) };
}

function looksLikeFilePath(path: string): boolean {
  const name = path.split("/").filter(Boolean).at(-1) ?? "";
  return /\.[A-Za-z0-9]+$/.test(name);
}

function validateCanisterText(canisterId: string): string | null {
  if (!canisterId) {
    return "NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured";
  }
  if (!/^[a-z0-9-]+$/i.test(canisterId)) {
    return "NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID contains unsupported characters";
  }
  return null;
}

function parseWikiRoute(pathname: string): { databaseId: string | null; nodePath: string } {
  const segments = pathname.split("/").filter(Boolean);
  if (!segments[0]) {
    return { databaseId: null, nodePath: "/Wiki" };
  }
  const path = segments
    .slice(1)
    .filter(Boolean)
    .map(decodePathSegment)
    .join("/");
  return {
    databaseId: decodePathSegment(segments[0]),
    nodePath: path ? `/${path}` : "/Wiki",
  };
}

function isBrowserSearchPathname(canisterId: string, databaseId: string, pathname: string): boolean {
  void canisterId;
  return pathname === `/${encodeURIComponent(databaseId)}/search`;
}

function isBrowserGraphPathname(canisterId: string, databaseId: string, pathname: string): boolean {
  void canisterId;
  return pathname === `/${encodeURIComponent(databaseId)}/graph`;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
