"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { GitBranch, LayoutDashboard, Network, PanelRight, Search } from "lucide-react";
import { CycleBattery } from "@/components/cycle-battery";
import { DocumentHeader, DocumentPane } from "@/components/document-pane";
import { ExplorerTree } from "@/components/explorer-tree";
import { Inspector } from "@/components/inspector";
import { IngestPanel } from "@/components/ingest-panel";
import { PanelHeader } from "@/components/panel";
import { RecentPanel } from "@/components/recent-panel";
import { SourcesPanel } from "@/components/sources-panel";
import { DELEGATION_TTL_NS, identityProviderUrl } from "@/lib/auth";
import { readBrowserNodeCache } from "@/lib/browser-node-cache";
import { hrefForDatabaseSwitch, hrefForGraph, hrefForPath, hrefForSearch } from "@/lib/paths";
import { nodeRequestKey } from "@/lib/request-keys";
import type { ChildNode, DatabaseSummary, NodeContext, WikiNode } from "@/lib/types";
import { listDatabasesAuthenticated, listDatabasesPublic } from "@/lib/vfs-client";
import {
  errorHint,
  errorMessage,
  inferNoteRole,
  isNotFoundError,
  loadingState,
  ApiError,
  type ModeTab,
  type PathLoadState,
  type ViewMode
} from "@/lib/wiki-helpers";

