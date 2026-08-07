"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import type { FormEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAppPathname, useAppSearchParams } from "@/lib/app-router";
import { GitBranch, PanelRight } from "lucide-react";
import { DocumentHeader, DocumentPane, type DocumentEditState } from "@/components/document-pane";
import { NodePublicationControls } from "@/components/node-publication-controls";
import { LocalImportDialog, type LocalImportDialogState } from "@/components/local-import-dialog";
import { HelpPanel } from "@/components/help-panel";
import { Inspector } from "@/components/inspector";
import { GraphPanel } from "@/components/graph-panel";
import { SearchPanel } from "@/components/search-panel";
import { PanelHeader } from "@/components/panel";
import { WikiNavigationLink, WikiNavigationProvider, useWikiNavigation } from "@/components/wiki-navigation";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import { databaseCyclesDisabledReason } from "@/lib/cycles-state";
import { readBrowserNodeCache } from "@/lib/browser-node-cache";
import { hrefForCanonicalDatabaseRoute, hrefForPath, parentPath, parseWikiRoute } from "@/lib/paths";
import { nodeRequestKey } from "@/lib/request-keys";
import { parseSearchOptions } from "@/lib/search-options";
import { databaseRouteBase } from "@/lib/share-links";
import type { CyclesBillingConfig, ChildNode, DatabaseSummary, NodeContext, WikiNode } from "@/lib/types";
import { getCyclesBillingConfig, listDatabasesAuthenticated, listDatabasesPublic } from "@/lib/vfs-client";
import { buildLocalImportWrites, loadExistingLocalImportNodes, prepareLocalImport, reconcileLocalImport, type LocalImportFile, type LocalImportMode } from "@/lib/local-import";
import { folderIndexPath, isReservedFolderIndexName } from "@/lib/folder-index";
import { wikiSeoTitle } from "@/lib/wiki-seo";
import { DEFAULT_EXPLORER_SORT_ORDER, parseExplorerSortOrder, type ExplorerSortOrder } from "@/lib/child-sort";
import {
  errorHint,
  errorMessage,
  inferNoteRole,
  isDatabaseNotFoundErrorCode,
  isNotFoundError,
  loadingState,
  parseModeTab,
  readIdentityMode as resolveReadIdentityMode,
  ApiError,
  type ModeTab,
  type PathLoadState,
  type ViewMode
} from "@/lib/wiki-helpers";

import { ExplorerActionError, ExplorerCreateForm, ExplorerHeaderActions, ExplorerMoveForm, LeftPane, childPath, createDirectoryForExplorerNode, explorerNodeFromSelection, isDeletableExplorerNode, isMutableExplorerNode, loadedWikiFolders, normalizeMarkdownFileName, normalizePathSegment, sameStringList, wikiChildPath, wikiMarkdownChildPath, writeDisabledReason } from "@/components/wiki-browser/explorer-pane";
import { TopBar, databaseListWarning, mergeDatabaseSummaries, withCurrentDatabase } from "@/components/wiki-browser/top-bar";
const SIDEBAR_TABS: ModeTab[] = ["explorer", "query", "source-capture"];
const EXPLORER_SORT_STORAGE_KEY = "kinicWikiExplorerSortOrder";
const EMPTY_EDIT_STATE: DocumentEditState = { dirty: false, saveState: "idle" };
const EMPTY_DATABASE_SUMMARIES: DatabaseSummary[] = [];
const EMPTY_PUBLIC_DATABASE_IDS: ReadonlySet<string> = new Set<string>();

type BrowserLoadState<T> = PathLoadState<T> & {
  requestKey: string;
};

type DatabaseDirectoryState = {
  requestKey: string;
  databases: DatabaseSummary[];
  memberDatabases: DatabaseSummary[];
  cyclesConfig: CyclesBillingConfig | null;
  publicDatabaseIds: ReadonlySet<string>;
  publicDatabasesLoaded: boolean;
  memberDatabasesLoaded: boolean;
  databaseListError: string | null;
};

