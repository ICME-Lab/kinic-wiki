"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, FilePlus, FolderPlus, GitBranch, HelpCircle, Menu, MoveRight, Network, PanelRight, Pencil, Search, Share2, Trash2, Wallet, X } from "lucide-react";
import { DocumentHeader, DocumentPane, type DocumentEditState } from "@/components/document-pane";
import { ExplorerTree } from "@/components/explorer-tree";
import { HelpPanel } from "@/components/help-panel";
import { Inspector } from "@/components/inspector";
import { IngestPanel } from "@/components/ingest-panel";
import { QueryPanel } from "@/components/query-panel";
import { PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import { databaseCyclesDisabledReason, databaseCyclesHref, databaseCyclesView, formatCycles } from "@/lib/cycles-state";
import { readBrowserNodeCache } from "@/lib/browser-node-cache";
import { hrefForDatabaseSwitch, hrefForGraph, hrefForHelp, hrefForPath, hrefForSearch, parentPath } from "@/lib/paths";
import { nodeRequestKey } from "@/lib/request-keys";
import { parseSearchOptions, type SearchOptions } from "@/lib/search-options";
import { databaseRouteBase, xShareDatabaseHref } from "@/lib/share-links";
import type { CyclesBillingConfig, ChildNode, DatabaseRole, DatabaseSummary, NodeContext, WikiNode } from "@/lib/types";
import { getCyclesBillingConfig, listDatabasesAuthenticated, listDatabasesPublic } from "@/lib/vfs-client";
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
  STORE_ROOT_PATHS,
  type ModeTab,
  type PathLoadState,
  type ViewMode
} from "@/lib/wiki-helpers";

const SIDEBAR_TABS: ModeTab[] = ["explorer", "query", "ingest"];
const HEADER_ICON_LINK_CLASS = "inline-flex h-9 items-center justify-center gap-1 rounded-lg border px-3 text-sm no-underline";
const EMPTY_EDIT_STATE: DocumentEditState = { dirty: false, saveState: "idle" };
const UNSAVED_MARKDOWN_MESSAGE = "You have unsaved Markdown changes. Leave edit mode?";
const EMPTY_DATABASE_SUMMARIES: DatabaseSummary[] = [];
const EMPTY_PUBLIC_DATABASE_IDS: ReadonlySet<string> = new Set<string>();
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

