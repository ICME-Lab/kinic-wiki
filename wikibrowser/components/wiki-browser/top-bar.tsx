"use client";

import type { ChangeEvent, FormEvent } from "react";
import { useState } from "react";
import { Menu, Network, Search, Settings, Share2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WikiNavigationLink, useWikiNavigation } from "@/components/wiki-navigation";
import { databaseCyclesHref, databaseCyclesView, formatCycles } from "@/lib/cycles-state";
import { hrefForDatabaseSwitch, hrefForGraph, hrefForPath, hrefForSearch } from "@/lib/paths";
import { type SearchOptions } from "@/lib/search-options";
import { xShareDatabaseHref } from "@/lib/share-links";
import type { CyclesBillingConfig, DatabaseSummary } from "@/lib/types";


const HEADER_ICON_LINK_CLASS = "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-xl border px-2.5 text-sm font-medium no-underline transition-colors";

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
  const { navigate } = useWikiNavigation();
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
    navigate(
      hrefForDatabaseSwitch(canisterId, nextDatabaseId, {
        isSearchPage,
        isGraphPage,
        isHelpPage,
        query,
        searchKind,
        searchOptions,
        graphDepth
      }),
      { guard: false, replace: true }
    );
  }

  return (
    <header className="chrome-material sticky top-0 z-30 grid min-h-[56px] grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-line px-3 py-2 lg:grid-cols-[auto_minmax(280px,720px)_auto] lg:items-center lg:gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <WikiNavigationLink
          className="inline-flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-semibold leading-tight text-ink no-underline transition-colors hover:bg-paper"
          href="/dashboard"
          aria-label="Back to database dashboard"
        >
          <img className="h-6 w-6 rounded-md" src="/kinic-mark.png" alt="" width={24} height={24} />
          Kinic Wiki
        </WikiNavigationLink>
        <div className="flex min-w-0 shrink-0 items-center gap-1 text-xs text-muted">
          <label className="hidden font-mono sm:inline" htmlFor="database-switcher">
            db:
          </label>
          <select
            id="database-switcher"
            className="h-9 w-[132px] rounded-xl border border-line bg-white px-2.5 text-sm font-medium text-ink outline-none focus:border-midLine sm:w-[180px]"
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
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:justify-end lg:flex-nowrap">
        {visibleError ? <span className="hidden max-w-[220px] truncate text-xs text-red-700 md:inline">{visibleError}</span> : null}
        {publicReadable ? (
          <a
            aria-label={`Share ${currentDatabaseName} on X`}
            className={`${HEADER_ICON_LINK_CLASS} rounded-2xl border-transparent bg-transparent text-muted hover:bg-paper hover:text-ink`}
            href={xShareDatabaseHref({ databaseId, databaseTitle: currentDatabaseName })}
            rel="noreferrer"
            target="_blank"
            title="Share on X"
          >
            <Share2 aria-hidden size={18} />
            <span className="sr-only xl:not-sr-only">Share</span>
          </a>
        ) : null}
        <button
          className={`${HEADER_ICON_LINK_CLASS} rounded-2xl lg:hidden ${mobileSidebarOpen ? "border-transparent bg-paper text-ink" : "border-transparent bg-transparent text-muted hover:bg-paper hover:text-ink"}`}
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
        <WikiNavigationLink
          className={`${HEADER_ICON_LINK_CLASS} rounded-2xl lg:hidden ${isGraphPage ? "border-transparent bg-paper text-ink" : "border-transparent bg-transparent text-muted hover:bg-paper hover:text-ink"}`}
          href={graphHref}
          aria-label="Graph"
          title={isGraphPage ? "Close graph" : "Graph"}
        >
          <Network size={18} aria-hidden />
          <span className="sr-only sm:not-sr-only">Graph</span>
        </WikiNavigationLink>
        <WikiNavigationLink
          className={`${HEADER_ICON_LINK_CLASS} rounded-2xl border-transparent bg-transparent text-muted hover:bg-paper hover:text-ink`}
          data-tid="header-manage-link"
          href={`/dashboard/project/${encodeURIComponent(databaseId)}`}
          aria-label="Manage database settings"
          title="Manage database settings"
        >
          <Settings aria-hidden size={18} />
          <span className="sr-only xl:not-sr-only">Manage</span>
        </WikiNavigationLink>
        <DatabaseCyclesBadge cycles={cycles} database={currentDatabase} />
        {principal ? (
          <Button className="ml-auto rounded-2xl border-transparent bg-transparent text-muted hover:bg-paper hover:text-ink lg:ml-0" variant="outline" type="button" onClick={onLogout}>
            Logout
          </Button>
        ) : (
          <Button
            className="ml-auto h-9 rounded-xl border border-action bg-action px-3.5 text-sm font-semibold text-onAction hover:border-actionHover hover:bg-actionHover disabled:cursor-not-allowed disabled:opacity-60 lg:ml-1"
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
      <span className="hidden text-xs font-semibold 2xl:inline">{cycles.label}</span>
      <span className="font-mono text-xs">{formatCycles(cycles.balanceCycles)}</span>
    </>
  );
  const className = `hidden h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm md:flex ${databaseCyclesToneClass(cycles.state)}`;
  if (!database) {
    return (
      <span className={className} title={title} aria-label={title}>
        {content}
      </span>
    );
  }
  return (
    <WikiNavigationLink className={`${className} no-underline`} href={databaseCyclesHref(database)} title={title} aria-label={title}>
      {content}
    </WikiNavigationLink>
  );
}

function databaseCyclesToneClass(state: ReturnType<typeof databaseCyclesView>["state"]): string {
  if (state === "active") return "border-line bg-transparent text-muted hover:text-ink";
  if (state === "low-balance") return "border-warnLine bg-warnSoft text-warnText";
  if (state === "suspended") return "border-dangerLine bg-dangerSoft text-dangerText";
  return "border-line bg-transparent text-muted";
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
  const { navigate } = useWikiNavigation();
  const draftKey = `${query}\n${searchKind}`;
  const [draft, setDraft] = useState({ key: draftKey, text: query, kind: searchKind });
  const text = draft.key === draftKey ? draft.text : query;
  const kind = draft.key === draftKey ? draft.kind : searchKind;

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canLeaveDirtyEdit()) return;
    navigate(hrefForSearch(canisterId, databaseId, text.trim(), kind), { guard: false, replace: true });
  }

  return (
    <search aria-label="Search this database">
      <form className="flex min-w-0 flex-1 basis-full items-center gap-1.5 rounded-xl border border-transparent bg-paper px-1.5 py-1 text-sm transition-colors focus-within:border-line focus-within:bg-white sm:basis-[360px] sm:gap-2 lg:max-w-[560px]" onSubmit={submitSearch}>
        <div className="flex shrink-0 rounded-lg bg-line/50 p-0.5 text-xs">
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
        <Button className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg bg-action px-2.5 text-xs font-semibold text-onAction hover:bg-actionHover" type="submit">
          <Search size={15} aria-hidden />
          <span className="sr-only sm:not-sr-only">Search</span>
        </Button>
      </form>
    </search>
  );
}

function SearchKindButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`rounded-md px-2 py-0.5 ${active ? "bg-white text-ink shadow-card" : "text-muted hover:text-ink"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