export function WikiBrowser() {
  return (
    <WikiNavigationProvider>
      <WikiBrowserContent />
    </WikiNavigationProvider>
  );
}

function WikiBrowserContent() {
  const pathname = useAppPathname();
  const searchParams = useAppSearchParams();
  const { navigate, setDirty } = useWikiNavigation();
  const routeState = useMemo(() => parseWikiRoute(pathname), [pathname]);
  const canisterId = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID ?? "";
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
  const [explorerSortOrder, setExplorerSortOrder] = useState<ExplorerSortOrder>(DEFAULT_EXPLORER_SORT_ORDER);
  const [selectedExplorerState, setSelectedExplorerState] = useState<{ key: string; node: ChildNode } | null>(null);
  const [explorerActionMode, setExplorerActionMode] = useState<"file" | "folder" | "rename" | null>(null);
  const [explorerMoveOpen, setExplorerMoveOpen] = useState(false);
  const [explorerMoveTarget, setExplorerMoveTarget] = useState("/Knowledge");
  const [explorerMoveTargets, setExplorerMoveTargets] = useState<string[]>(["/Knowledge"]);
  const [explorerDraftName, setExplorerDraftName] = useState("");
  const [explorerActionError, setExplorerActionError] = useState<string | null>(null);
  const [explorerBusyAction, setExplorerBusyAction] = useState<"file" | "folder" | "rename" | "move" | "delete" | null>(null);
  const [localImportDialog, setLocalImportDialog] = useState<LocalImportDialogState | null>(null);
  const fileImportInputRef = useRef<HTMLInputElement | null>(null);
  const folderImportInputRef = useRef<HTMLInputElement | null>(null);
  const localImportSequence = useRef(0);
  const localImportAbortController = useRef<AbortController | null>(null);
  const nodeContextCache = useRef(new Map<string, NodeContext>());
  const childNodesCache = useRef(new Map<string, ChildNode[]>());
  const folderIndexNodeCache = useRef(new Map<string, WikiNode | null>());
  const invalidCanister = validateCanisterText(canisterId);
  const canonicalRouteHref = useMemo(() => hrefForCanonicalDatabaseRoute(pathname, searchParams.toString()), [pathname, searchParams]);

  useEffect(() => {
    try {
      setExplorerSortOrder(parseExplorerSortOrder(window.localStorage.getItem(EXPLORER_SORT_STORAGE_KEY)));
    } catch {
      setExplorerSortOrder(DEFAULT_EXPLORER_SORT_ORDER);
    }
  }, []);

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

  const updateExplorerSortOrder = useCallback((order: ExplorerSortOrder) => {
    setExplorerSortOrder(order);
    try {
      window.localStorage.setItem(EXPLORER_SORT_STORAGE_KEY, order);
    } catch {
      // The in-memory preference remains usable when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!canisterId) return;
    const requestKey = databaseDirectoryRequestKey;
    let publicDatabases: DatabaseSummary[] = [];
    let authenticatedDatabases: DatabaseSummary[] = [];
    let nextCyclesConfig: CyclesBillingConfig | null = null;
    let nextPublicDatabasesLoaded = false;
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
        publicDatabasesLoaded: nextPublicDatabasesLoaded,
        memberDatabasesLoaded: nextMemberDatabasesLoaded,
        databaseListError: databaseListWarning(cyclesConfigError, publicListError, memberListError)
      });
    };

    void listDatabasesPublic(canisterId)
      .then((nextPublicDatabases) => {
        if (cancelled) return;
        publicDatabases = nextPublicDatabases;
        publicListError = null;
        nextPublicDatabasesLoaded = true;
        updateDatabaseRows();
      })
      .catch((cause) => {
        if (cancelled) return;
        publicDatabases = [];
        publicListError = errorMessage(cause);
        nextPublicDatabasesLoaded = false;
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
    if (!canonicalRouteHref) return;
    navigate(canonicalRouteHref, { guard: false, replace: true });
  }, [canonicalRouteHref, navigate]);

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
                setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: errorMessage(indexError), code: errorCode(indexError), hint: errorHint(indexError), loading: false });
              }
            }
          } else {
            setChildNodes({ requestKey, path: selectedPath, data: [], error: null, loading: false });
            setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: null, loading: false });
          }
        }
      })
      .catch((nodeError: Error) => {
        if (isDatabaseNotFoundErrorCode(errorCode(nodeError))) {
          if (!cancelled) {
            setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), code: errorCode(nodeError), hint: errorHint(nodeError), loading: false });
            setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), code: errorCode(nodeError), hint: errorHint(nodeError), loading: false });
            setChildNodes({ requestKey, path: selectedPath, data: null, error: null, loading: false });
            setFolderIndexNode({ requestKey: indexRequestKey, path: indexPath, data: null, error: null, loading: false });
          }
          return;
        }
        if (!isNotFoundError(nodeError)) {
          if (!cancelled) {
            setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), code: errorCode(nodeError), hint: errorHint(nodeError), loading: false });
            setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), code: errorCode(nodeError), hint: errorHint(nodeError), loading: false });
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
                setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), code: errorCode(nodeError), hint: errorHint(nodeError), loading: false });
                setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), code: errorCode(nodeError), hint: errorHint(nodeError), loading: false });
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
              setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), code: errorCode(nodeError), hint: errorHint(nodeError), loading: false });
              setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), code: errorCode(nodeError), hint: errorHint(nodeError), loading: false });
              setChildNodes({ requestKey, path: selectedPath, data: null, error: errorMessage(childrenError), code: errorCode(childrenError), hint: errorHint(childrenError), loading: false });
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
  const updateExplorerPublicationState = useCallback((path: string, isPublished: boolean) => {
    let cacheChanged = false;
    for (const [key, children] of childNodesCache.current) {
      let childrenChanged = false;
      const nextChildren = children.map((child) => {
        if (child.path !== path || child.isPublished === isPublished) return child;
        childrenChanged = true;
        return { ...child, isPublished };
      });
      if (childrenChanged) {
        childNodesCache.current.set(key, nextChildren);
        cacheChanged = true;
      }
    }
    setSelectedExplorerState((current) => {
      if (!current || current.node.path !== path || current.node.isPublished === isPublished) {
        return current;
      }
      return { ...current, node: { ...current.node, isPublished } };
    });
    if (cacheChanged) {
      setExplorerRevision((current) => current + 1);
    }
  }, []);

  const currentNode = currentNodeState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, node);
  const currentNodeContext = currentNodeContextState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, nodeContext);
  const currentChildren = currentChildrenState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, childNodes);
  const currentFolderIndexNode = currentNodeState(invalidCanister, canisterId, databaseId, folderIndexPath(selectedPath), folderIndexRequestKey, folderIndexNode);
  const noteRole = inferNoteRole(selectedPath);
  const authPrompt = authPromptMode(readIdentity, currentNode.error || currentChildren.error);
  const activeEditState = view === "edit" ? editState : EMPTY_EDIT_STATE;
  useLayoutEffect(() => {
    setDirty(activeEditState.dirty);
    return () => setDirty(false);
  }, [activeEditState.dirty, setDirty]);
  const canLeaveDirtyEdit = useCallback(() => !activeEditState.dirty || window.confirm("You have unsaved Markdown changes. Leave edit mode?"), [activeEditState.dirty]);
  const guardedLogout = useCallback(() => {
    if (canLeaveDirtyEdit()) {
      void logout();
    }
  }, [canLeaveDirtyEdit, logout]);
  const databaseOptions = useMemo(() => withCurrentDatabase(databases, databaseId), [databaseId, databases]);
  const currentDatabase = useMemo(() => databaseOptions.find((database) => database.databaseId === databaseId) ?? null, [databaseId, databaseOptions]);
  useEffect(() => {
    const databaseTitle = currentDatabase?.metadata.name.trim() || databaseId || "Kinic Wiki";
    const isToolPage = isSearchPage || isGraphPage || isHelpPage;
    const title = isToolPage
      ? `Kinic Wiki: ${databaseTitle}`
      : wikiSeoTitle(databaseTitle, selectedPath, currentFolderIndexNode.data ?? currentNode.data);
    const canonicalHref = isToolPage
      ? databaseRouteBase(databaseId)
      : hrefForPath(canisterId, databaseId, selectedPath);
    updateClientDocumentMetadata(title, canonicalHref);
  }, [canisterId, currentDatabase?.metadata.name, currentFolderIndexNode.data, currentNode.data, databaseId, isGraphPage, isHelpPage, isSearchPage, selectedPath]);
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
  const explorerCreateDisabledReason = explorerCreateDirectory ? null : "Select a database folder or Markdown file first.";
  const explorerMutationTarget = selectedExplorerNode && isMutableExplorerNode(selectedExplorerNode) ? selectedExplorerNode : null;
  const selectedExplorerChildren = selectedExplorerNode?.kind === "folder"
    && currentChildren.path === selectedExplorerNode.path
    ? currentChildren.data ?? undefined
    : undefined;
  const explorerDeleteTarget = explorerMutationTarget && isDeletableExplorerNode(explorerMutationTarget, selectedExplorerChildren) ? explorerMutationTarget : null;

  function openLocalImportPicker(mode: LocalImportMode) {
    if (!canLeaveDirtyEdit() || !explorerCreateDirectory) return;
    setExplorerActionError(null);
    setExplorerActionMode(null);
    setExplorerMoveOpen(false);
    const input = mode === "folder" ? folderImportInputRef.current : fileImportInputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }

  async function prepareSelectedLocalImport(files: LocalImportFile[], mode: LocalImportMode) {
    if (!explorerCreateDirectory || files.length === 0) return;
    localImportAbortController.current?.abort();
    const abortController = new AbortController();
    localImportAbortController.current = abortController;
    const sequence = ++localImportSequence.current;
    const destinationDirectory = explorerCreateDirectory;
    setLocalImportDialog({ phase: "preparing", mode, destinationDirectory });
    try {
      const prepared = await prepareLocalImport(files, destinationDirectory, mode, { signal: abortController.signal });
      const existing = await loadExistingLocalImportNodes(prepared, async (path) => {
        const { listChildren } = await import("@/lib/vfs-client");
        return listChildren(canisterId, databaseId, path, readIdentity ?? undefined);
      }, abortController.signal);
      if (sequence !== localImportSequence.current) return;
      setLocalImportDialog({ phase: "ready", plan: reconcileLocalImport(prepared, existing) });
    } catch (cause) {
      if (sequence !== localImportSequence.current || abortController.signal.aborted || isAbortError(cause)) return;
      setLocalImportDialog({ phase: "error", mode, destinationDirectory, message: errorMessage(cause) });
    } finally {
      if (localImportAbortController.current === abortController) localImportAbortController.current = null;
    }
  }

  function cancelLocalImport() {
    localImportAbortController.current?.abort();
    localImportAbortController.current = null;
    localImportSequence.current += 1;
    setLocalImportDialog(null);
  }

  useEffect(() => {
    localImportAbortController.current?.abort();
    localImportAbortController.current = null;
    localImportSequence.current += 1;
    setLocalImportDialog(null);
  }, [canisterId, databaseId]);

  useEffect(() => () => {
    localImportAbortController.current?.abort();
  }, []);

  async function runLocalImport(replacements: Set<string>) {
    if (!localImportDialog || localImportDialog.phase !== "ready") return;
    const plan = localImportDialog.plan;
    const selectedReplacements = new Set(replacements);
    try {
      if (!readIdentity) throw new Error("Login with Internet Identity to import local content.");
      if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
      if (currentDatabaseCycleReason) throw new Error(currentDatabaseCycleReason);
      const nodes = buildLocalImportWrites(plan, selectedReplacements);
      if (plan.limitError || nodes.length === 0) return;
      setLocalImportDialog({ phase: "writing", plan });
      const { writeNodesAuthenticated } = await import("@/lib/vfs-client");
      const results = await writeNodesAuthenticated(canisterId, readIdentity, { databaseId, nodes });
      const created = results.filter((result) => result.created).length;
      const replaced = results.length - created;
      const skipped = plan.excluded.length
        + plan.entries.filter((entry) => entry.status === "blocked").length
        + plan.entries.filter((entry) => entry.status === "conflict" && !selectedReplacements.has(entry.path)).length;
      invalidateBrowserCaches();
      setLocalImportDialog(null);
      toast.success(`Imported ${created} new, replaced ${replaced}, skipped ${skipped}.`);
      navigate(hrefForPath(canisterId, databaseId, plan.navigationPath, undefined, tab), { guard: false, replace: true });
    } catch (cause) {
      setLocalImportDialog({ phase: "ready", plan });
      toast.error(errorMessage(cause));
    }
  }
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
        current.node.isVirtual === nextNode.isVirtual &&
        current.node.isPublished === nextNode.isPublished
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
    navigate(hrefForPath(canisterId, databaseId, nextPath, "edit", tab), { guard: false, replace: true });
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, navigate, readIdentity, setEditState, tab]);
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
    navigate(hrefForPath(canisterId, databaseId, nextPath, undefined, tab), { guard: false, replace: true });
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, navigate, readIdentity, setEditState, tab]);
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
    navigate(hrefForPath(canisterId, databaseId, nextPath, target.kind === "file" ? view : undefined, tab), { guard: false, replace: true });
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, navigate, readIdentity, setEditState, tab, view]);
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
    navigate(hrefForPath(canisterId, databaseId, nextPath, target.kind === "file" ? view : undefined, tab), { guard: false, replace: true });
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, navigate, readIdentity, setEditState, tab, view]);
  const deleteExplorerNode = useCallback(async (target: ChildNode) => {
    if (!canLeaveDirtyEdit()) return false;
    if (!readIdentity) throw new Error("Login with Internet Identity to delete nodes.");
    if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") throw new Error("Writer or owner access required.");
    if (currentDatabaseCycleReason) throw new Error(currentDatabaseCycleReason);
    const targetChildren = target.kind === "folder"
      ? childNodesCache.current.get(nodeRequestKey(canisterId, databaseId, target.path, readPrincipal))
      : undefined;
    if (!isDeletableExplorerNode(target, targetChildren)) throw new Error("Only Markdown files, source nodes, and folders without visible children can be deleted.");
    if (!target.etag) throw new Error("Cannot delete a node without an etag.");
    if (!window.confirm(`Delete ${target.path}?`)) return false;
    const { deleteNodeAuthenticated, readNode } = await import("@/lib/vfs-client");
    let indexNode: WikiNode | null = null;
    if (target.kind === "folder") {
      try {
        indexNode = await readNode(canisterId, databaseId, folderIndexPath(target.path), readIdentity);
      } catch (cause) {
        if (!isNotFoundError(cause)) throw cause;
      }
    }
    await deleteNodeAuthenticated(canisterId, readIdentity, {
      databaseId,
      path: target.path,
      expectedEtag: target.etag,
      expectedFolderIndexEtag: indexNode?.etag ?? null
    });
    invalidateBrowserCaches();
    setEditState(EMPTY_EDIT_STATE);
    if (selectedPath === target.path) {
      navigate(hrefForPath(canisterId, databaseId, parentPath(target.path) ?? "/Knowledge", undefined, tab), { guard: false, replace: true });
    }
    return true;
  }, [canLeaveDirtyEdit, canisterId, currentDatabaseCycleReason, currentDatabaseRole, databaseId, invalidateBrowserCaches, navigate, readIdentity, readPrincipal, selectedPath, setEditState, tab]);

  async function submitExplorerCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExplorerActionError(null);
    if (!explorerActionMode) return;
    if (explorerActionMode !== "rename" && !explorerCreateDirectory) {
      setExplorerActionError("Select a database folder or Markdown file first.");
      return;
    }
    const normalizedName = explorerActionMode === "folder" || (explorerActionMode === "rename" && explorerMutationTarget?.kind === "folder")
      ? normalizePathSegment(explorerDraftName)
      : normalizeMarkdownFileName(explorerDraftName);
    if (!normalizedName) {
      setExplorerActionError(explorerActionMode === "folder" ? "Enter a folder name, not a path." : "Enter a Markdown file name, not a path.");
      return;
    }
    setExplorerBusyAction(explorerActionMode);
    try {
      let created = false;
      if (explorerActionMode === "rename" && explorerMutationTarget) {
        created = await renameExplorerNode(explorerMutationTarget, normalizedName);
      } else if (explorerCreateDirectory) {
        created = explorerActionMode === "folder"
          ? await createFolderNode(explorerCreateDirectory, normalizedName)
          : await createMarkdownFile(explorerCreateDirectory, normalizedName);
      }
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
        currentDatabaseName={currentDatabase?.metadata.name ?? ""}
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
                sortOrder={explorerSortOrder}
                fileDisabled={Boolean(explorerWriteDisabledReason ?? explorerCreateDisabledReason) || explorerBusyAction !== null}
                folderDisabled={Boolean(explorerWriteDisabledReason ?? explorerCreateDisabledReason) || explorerBusyAction !== null}
                renameDisabled={Boolean(explorerWriteDisabledReason) || explorerBusyAction !== null || !explorerMutationTarget}
                moveDisabled={Boolean(explorerWriteDisabledReason) || explorerBusyAction !== null || !explorerMutationTarget || explorerMoveTargets.length === 0}
                deleteDisabled={Boolean(explorerWriteDisabledReason) || explorerBusyAction !== null || !explorerDeleteTarget}
                importDisabled={Boolean(explorerWriteDisabledReason ?? explorerCreateDisabledReason) || explorerBusyAction !== null || localImportDialog !== null}
                fileTitle={explorerWriteDisabledReason ?? explorerCreateDisabledReason ?? `New file in ${explorerCreateDirectory}`}
                folderTitle={explorerWriteDisabledReason ?? explorerCreateDisabledReason ?? `New folder in ${explorerCreateDirectory}`}
                renameTitle={explorerWriteDisabledReason ?? (explorerMutationTarget ? `Rename ${explorerMutationTarget.path}` : "Select a Markdown file or folder to rename")}
                moveTitle={explorerWriteDisabledReason ?? (explorerMutationTarget ? `Move ${explorerMutationTarget.path}` : "Select a Markdown file or folder to move")}
                deleteTitle={explorerWriteDisabledReason ?? (explorerDeleteTarget ? `Delete ${explorerDeleteTarget.path}` : "Select a Markdown file, source node, or folder without visible children to delete")}
                importFilesTitle={explorerWriteDisabledReason ?? explorerCreateDisabledReason ?? `Import files into ${explorerCreateDirectory}`}
                importFolderTitle={explorerWriteDisabledReason ?? explorerCreateDisabledReason ?? `Import folder into ${explorerCreateDirectory}`}
                onSortOrderChange={updateExplorerSortOrder}
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
                onImportFiles={() => openLocalImportPicker("files")}
                onImportFolder={() => openLocalImportPicker("folder")}
              />
            ) : undefined}
          />
          <ModeTabs canisterId={canisterId} databaseId={databaseId} selectedPath={selectedPath} tab={tab} />
          {tab === "explorer" && explorerActionMode ? (
            <ExplorerCreateForm
              mode={explorerActionMode}
              directoryPath={explorerCreateDirectory ?? ""}
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
            explorerSortOrder={explorerSortOrder}
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
                actions={currentNode.data?.kind === "file" && currentNode.data.path.endsWith(".md") ? (
                  <NodePublicationControls
                    canisterId={canisterId}
                    databaseId={databaseId}
                    path={currentNode.data.path}
                    role={currentDatabaseRole}
                    identity={readIdentity}
                    onPublicationStateChange={updateExplorerPublicationState}
                  />
                ) : undefined}
                onViewChange={(nextView) => {
                  if (nextView !== "edit" && !canLeaveDirtyEdit()) {
                    return;
                  }
                  navigate(hrefForPath(canisterId, databaseId, selectedPath, nextView, tab), { guard: false, replace: true });
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
              databaseTitle={currentDatabase?.metadata.name ?? ""}
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
              databaseTitle={currentDatabase?.metadata.name ?? ""}
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
      <input
        ref={fileImportInputRef}
        accept=".md,.pdf,text/markdown,application/pdf"
        className="hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []) as LocalImportFile[];
          event.currentTarget.value = "";
          void prepareSelectedLocalImport(files, "files");
        }}
      />
      <input
        ref={(node) => {
          folderImportInputRef.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        className="hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []) as LocalImportFile[];
          event.currentTarget.value = "";
          void prepareSelectedLocalImport(files, "folder");
        }}
      />
      {localImportDialog ? (
        <LocalImportDialog state={localImportDialog} onCancel={cancelLocalImport} onImport={(replacements) => void runLocalImport(replacements)} />
      ) : null}
    </main>
  );
}