type DatabaseDirectoryState = {
  requestKey: string;
  databases: DatabaseSummary[];
  memberDatabases: DatabaseSummary[];
  cyclesConfig: CyclesBillingConfig | null;
  publicDatabaseIds: ReadonlySet<string>;
  memberDatabasesLoaded: boolean;
  databaseListError: string | null;
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
  const isHelpPage = useMemo(() => isBrowserHelpPathname(canisterId, databaseId, pathname), [canisterId, databaseId, pathname]);
  const graphCenter = isGraphPage ? searchParams.get("center") : null;
  const graphDepth = parseGraphDepth(searchParams.get("depth"));
  const selectedPath = useMemo(
    () => isSearchPage || isHelpPage ? "/Knowledge" : isGraphPage ? graphCenter ?? "/Knowledge" : routeState.nodePath,
    [graphCenter, isGraphPage, isHelpPage, isSearchPage, routeState.nodePath]
  );
  const view = parseView(searchParams.get("view"));
  const tab = parseTab(searchParams.get("tab"));
  const query = isSearchPage ? searchParams.get("q") ?? "" : "";
  const searchKind = parseSearchKind(searchParams.get("kind"));
  const searchOptions = useMemo(() => parseSearchOptions(searchParams), [searchParams]);
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [readIdentity, setReadIdentity] = useState<Identity | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [databaseDirectory, setDatabaseDirectory] = useState<DatabaseDirectoryState>(() => emptyDatabaseDirectoryState(""));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const authPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const databaseDirectoryRequestKey = useMemo(() => `${canisterId}\n${authPrincipal ?? ""}`, [authPrincipal, canisterId]);
  const emptyCurrentDatabaseDirectory = useMemo(() => emptyDatabaseDirectoryState(databaseDirectoryRequestKey), [databaseDirectoryRequestKey]);
  const {
    databases,
    memberDatabases,
    cyclesConfig,
    publicDatabaseIds,
    memberDatabasesLoaded,
    databaseListError
  } = databaseDirectory.requestKey === databaseDirectoryRequestKey ? databaseDirectory : emptyCurrentDatabaseDirectory;
  const currentDatabaseRole = useMemo(
    () => readIdentity ? memberDatabases.find((database) => database.databaseId === databaseId)?.role ?? null : null,
    [databaseId, memberDatabases, readIdentity]
  );
  const currentReadIdentityMode = resolveReadIdentityMode(Boolean(readIdentity), Boolean(currentDatabaseRole), memberDatabasesLoaded, publicDatabaseIds.has(databaseId));
  const effectiveReadIdentity = currentReadIdentityMode === "user" ? readIdentity : null;
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
  const [explorerMoveTarget, setExplorerMoveTarget] = useState("/Knowledge");
  const [explorerMoveTargets, setExplorerMoveTargets] = useState<string[]>(["/Knowledge"]);
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
    const requestKey = databaseDirectoryRequestKey;
    let publicDatabases: DatabaseSummary[] = [];
    let authenticatedDatabases: DatabaseSummary[] = [];
    let nextCyclesConfig: CyclesBillingConfig | null = null;
    let nextMemberDatabasesLoaded = false;
    let cyclesConfigError: string | null = null;
    let publicListError: string | null = null;
    let memberListError: string | null = null;
    const updateDatabaseRows = () => {
      setDatabaseDirectory({
        requestKey,
        databases: mergeDatabaseSummaries(authenticatedDatabases, publicDatabases),
        memberDatabases: authenticatedDatabases,
        cyclesConfig: nextCyclesConfig,
        publicDatabaseIds: new Set(publicDatabases.map((database) => database.databaseId)),
        memberDatabasesLoaded: nextMemberDatabasesLoaded,
        databaseListError: databaseListWarning(cyclesConfigError, publicListError, memberListError)
      });
    };

    void listDatabasesPublic(canisterId)
      .then((nextPublicDatabases) => {
        if (cancelled) return;
        publicDatabases = nextPublicDatabases;
        publicListError = null;
        updateDatabaseRows();
      })
      .catch((cause) => {
        if (cancelled) return;
        publicDatabases = [];
        publicListError = errorMessage(cause);
        updateDatabaseRows();
      });

    void (readIdentity ? listDatabasesAuthenticated(canisterId, readIdentity) : Promise.resolve<DatabaseSummary[]>([]))
      .then((nextMemberDatabases) => {
        if (cancelled) return;
        authenticatedDatabases = nextMemberDatabases;
        memberListError = null;
        nextMemberDatabasesLoaded = true;
        updateDatabaseRows();
      })
      .catch((cause) => {
        if (cancelled) return;
        authenticatedDatabases = [];
        memberListError = errorMessage(cause);
        nextMemberDatabasesLoaded = false;
        updateDatabaseRows();
      });

    void getCyclesBillingConfig(canisterId)
      .then((loadedCyclesConfig) => {
        if (cancelled) return;
        cyclesConfigError = null;
        nextCyclesConfig = loadedCyclesConfig;
        updateDatabaseRows();
      })
      .catch((cause) => {
        if (cancelled) return;
        cyclesConfigError = errorMessage(cause);
        nextCyclesConfig = null;
        updateDatabaseRows();
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseDirectoryRequestKey, readIdentity]);

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
  const currentDatabaseCycleReason = useMemo(
    () => readIdentity && currentDatabaseRole ? databaseCyclesDisabledReason(currentDatabase, cyclesConfig) : null,
    [cyclesConfig, currentDatabase, currentDatabaseRole, readIdentity]
  );
  const explorerSelectionKey = nodeRequestKey(canisterId, databaseId, selectedPath, readPrincipal);
  const selectedExplorerNode = selectedExplorerState?.key === explorerSelectionKey
    ? selectedExplorerState.node
    : explorerNodeFromSelection(selectedPath, currentNode, currentChildren);
  const explorerWriteDisabledReason = writeDisabledReason(readIdentity, currentDatabaseRole, readIdentity && !currentDatabaseRole ? databaseListError : null, currentDatabaseCycleReason);
  const explorerCreateDirectory = createDirectoryForExplorerNode(selectedExplorerNode);
  const explorerMutationTarget = selectedExplorerNode && isMutableExplorerNode(selectedExplorerNode) ? selectedExplorerNode : null;
  const selectedExplorerChildren = selectedExplorerNode?.kind === "folder"
    && currentChildren.path === selectedExplorerNode.path
    ? currentChildren.data ?? undefined
    : undefined;
  const explorerDeleteTarget = explorerMutationTarget && isDeletableExplorerNode(explorerMutationTarget, selectedExplorerChildren) ? explorerMutationTarget : null;
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
    if (!readIdentity) throw new Error("Login with Internet Identity to create Markdown files.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    if (currentDatabaseCycleReason) throw new Error(currentDatabaseCycleReason);
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
    router.replace(hrefForPath(canisterId, databaseId, nextPath, "edit", tab));
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, router, setEditState, tab]);
  const createFolderNode = useCallback(async (directoryPath: string, folderName: string) => {
    if (!canLeaveDirtyEdit()) return false;
    if (!readIdentity) throw new Error("Login with Internet Identity to create folders.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    if (currentDatabaseCycleReason) throw new Error(currentDatabaseCycleReason);
    const nextPath = wikiChildPath(directoryPath, folderName, "folder");
    const { mkdirNodeAuthenticated } = await import("@/lib/vfs-client");
    await mkdirNodeAuthenticated(canisterId, readIdentity, {
      databaseId,
      path: nextPath
    });
    invalidateBrowserCaches();
    setEditState(EMPTY_EDIT_STATE);
    router.replace(hrefForPath(canisterId, databaseId, nextPath, undefined, tab));
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, router, setEditState, tab]);
  const renameExplorerNode = useCallback(async (target: ChildNode, nextName: string) => {
    if (!canLeaveDirtyEdit()) return false;
    if (!readIdentity) throw new Error("Login with Internet Identity to rename nodes.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    if (currentDatabaseCycleReason) throw new Error(currentDatabaseCycleReason);
    if (!isMutableExplorerNode(target)) throw new Error("Only Markdown files and folders can be renamed.");
    if (!target.etag) throw new Error("Cannot rename a node without an etag.");
    const normalizedName = target.kind === "file" ? normalizeMarkdownFileName(nextName) : normalizePathSegment(nextName);
    if (!normalizedName) throw new Error("Enter a single valid name.");
    if (target.kind === "file" && isReservedFolderIndexName(normalizedName)) throw new Error("Use folder Edit to create index.md.");
    const nextPath = childPath(parentPath(target.path) ?? "/", normalizedName);
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
    router.replace(hrefForPath(canisterId, databaseId, nextPath, target.kind === "file" ? view : undefined, tab));
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, router, setEditState, tab, view]);
  const moveExplorerNode = useCallback(async (target: ChildNode, targetDirectory: string) => {
    if (!canLeaveDirtyEdit()) return false;
    if (!readIdentity) throw new Error("Login with Internet Identity to move nodes.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    if (currentDatabaseCycleReason) throw new Error(currentDatabaseCycleReason);
    if (!isMutableExplorerNode(target)) throw new Error("Only Markdown files and folders can be moved.");
    if (!target.etag) throw new Error("Cannot move a node without an etag.");
    const nextPath = childPath(targetDirectory, target.name);
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
    router.replace(hrefForPath(canisterId, databaseId, nextPath, target.kind === "file" ? view : undefined, tab));
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, router, setEditState, tab, view]);
  const deleteExplorerNode = useCallback(async (target: ChildNode) => {
    if (!canLeaveDirtyEdit()) return false;
    if (!readIdentity) throw new Error("Login with Internet Identity to delete nodes.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    if (currentDatabaseCycleReason) throw new Error(currentDatabaseCycleReason);
    const targetChildren = target.kind === "folder"
      ? childNodesCache.current.get(nodeRequestKey(canisterId, databaseId, target.path, readPrincipal))
      : undefined;
    if (!isDeletableExplorerNode(target, targetChildren)) throw new Error("Only Markdown files and folders without visible children can be deleted.");
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
      router.replace(hrefForPath(canisterId, databaseId, parentPath(target.path) ?? "/Knowledge", undefined, tab));
    }
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, readIdentity, readPrincipal, router, selectedPath, setEditState, tab]);

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

  return (
    <main className="flex min-h-screen flex-col bg-canvas text-ink lg:h-screen lg:overflow-hidden">
      <TopBar
        canisterId={canisterId}
        databaseId={databaseId}
        authError={authError}
        principal={authPrincipal}
        query={query}
        searchKind={searchKind}
        searchOptions={searchOptions}
        graphDepth={graphDepth}
        isHelpPage={isHelpPage}
        isGraphPage={isGraphPage}
        isSearchPage={isSearchPage}
        graphCenter={graphCenter}
        databaseOptions={databaseOptions}
        currentDatabase={currentDatabase}
        currentDatabaseName={currentDatabase?.name ?? databaseId}
        cyclesConfig={cyclesConfig}
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
      <section className={`grid min-h-0 grid-cols-1 gap-3 p-3 lg:flex-1 ${isSearchPage || isGraphPage || isHelpPage ? "lg:grid-cols-[320px_minmax(0,1fr)]" : "lg:grid-cols-[320px_minmax(0,1fr)_320px]"}`}>
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
                renameTitle={explorerWriteDisabledReason ?? (explorerMutationTarget ? `Rename ${explorerMutationTarget.path}` : "Select a Markdown file or folder to rename")}
                moveTitle={explorerWriteDisabledReason ?? (explorerMutationTarget ? `Move ${explorerMutationTarget.path}` : "Select a Markdown file or folder to move")}
                deleteTitle={explorerWriteDisabledReason ?? (explorerDeleteTarget ? `Delete ${explorerDeleteTarget.path}` : "Select a Markdown file or folder without visible children to delete")}
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
                  setExplorerMoveTarget(explorerMoveTargets[0] ?? "/Knowledge");
                  setExplorerMoveOpen(true);
                }}
                onDelete={() => void runExplorerDelete()}
              />
            ) : undefined}
          />
          <ModeTabs canisterId={canisterId} databaseId={databaseId} selectedPath={selectedPath} tab={tab} />
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
            databaseCyclesError={currentDatabaseCycleReason}
            explorerRevision={explorerRevision}
            onSelectedExplorerNode={rememberSelectedExplorerNode}
          />
        </aside>
        <section data-tid="wiki-document-panel" className={`${mobileSidebarOpen ? "order-2" : "order-1"} flex min-h-0 flex-col rounded-2xl border border-line bg-white shadow-sm lg:order-2 lg:overflow-hidden`}>
          {isHelpPage ? (
            <HelpPanel />
          ) : isGraphPage ? (
            <GraphPanel canisterId={canisterId} databaseId={databaseId} centerPath={graphCenter} depth={graphDepth} readIdentity={effectiveReadIdentity} />
          ) : isSearchPage ? (
            <SearchPanel canisterId={canisterId} databaseId={databaseId} query={query} initialKind={searchKind} searchOptions={searchOptions} readIdentity={effectiveReadIdentity} />
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
                  router.replace(hrefForPath(canisterId, databaseId, selectedPath, nextView, tab));
                }}
                isDirectory={currentNode.data?.kind === "folder" || (!currentNode.data && Boolean(currentChildren.data))}
                canEditDirectory={currentNode.data?.kind === "folder"}
              />
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
                databaseCyclesError={currentDatabaseCycleReason}
                onNodeSaved={refreshSelectedNodeContext}
                onFolderIndexSaved={refreshSelectedFolderIndex}
                onEditStateChange={setEditState}
                tab={tab}
              />
            </>
          )}
        </section>
        {!isSearchPage && !isGraphPage && !isHelpPage ? (
          <details className="order-3 rounded-2xl border border-line bg-paper/90 shadow-sm lg:hidden">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">Details</summary>
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
            />
          </details>
        ) : null}
        {!isSearchPage && !isGraphPage && !isHelpPage ? (
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
  databaseCyclesError,
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
  databaseCyclesError: string | null;
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
        readIdentityMode={readIdentityMode}
        databaseCyclesError={databaseCyclesError}
      />
    );
  }
  if (tab === "ingest") {
    return (
      <IngestPanel
        canisterId={canisterId}
        databaseId={databaseId}
        readIdentity={readIdentity}
        databaseCyclesError={databaseCyclesError}
      />
    );
  }
  return (
    <ExplorerTree
      key={explorerRevision}
      canisterId={canisterId}
      databaseId={databaseId}
      selectedPath={selectedPath}
      autoExpandSelected={autoExpandExplorer}
      readIdentity={effectiveReadIdentity}
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
      <ExplorerActionButton
        onClick={onNewFile}
        disabled={fileDisabled}
        title={fileTitle}
        aria-label="New Markdown file"
      >
        <FilePlus size={15} />
      </ExplorerActionButton>
      <ExplorerActionButton
        onClick={onNewFolder}
        disabled={folderDisabled}
        title={folderTitle}
        aria-label="New folder"
      >
        <FolderPlus size={15} />
      </ExplorerActionButton>
      <ExplorerActionButton
        onClick={onRename}
        disabled={renameDisabled}
        title={renameTitle}
        aria-label="Rename selected node"
      >
        <Pencil size={15} />
      </ExplorerActionButton>
      <ExplorerActionButton
        onClick={onMove}
        disabled={moveDisabled}
        title={moveTitle}
        aria-label="Move selected node"
      >
        <MoveRight size={15} />
      </ExplorerActionButton>
      <ExplorerActionButton
        onClick={onDelete}
        disabled={deleteDisabled}
        title={deleteTitle}
        aria-label="Delete selected Markdown file"
        danger
      >
        <Trash2 size={15} />
      </ExplorerActionButton>
    </div>
  );
}

