"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, FilePlus, FolderPlus, GitBranch, Menu, MoveRight, Network, PanelRight, Pencil, Search, Settings, Share2, Trash2, Wallet, X } from "lucide-react";
import { DocumentHeader, DocumentPane, type DocumentEditState } from "@/components/document-pane";
import { ExplorerTree } from "@/components/explorer-tree";
import { HelpPanel } from "@/components/help-panel";
import { Inspector } from "@/components/inspector";
import { SourceCapturePanel } from "@/components/source-capture-panel";
import { QueryPanel } from "@/components/query-panel";
import { PanelHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import { databaseCyclesDisabledReason, databaseCyclesHref, databaseCyclesView, formatCycles } from "@/lib/cycles-state";
import { readBrowserNodeCache } from "@/lib/browser-node-cache";
import { hrefForCanonicalDatabaseRoute, hrefForDatabaseSwitch, hrefForGraph, hrefForHelp, hrefForPath, hrefForSearch, parentPath, parseWikiRoute } from "@/lib/paths";
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
  isDatabaseNotFoundErrorCode,
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


const HEADER_ICON_LINK_CLASS = "inline-flex h-9 items-center justify-center gap-1 rounded-lg border px-3 text-sm no-underline";

export function TopBar({
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
                {database.metadata.name}
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
            href={xShareDatabaseHref({ databaseId, databaseTitle: currentDatabaseName })}
            rel="noreferrer"
            target="_blank"
            title="Share on X"
          >
            <Share2 aria-hidden size={18} />
            <span className="hidden sm:inline">Share</span>
          </a>
        ) : null}
        <button
          className={`${HEADER_ICON_LINK_CLASS} rounded-2xl lg:hidden ${mobileSidebarOpen ? "border-accent bg-accent text-white" : "border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white"}`}
          type="button"
          data-tid="mobile-sidebar-toggle"
          aria-expanded={mobileSidebarOpen}
          aria-controls="wiki-mobile-sidebar"
          aria-label="Toggle workspace panel"
          title="Workspace panel"
          onClick={onMobileSidebarToggle}
        >
          <Menu size={18} aria-hidden />
          <span className="sr-only sm:not-sr-only">Panel</span>
        </button>
        <Link
          className={`${HEADER_ICON_LINK_CLASS} rounded-2xl lg:hidden ${isGraphPage ? "border-accent bg-accent text-white" : "border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white"}`}
          href={graphHref}
          aria-label="Graph"
          title={isGraphPage ? "Close graph" : "Graph"}
        >
          <Network size={18} aria-hidden />
          <span className="sr-only sm:not-sr-only">Graph</span>
        </Link>
        <Link
          className={`${HEADER_ICON_LINK_CLASS} rounded-2xl border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white`}
          data-tid="header-manage-link"
          href={`/dashboard/project/${encodeURIComponent(databaseId)}`}
          aria-label="Manage database settings"
          title="Manage database settings"
        >
          <Settings aria-hidden size={18} />
          <span className="sr-only sm:not-sr-only">Manage</span>
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
    ? `${database.metadata.name}: ${cycles.label}; ${formatCycles(cycles.balanceCycles)}`
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

export function mergeDatabaseSummaries(memberDatabases: DatabaseSummary[], publicDatabases: DatabaseSummary[]): DatabaseSummary[] {
  const rows = new Map<string, DatabaseSummary>();
  for (const database of publicDatabases) {
    rows.set(database.databaseId, database);
  }
  for (const database of memberDatabases) {
    rows.set(database.databaseId, database);
  }
  return [...rows.values()].sort((left, right) => left.databaseId.localeCompare(right.databaseId));
}

export function withCurrentDatabase(databases: DatabaseSummary[], databaseId: string): DatabaseSummary[] {
  if (!databaseId || databases.some((database) => database.databaseId === databaseId)) {
    return databases;
  }
  return [
    {
      databaseId,
      name: databaseId,
      metadata: {
        name: databaseId,
        description: "",
        llmSummary: null,
        tagsJson: "[]"
      },
      role: "reader",
      status: "active",
      logicalSizeBytes: "0",
      cyclesBalance: "0",
      cyclesSuspendedAtMs: null,
      deletedAtMs: null
    },
    ...databases
  ];
}

export function databaseListWarning(cyclesConfigError: string | null, publicListError: string | null, memberListError: string | null): string | null {
  if (cyclesConfigError) return `Cycles config unavailable: ${cyclesConfigError}`;
  if (publicListError && memberListError) return `Public database list unavailable: ${publicListError}; Member database list unavailable: ${memberListError}`;
  if (publicListError) return `Public database list unavailable: ${publicListError}`;
  if (memberListError) return `Member database list unavailable: ${memberListError}`;
  return null;
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