function emptyDatabaseDirectoryState(requestKey: string): DatabaseDirectoryState {
  return {
    requestKey,
    databases: EMPTY_DATABASE_SUMMARIES,
    memberDatabases: EMPTY_DATABASE_SUMMARIES,
    cyclesConfig: null,
    publicDatabaseIds: EMPTY_PUBLIC_DATABASE_IDS,
    publicDatabasesLoaded: false,
    memberDatabasesLoaded: false,
    databaseListError: null
  };
}

export function isPermissionError(message: string | null): boolean {
  return Boolean(message && /access|auth|permission|principal|unauthorized|not allowed|forbidden/i.test(message));
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
          <WikiNavigationLink
            key={value}
            href={hrefForPath(canisterId, databaseId, selectedPath, undefined, value)}
            className={`rounded-xl px-1.5 py-1.5 no-underline ${tab === value ? "bg-accent text-white" : "text-muted hover:bg-white hover:text-accentText"}`}
          >
            {tabLabel(value)}
          </WikiNavigationLink>
        ))}
      </div>
    </nav>
  );
}

function tabTitle(tab: ModeTab): string {
  if (tab === "query") return "Query";
  if (tab === "source-capture") return "Source Capture";
  return "Explorer";
}

function tabLabel(tab: ModeTab): string {
  if (tab === "query") return "query";
  if (tab === "source-capture") return "capture";
  return tab;
}

function updateClientDocumentMetadata(title: string, canonicalHref: string): void {
  document.title = title;
  const canonicalUrl = new URL(canonicalHref, window.location.origin).href;
  const canonicals = document.querySelectorAll<HTMLLinkElement>('link[rel="canonical"]');
  if (canonicals.length === 0) {
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = canonicalUrl;
    document.head.append(canonical);
    return;
  }
  canonicals.forEach((canonical) => {
    canonical.href = canonicalUrl;
  });
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
  return value === "path" ? "path" : "full";
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

function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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
    return "VITE_KINIC_WIKI_CANISTER_ID is not configured";
  }
  if (!/^[a-z0-9-]+$/i.test(canisterId)) {
    return "VITE_KINIC_WIKI_CANISTER_ID contains unsupported characters";
  }
  return null;
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