function ExplorerActionButton({
  children,
  danger = false,
  disabled,
  title,
  onClick,
  "aria-label": ariaLabel
}: {
  children: ReactNode;
  danger?: boolean;
  disabled: boolean;
  title: string;
  onClick: () => void;
  "aria-label": string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`h-8 w-8 rounded-xl text-muted disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "hover:bg-red-50 hover:text-red-700" : "hover:bg-accentSoft hover:text-accentText"}`}
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
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
  if (!isDatabasePath(directoryPath)) {
    throw new Error(`${label} can only be created under a database path.`);
  }
  return childPath(directoryPath, name);
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
    return "/Knowledge";
  }
  if ((node.kind === "directory" || node.kind === "folder") && isDatabasePath(node.path)) {
    return node.path;
  }
  if (node.kind === "file" && isDatabasePath(node.path)) {
    return parentPath(node.path) ?? "/Knowledge";
  }
  return "/Knowledge";
}

function isMutableExplorerNode(node: ChildNode): boolean {
  if (node.isVirtual || !node.etag || isProtectedRootFolder(node.path)) return false;
  return (node.kind === "file" && node.path.endsWith(".md")) || node.kind === "folder";
}

function isDeletableExplorerNode(node: ChildNode, loadedChildren?: ChildNode[]): boolean {
  if (!isMutableExplorerNode(node)) return false;
  if (node.kind === "folder") {
    return loadedChildren ? visibleChildren(loadedChildren, node.path).length === 0 : !node.hasChildren;
  }
  return true;
}