const SIDEBAR_TABS: ModeTab[] = ["explorer", "recent", "ingest", "sources"];
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
  const effectiveReadIdentity = readMode === "anonymous" ? null : readIdentity;
  const authPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const readPrincipal = effectiveReadIdentity?.getPrincipal().toText() ?? null;
  const currentRequestKey = nodeRequestKey(canisterId, databaseId, selectedPath, readPrincipal);
  const [node, setNode] = useState<BrowserLoadState<WikiNode>>(browserLoadingState(canisterId, databaseId, selectedPath));
  const [nodeContext, setNodeContext] = useState<BrowserLoadState<NodeContext>>(browserLoadingState(canisterId, databaseId, selectedPath));
  const [childNodes, setChildNodes] = useState<BrowserLoadState<ChildNode[]>>(browserLoadingState(canisterId, databaseId, selectedPath));
  const nodeContextCache = useRef(new Map<string, NodeContext>());
  const childNodesCache = useRef(new Map<string, ChildNode[]>());
  const invalidCanister = validateCanisterText(canisterId);

  useEffect(() => {
    let cancelled = false;
    AuthClient.create()
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
    if (typeof invalidCanister === "string") {
      return;
    }
    if (isGraphPage && !graphCenter) {
      return;
    }
    const requestKey = nodeRequestKey(canisterId, databaseId, selectedPath, readPrincipal);
    const cached = readBrowserNodeCache(nodeContextCache.current, childNodesCache.current, requestKey);
    if (cached) {
      if (cached.kind === "node") {
        setNode({ requestKey, path: selectedPath, data: cached.context.node, error: null, loading: false });
        setNodeContext({ requestKey, path: selectedPath, data: cached.context, error: null, loading: false });
        setChildNodes({ requestKey, path: selectedPath, data: [], error: null, loading: false });
      } else {
        setNode({ requestKey, path: selectedPath, data: null, error: null, loading: false });
        setNodeContext({ requestKey, path: selectedPath, data: null, error: null, loading: false });
        setChildNodes({ requestKey, path: selectedPath, data: cached.children, error: null, loading: false });
      }
      return;
    }
    import("@/lib/vfs-client")
      .then(({ readNodeContext }) => readNodeContext(canisterId, databaseId, selectedPath, 20, effectiveReadIdentity ?? undefined))
      .then((data) => {
        if (!cancelled) {
          if (!data) {
            throw new ApiError(`node not found: ${selectedPath}`, 404);
          }
          nodeContextCache.current.set(requestKey, data);
          setNode({ requestKey, path: selectedPath, data: data.node, error: null, loading: false });
          setNodeContext({ requestKey, path: selectedPath, data, error: null, loading: false });
          setChildNodes({ requestKey, path: selectedPath, data: [], error: null, loading: false });
        }
      })
      .catch((nodeError: Error) => {
        if (!isNotFoundError(nodeError)) {
          if (!cancelled) {
            setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
            setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
            setChildNodes({ requestKey, path: selectedPath, data: null, error: null, loading: false });
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
              } else {
                setNode({ requestKey, path: selectedPath, data: null, error: null, loading: false });
                setNodeContext({ requestKey, path: selectedPath, data: null, error: null, loading: false });
                childNodesCache.current.set(requestKey, data);
                setChildNodes({ requestKey, path: selectedPath, data, error: null, loading: false });
              }
            }
          })
          .catch((childrenError: Error) => {
            if (!cancelled) {
              setNode({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
              setNodeContext({ requestKey, path: selectedPath, data: null, error: errorMessage(nodeError), hint: errorHint(nodeError), loading: false });
              setChildNodes({ requestKey, path: selectedPath, data: null, error: errorMessage(childrenError), hint: errorHint(childrenError), loading: false });
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
      identityProvider: identityProviderUrl(),
      maxTimeToLive: DELEGATION_TTL_NS,
      onSuccess: () => {
        setReadIdentity(authClient.getIdentity());
      },
      onError: (cause) => {
        setAuthError(errorMessage(cause));
      }
    });
  }

  async function logout() {
    if (!authClient) return;
    await authClient.logout();
    setReadIdentity(null);
    setAuthError(null);
  }

  const currentNode = currentNodeState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, node);
  const currentNodeContext = currentNodeContextState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, nodeContext);
  const currentChildren = currentChildrenState(invalidCanister, canisterId, databaseId, selectedPath, currentRequestKey, childNodes);
  const noteRole = inferNoteRole(selectedPath);
  const authPrompt = authPromptMode(tab, readIdentity, currentNode.error || currentChildren.error);

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
    <main className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
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
        readIdentity={readIdentity}
        selectedPath={selectedPath}
        authReady={Boolean(authClient)}
        onLogin={login}
        onLogout={logout}
      />
      <section className={`grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 ${isSearchPage || isGraphPage ? "lg:grid-cols-[320px_minmax(0,1fr)]" : "lg:grid-cols-[320px_minmax(0,1fr)_320px]"}`}>
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-paper/90 shadow-sm">
          <PanelHeader icon={<GitBranch size={15} />} title={tabTitle(tab)} />
          <ModeTabs canisterId={canisterId} databaseId={databaseId} selectedPath={selectedPath} tab={tab} readMode={readMode} />
          <LeftPane
            tab={tab}
            canisterId={canisterId}
            databaseId={databaseId}
            selectedPath={selectedPath}
            node={currentNode.data}
            childNodesCache={childNodesCache}
            autoExpandExplorer={!(isGraphPage && !graphCenter)}
            readIdentity={readIdentity}
            effectiveReadIdentity={effectiveReadIdentity}
            readMode={readMode}
          />
        </aside>
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
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
                onViewChange={(nextView) => {
                  router.replace(hrefForPath(canisterId, databaseId, selectedPath, nextView, tab, undefined, undefined, readMode));
                }}
                isDirectory={!currentNode.data && Boolean(currentChildren.data)}
              />
              <DocumentPane
                node={currentNode}
                childrenState={currentChildren}
                view={view}
                canisterId={canisterId}
                databaseId={databaseId}
                authPrompt={authPrompt}
                onLogin={login}
                authReady={Boolean(authClient)}
                readMode={readMode}
              />
            </>
          )}
        </section>
        {!isSearchPage && !isGraphPage ? (
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-paper/90 shadow-sm">
            <PanelHeader icon={<PanelRight size={15} />} title="Inspector" subtitle="metadata and hints" />
            <Inspector
              canisterId={canisterId}
              databaseId={databaseId}
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
  node,
  childNodesCache,
  autoExpandExplorer,
  readIdentity,
  effectiveReadIdentity,
  readMode
}: {
  tab: ModeTab;
  canisterId: string;
  databaseId: string;
  selectedPath: string;
  node: WikiNode | null;
  childNodesCache: { current: Map<string, ChildNode[]> };
  autoExpandExplorer: boolean;
  readIdentity: Identity | null;
  effectiveReadIdentity: Identity | null;
  readMode: "anonymous" | null;
}) {
  if (tab === "recent") return <RecentPanel canisterId={canisterId} databaseId={databaseId} readIdentity={effectiveReadIdentity} readMode={readMode} />;
  if (tab === "ingest") return <IngestPanel canisterId={canisterId} databaseId={databaseId} readIdentity={readIdentity} />;
  if (tab === "sources") return <SourcesPanel canisterId={canisterId} databaseId={databaseId} readIdentity={effectiveReadIdentity} writeIdentity={readIdentity} readMode={readMode} />;
  return <ExplorerTree canisterId={canisterId} databaseId={databaseId} selectedPath={selectedPath} autoExpandSelected={autoExpandExplorer} readIdentity={effectiveReadIdentity} readMode={readMode} childNodesCache={childNodesCache} />;
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
  readIdentity,
  selectedPath,
  authReady,
  onLogin,
  onLogout
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
  readIdentity: Identity | null;
  selectedPath: string;
  authReady: boolean;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const router = useRouter();
  const graphLinkCenter = isGraphPage ? graphCenter : selectedPath;
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  const [databaseListError, setDatabaseListError] = useState<string | null>(null);
  const readPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const visibleError = authError ?? databaseListError;
  const databaseOptions = useMemo(() => withCurrentDatabase(databases, databaseId), [databaseId, databases]);

  useEffect(() => {
    let cancelled = false;
    if (!canisterId) return;
    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
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
          setDatabaseListError(`${errorMessage(publicResult.reason)}; ${errorMessage(memberResult.reason)}`);
          return;
        }
        const publicDatabases = publicResult.status === "fulfilled" ? publicResult.value : [];
        const memberDatabases = memberResult.status === "fulfilled" ? memberResult.value : [];
        setDatabases(mergeDatabaseSummaries(memberDatabases, publicDatabases));
        setDatabaseListError(databaseListWarning(publicResult, memberResult));
      })
      .catch((cause) => {
        if (!cancelled) setDatabaseListError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, readIdentity, readPrincipal]);

  function switchDatabase(event: ChangeEvent<HTMLSelectElement>) {
    const nextDatabaseId = event.target.value;
    if (!nextDatabaseId || nextDatabaseId === databaseId) return;
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
    <header className="flex min-h-[52px] flex-wrap items-center gap-2 border-b border-line bg-paper/80 px-3 py-2 backdrop-blur sm:flex-nowrap sm:gap-4">
      <div className="w-[168px] shrink-0">
        <Link className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm font-semibold leading-tight text-ink no-underline hover:border-accent" href="/" aria-label="Back to database dashboard">
          <LayoutDashboard size={15} />
          Knowledge IDE
        </Link>
      </div>
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
              {database.displayName || database.databaseId}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-[280px] flex-1 basis-full items-center justify-end gap-2 sm:basis-auto">
        {visibleError ? <span className="hidden max-w-[220px] truncate text-xs text-red-700 md:inline">{visibleError}</span> : null}
        {principal ? (
          <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" type="button" onClick={onLogout}>
            Logout
          </button>
        ) : (
          <button
            className="rounded-lg border border-accent bg-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            data-tid="header-login-button"
            disabled={!authReady}
            type="button"
            onClick={onLogin}
          >
            Login
          </button>
        )}
        <Link
          className={`hidden items-center gap-1 rounded-lg border border-line px-3 py-2 text-sm no-underline md:flex ${isGraphPage ? "bg-accent text-white" : "bg-white text-ink"}`}
          href={hrefForGraph(canisterId, databaseId, graphLinkCenter, undefined, readMode)}
        >
          <Network size={15} />
          Graph
        </Link>
        <CycleBattery canisterId={canisterId} />
        <HeaderSearch canisterId={canisterId} databaseId={databaseId} query={query} searchKind={searchKind} readMode={readMode} />
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
      displayName: databaseId,
      role: "reader",
      status: "hot",
      logicalSizeBytes: "0",
      billingBalanceE8s: "0",
      billingSuspendedAtMs: null,
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
  readMode
}: {
  canisterId: string;
  databaseId: string;
  query: string;
  searchKind: "path" | "full";
  readMode: "anonymous" | null;
}) {
  const router = useRouter();
  const draftKey = `${query}\n${searchKind}`;
  const [draft, setDraft] = useState({ key: draftKey, text: query, kind: searchKind });
  const text = draft.key === draftKey ? draft.text : query;
  const kind = draft.key === draftKey ? draft.kind : searchKind;

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    router.replace(hrefForSearch(canisterId, databaseId, text.trim(), kind, readMode));
  }

  return (
    <form className="ml-auto flex w-full max-w-[720px] items-center gap-2 rounded-xl border border-line bg-white px-2 py-1.5 text-sm" onSubmit={submitSearch}>
      <div className="flex shrink-0 rounded-lg border border-line bg-paper p-1 text-xs">
        <SearchKindButton active={kind === "path"} label="Path" onClick={() => setDraft({ key: draftKey, text, kind: "path" })} />
        <SearchKindButton active={kind === "full"} label="Full text" onClick={() => setDraft({ key: draftKey, text, kind: "full" })} />
      </div>
      <Search size={15} className="shrink-0 text-muted" />
      <input
        className="min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-muted"
        value={text}
        onChange={(event) => setDraft({ key: draftKey, text: event.target.value, kind })}
        placeholder="Search wiki"
        aria-label="Search wiki"
      />
      <button className="rounded-lg bg-accent px-3 py-1.5 text-white" type="submit">
        Search
      </button>
    </form>
  );
}

function SearchKindButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`rounded-md px-2 py-1 ${active ? "bg-white text-accent shadow-sm" : "text-muted"}`}
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
            className={`rounded-lg px-1.5 py-1.5 no-underline ${tab === value ? "bg-accent text-white" : "text-muted hover:bg-paper"}`}
          >
            {value}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function tabTitle(tab: ModeTab): string {
  if (tab === "recent") return "Recent";
  if (tab === "ingest") return "Ingest";
  if (tab === "sources") return "Sources";
  return "Explorer";
}

function authPromptMode(tab: ModeTab, readIdentity: Identity | null, loadError: string | null): "private" | "write" | null {
  if (readIdentity) return null;
  if (tab === "ingest" || tab === "sources") return "write";
  return isPermissionError(loadError) ? "private" : null;
}

function parseTab(value: string | null): ModeTab {
  if (value === "recent" || value === "ingest" || value === "sources" || value === "explorer") {
    return value;
  }
  return "explorer";
}

function parseView(value: string | null): ViewMode {
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