function loadedWikiFolders(cache: Map<string, ChildNode[]>, excludedNode: ChildNode | null): string[] {
  const paths = new Set<string>(STORE_ROOT_PATHS);
  for (const children of cache.values()) {
    for (const child of children) {
      if (child.kind === "folder" && isDatabasePath(child.path) && !isExcludedMoveFolder(child.path, excludedNode)) {
        paths.add(child.path);
      }
    }
  }
  const excludedParent = excludedNode ? parentPath(excludedNode.path) : null;
  if (excludedParent && isDatabasePath(excludedParent)) {
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

function isDatabasePath(path: string): boolean {
  return STORE_ROOT_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
}

function childPath(directoryPath: string, name: string): string {
  return directoryPath === "/" ? `/${name}` : `${directoryPath}/${name}`;
}

function isProtectedRootFolder(path: string): boolean {
  return STORE_ROOT_PATHS.some((root) => path === root);
}

function writeDisabledReason(
  writeIdentity: Identity | null,
  currentDatabaseRole: DatabaseRole | null,
  databaseRoleError: string | null,
  databaseCyclesError: string | null
): string | null {
  if (!writeIdentity) return "Login with Internet Identity to change files.";
  if (databaseRoleError) return databaseRoleError;
  if (!currentDatabaseRole) return "Database role unavailable.";
  if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") return "Writer or owner access required.";
  if (databaseCyclesError) return databaseCyclesError;
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
  searchOptions,
  graphDepth,
  isHelpPage,
  isGraphPage,
  isSearchPage,
  graphCenter,
  databaseOptions,
  currentDatabase,
  currentDatabaseName,
  cyclesConfig,
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
  searchOptions: SearchOptions;
  graphDepth: 1 | 2;
  isHelpPage: boolean;
  isGraphPage: boolean;
  isSearchPage: boolean;
  graphCenter: string | null;
  databaseOptions: DatabaseSummary[];
  currentDatabase: DatabaseSummary | null;
  currentDatabaseName: string;
  cyclesConfig: CyclesBillingConfig | null;
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
    ? hrefForPath(canisterId, databaseId, graphLinkCenter ?? "/Knowledge")
    : hrefForGraph(canisterId, databaseId, graphLinkCenter);
  const visibleError = authError ?? databaseListError;
  const cycles = databaseCyclesView(currentDatabase, cyclesConfig);

  function switchDatabase(event: ChangeEvent<HTMLSelectElement>) {
    const nextDatabaseId = event.target.value;
    if (!nextDatabaseId || nextDatabaseId === databaseId) return;
    if (!canLeaveDirtyEdit()) return;
    router.replace(
      hrefForDatabaseSwitch(canisterId, nextDatabaseId, {
        isSearchPage,
        isGraphPage,
        isHelpPage,
        query,
        searchKind,
        searchOptions,
        graphDepth
      })
    );
  }

  return (
    <header className="grid min-h-[64px] grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-line bg-white/90 px-3 py-3 backdrop-blur lg:grid-cols-[auto_minmax(280px,720px)_auto] lg:items-center lg:gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          className={`inline-flex items-center justify-center rounded-lg border p-2 lg:hidden ${mobileSidebarOpen ? "border-accent bg-accent text-white" : "border-line bg-white text-ink hover:border-accent hover:bg-accentSoft"}`}
          type="button"
          aria-expanded={mobileSidebarOpen}
          aria-controls="wiki-mobile-sidebar"
          aria-label="Toggle workspace panel"
          onClick={onMobileSidebarToggle}
        >
          <Menu size={18} aria-hidden />
        </button>
        <Link
          className="inline-flex items-center gap-2 rounded-2xl border border-line bg-white px-3 py-2 text-sm font-semibold leading-tight text-ink no-underline shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:text-accent"
          href="/dashboard"
          aria-label="Back to database dashboard"
        >
          <Image className="h-6 w-6 rounded-md" src="/kinic-mark.png" alt="" width={24} height={24} unoptimized />
          Kinic Wiki
        </Link>
        <div className="flex min-w-0 shrink-0 items-center gap-1 text-xs text-muted">
          <label className="hidden font-mono sm:inline" htmlFor="database-switcher">
            db:
          </label>
          <select
            id="database-switcher"
            className="h-10 w-[132px] rounded-2xl border border-line bg-white px-3 py-2 font-mono text-xs text-ink shadow-[0_4px_10px_#14142b0a] outline-none focus:border-accent sm:w-[180px]"
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
        <HeaderSearch canisterId={canisterId} databaseId={databaseId} query={query} searchKind={searchKind} canLeaveDirtyEdit={canLeaveDirtyEdit} />
      </div>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:justify-end">
        {visibleError ? <span className="hidden max-w-[220px] truncate text-xs text-red-700 md:inline">{visibleError}</span> : null}
        {publicReadable ? (
          <a
            aria-label={`Share ${currentDatabaseName} on X`}
            className={`${HEADER_ICON_LINK_CLASS} rounded-2xl border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white`}
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
          className={`${HEADER_ICON_LINK_CLASS} rounded-2xl lg:hidden ${isHelpPage ? "border-accent bg-accent text-white" : "border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white"}`}
          href={isHelpPage ? hrefForPath(canisterId, databaseId, "/Knowledge") : hrefForHelp(canisterId, databaseId)}
          aria-label="Help"
          title={isHelpPage ? "Close help" : "Help"}
        >
          <HelpCircle size={18} aria-hidden />
          <span className="sr-only sm:not-sr-only">Help</span>
        </Link>
        <Link
          className={`${HEADER_ICON_LINK_CLASS} rounded-2xl lg:hidden ${isGraphPage ? "border-accent bg-accent text-white" : "border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white"}`}
          href={graphHref}
          aria-label="Graph"
          title={isGraphPage ? "Close graph" : "Graph"}
        >
          <Network size={18} aria-hidden />
          <span className="sr-only sm:not-sr-only">Graph</span>
        </Link>
        <DatabaseCyclesBadge cycles={cycles} database={currentDatabase} />
        {principal ? (
          <Button className="ml-auto rounded-2xl border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white lg:ml-0" variant="outline" type="button" onClick={onLogout}>
            Logout
          </Button>
        ) : (
          <Button
            className="ml-auto rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60 lg:ml-0"
            data-tid="header-login-button"
            disabled={!authReady}
            type="button"
            onClick={onLogin}
          >
            Login
          </Button>
        )}
      </div>
    </header>
  );
}

function DatabaseCyclesBadge({ cycles, database }: { cycles: ReturnType<typeof databaseCyclesView>; database: DatabaseSummary | null }) {
  const title = database
    ? `${database.name}: ${cycles.label}; ${formatCycles(cycles.balanceCycles)}`
    : "Database cycles unavailable";
  const content = (
    <>
      <Wallet aria-hidden size={15} />
      <span className="hidden text-xs font-semibold sm:inline">{cycles.label}</span>
      <span className="font-mono text-xs">{formatCycles(cycles.balanceCycles)}</span>
    </>
  );
  const className = `hidden h-[38px] shrink-0 items-center gap-2 rounded-lg border px-3 text-sm md:flex ${databaseCyclesToneClass(cycles.state)}`;
  if (!database) {
    return (
      <span className={className} title={title} aria-label={title}>
        {content}
      </span>
    );
  }
  return (
    <Link className={`${className} no-underline`} href={databaseCyclesHref(database)} title={title} aria-label={title}>
      {content}
    </Link>
  );
}

function databaseCyclesToneClass(state: ReturnType<typeof databaseCyclesView>["state"]): string {
  if (state === "active") return "border-infoLine bg-infoSoft text-infoText";
  if (state === "low-balance") return "border-yellow-200 bg-yellow-50 text-yellow-800";
  if (state === "suspended") return "border-red-200 bg-red-50 text-red-700";
  return "border-line bg-white text-muted";
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
      status: "active",
      logicalSizeBytes: "0",
      cyclesBalance: "0",
      cyclesSuspendedAtMs: null,
      archivedAtMs: null,
      deletedAtMs: null
    },
    ...databases
  ];
}

function databaseListWarning(cyclesConfigError: string | null, publicListError: string | null, memberListError: string | null): string | null {
  if (cyclesConfigError) return `Cycles config unavailable: ${cyclesConfigError}`;
  if (publicListError && memberListError) return `Public database list unavailable: ${publicListError}; Member database list unavailable: ${memberListError}`;
  if (publicListError) return `Public database list unavailable: ${publicListError}`;
  if (memberListError) return `Member database list unavailable: ${memberListError}`;
  return null;
}

function emptyDatabaseDirectoryState(requestKey: string): DatabaseDirectoryState {
  return {
    requestKey,
    databases: EMPTY_DATABASE_SUMMARIES,
    memberDatabases: EMPTY_DATABASE_SUMMARIES,
    cyclesConfig: null,
    publicDatabaseIds: EMPTY_PUBLIC_DATABASE_IDS,
    memberDatabasesLoaded: false,
    databaseListError: null
  };
}

export function isPermissionError(message: string | null): boolean {
  return Boolean(message && /access|auth|permission|principal|unauthorized|not allowed|forbidden/i.test(message));
}

function HeaderSearch({
  canisterId,
  databaseId,
  query,
  searchKind,
  canLeaveDirtyEdit
}: {
  canisterId: string;
  databaseId: string;
  query: string;
  searchKind: "path" | "full";
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
    router.replace(hrefForSearch(canisterId, databaseId, text.trim(), kind));
  }

  return (
    <form className="flex min-w-0 flex-1 basis-full items-center gap-1.5 rounded-[20px] border border-line bg-white px-2 py-1.5 text-sm shadow-[0_4px_10px_#14142b0a] sm:basis-[360px] sm:gap-2 lg:max-w-[560px]" onSubmit={submitSearch}>
      <div className="flex shrink-0 rounded-2xl border border-line bg-paper p-1 text-xs">
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
      <Button className="inline-flex shrink-0 items-center justify-center gap-1 rounded-2xl bg-action px-2.5 py-1.5 font-bold text-white hover:-translate-y-[3px] hover:bg-accent sm:px-3" type="submit">
        <Search size={15} aria-hidden />
        <span className="sr-only sm:not-sr-only">Search</span>
      </Button>
    </form>
  );
}

function SearchKindButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`rounded-xl px-2 py-1 ${active ? "bg-white text-accentText shadow-sm" : "text-muted hover:text-accentText"}`}
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
  tab
}: {
  canisterId: string;
  databaseId: string;
  selectedPath: string;
  tab: ModeTab;
}) {
  return (
    <nav className="border-b border-line bg-white px-3 py-2" aria-label="Left sidebar mode">
      <div className="grid grid-cols-3 gap-1 rounded-2xl border border-line bg-paper p-1 text-center text-[11px]">
        {SIDEBAR_TABS.map((value) => (
          <Link
            key={value}
            href={hrefForPath(canisterId, databaseId, selectedPath, undefined, value)}
            className={`rounded-xl px-1.5 py-1.5 no-underline ${tab === value ? "bg-accent text-white" : "text-muted hover:bg-white hover:text-accentText"}`}
          >
            {tabLabel(value)}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function tabTitle(tab: ModeTab): string {
  if (tab === "query") return "Query";
  if (tab === "ingest") return "Ingest";
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

function parseGraphDepth(value: string | null): 1 | 2 {
  return value === "2" ? 2 : 1;
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
  if (segments[0] !== "db" || !segments[1]) {
    return { databaseId: null, nodePath: "/Knowledge" };
  }
  const path = segments
    .slice(2)
    .filter(Boolean)
    .map(decodePathSegment)
    .join("/");
  return {
    databaseId: decodePathSegment(segments[1]),
    nodePath: path ? `/${path}` : "/Knowledge",
  };
}

function isBrowserSearchPathname(canisterId: string, databaseId: string, pathname: string): boolean {
  void canisterId;
  if (!databaseId) return false;
  return pathname === `${databaseRouteBase(databaseId)}/search`;
}

function isBrowserGraphPathname(canisterId: string, databaseId: string, pathname: string): boolean {
  void canisterId;
  if (!databaseId) return false;
  return pathname === `${databaseRouteBase(databaseId)}/graph`;
}

function isBrowserHelpPathname(canisterId: string, databaseId: string, pathname: string): boolean {
  void canisterId;
  if (!databaseId) return false;
  return pathname === `${databaseRouteBase(databaseId)}/help`;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
