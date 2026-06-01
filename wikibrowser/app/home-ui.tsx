"use client";

import Link from "next/link";
import { BookOpen, Settings, Share2 } from "lucide-react";
import type { DatabaseSummary } from "@/lib/types";
import { isRoutableDatabaseId, publicDatabasePath, xShareDatabaseHref } from "@/lib/share-links";

const OFFICIAL_KINIC_WIKI_DATABASE_ID = "db_kva4v2twg6jv";
const OFFICIAL_KINIC_WIKI_DATABASE_NAME = "Official Kinic Wiki";

export type DatabaseRow = DatabaseSummary & {
  member: boolean;
  publicReadable: boolean;
};

export function AuthControls({
  authReady,
  principal,
  loading,
  onLogin,
  onLogout,
  onRefresh
}: {
  authReady: boolean;
  principal: string | null;
  loading: boolean;
  onLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
}) {
  if (!principal) {
    return (
      <button
        className="rounded-2xl border border-action bg-action px-4 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
        disabled={!authReady}
        data-tid="login-button"
        type="button"
        onClick={onLogin}
      >
        Login with Internet Identity
      </button>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" disabled={loading} type="button" onClick={onRefresh}>
        Refresh
      </button>
      <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" type="button" onClick={onLogout}>
        Logout
      </button>
    </div>
  );
}

export function DatabaseBody({
  loading,
  myDatabases,
  principal,
  publicError,
  publicDatabases
}: {
  loading: boolean;
  myDatabases: DatabaseRow[];
  principal: string | null;
  publicError: string | null;
  publicDatabases: DatabaseRow[];
}) {
  if (loading) return <div className="p-6 text-sm text-muted">Loading databases...</div>;
  if (!principal) {
    return <DatabaseSection description="Readable without login. These open in anonymous read mode." emptyMessage="No public databases are available." mode="public" publicError={publicError} rows={publicDatabases} showTitle={false} title="Public databases" />;
  }
  return (
    <div className="grid gap-5">
      <DatabaseSection description="Databases where your signed-in principal has a direct role." emptyMessage="No databases are linked to this principal." mode="member" rows={myDatabases} title="My databases" />
      <DatabaseSection description="Readable without login. These open in anonymous read mode." emptyMessage="No public databases are available." mode="public" publicError={publicError} rows={publicDatabases} title="Public databases" />
    </div>
  );
}

export function OfficialKinicWikiPanel() {
  return (
    <section className="rounded-lg border border-line bg-paper px-4 py-4 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Official database</p>
          <h2 className="mt-1 text-lg font-semibold text-ink">{OFFICIAL_KINIC_WIKI_DATABASE_NAME}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">A canister-backed file-system wiki for agent memory: structured paths, raw sources, links, search, and safe edits.</p>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">Use the Chrome extension to capture ChatGPT conversations and active web pages into the same database.</p>
          <p className="mt-2 break-all font-mono text-xs text-muted">{OFFICIAL_KINIC_WIKI_DATABASE_ID}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="inline-flex items-center justify-center gap-2 rounded-lg border border-action bg-action px-3 py-2 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent" href={publicDatabasePath(OFFICIAL_KINIC_WIKI_DATABASE_ID)}>
            <BookOpen aria-hidden size={15} />
            <span>Open</span>
          </Link>
          <Link className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink no-underline hover:border-accent hover:text-accent" href={`/dashboard/${encodeURIComponent(OFFICIAL_KINIC_WIKI_DATABASE_ID)}`}>
            <Settings aria-hidden size={15} />
            <span>Access</span>
          </Link>
        </div>
      </div>
    </section>
  );
}

function DatabaseSection({
  description,
  emptyMessage,
  mode,
  publicError = null,
  rows,
  showTitle = true,
  title
}: {
  description: string;
  emptyMessage: string;
  mode: "member" | "public";
  publicError?: string | null;
  rows: DatabaseRow[];
  showTitle?: boolean;
  title: string;
}) {
  if (publicError && mode === "public") {
    return (
      <section className={showTitle ? "rounded-lg border border-line bg-paper p-4 shadow-sm" : "p-4"}>
        {showTitle ? <h3 className="text-sm font-semibold text-ink">{title}</h3> : null}
        {showTitle ? <p className="mt-1 text-xs leading-5 text-muted">{description}</p> : null}
        <p className="mt-2 text-sm text-muted">{publicError}</p>
      </section>
    );
  }
  if (rows.length === 0) {
    return (
      <section className={showTitle ? "rounded-lg border border-line bg-paper p-4 shadow-sm" : "p-4"}>
        {showTitle ? <h3 className="text-sm font-semibold text-ink">{title}</h3> : null}
        {showTitle ? <p className="mt-1 text-xs leading-5 text-muted">{description}</p> : null}
        <p className="mt-2 text-sm text-muted">{emptyMessage}</p>
      </section>
    );
  }
  return (
    <section className={showTitle ? "rounded-lg border border-line bg-paper shadow-sm" : undefined}>
      {showTitle ? (
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
        </div>
      ) : null}
      <div className="grid gap-3 p-3 sm:hidden">
        {rows.map((database) => (
          <DatabaseMobileCard key={database.databaseId} database={database} mode={mode} />
        ))}
      </div>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-white/70 text-xs uppercase tracking-[0.12em] text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Database</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Logical size</th>
              <th className="px-4 py-3 font-medium">Archive</th>
              <th className="px-4 py-3 font-medium">Open</th>
              <th className="px-4 py-3 font-medium">Share</th>
              {mode === "member" ? <th className="px-4 py-3 font-medium">Skills</th> : null}
              <th className="px-4 py-3 font-medium">Access</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((database) => (
              <DatabaseTableRow key={database.databaseId} database={database} mode={mode} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DatabaseTableRow({ database, mode }: { database: DatabaseRow; mode: "member" | "public" }) {
  const active = isActiveRoutableDatabase(database);
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-3">
        <div className="flex min-w-[180px] flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{database.name}</span>
          <span className="font-mono text-[11px] text-muted">{database.databaseId}</span>
          {mode === "member" && database.publicReadable ? <span className="rounded border border-line bg-white px-1.5 py-0.5 text-[11px] font-medium text-muted">Public</span> : null}
        </div>
      </td>
      <td className="px-4 py-3 capitalize text-ink">{database.role}</td>
      <td className="px-4 py-3 capitalize text-ink">{database.status}</td>
      <td className="px-4 py-3 text-ink">{formatBytes(database.logicalSizeBytes)}</td>
      <td className="px-4 py-3 text-muted">{databaseMarker(database)}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-2">
          {active ? (
            <Link className="text-accent no-underline hover:underline" href={openDatabaseHref(database)}>
              Open
            </Link>
          ) : <span className="text-muted">-</span>}
          {active && mode === "member" && database.publicReadable ? (
            <Link className="text-accent no-underline hover:underline" href={openPublicDatabaseHref(database)}>
              Open public
            </Link>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3">{active && database.publicReadable ? <ShareDatabaseLink database={database} /> : <span className="text-muted">-</span>}</td>
      {mode === "member" ? (
        <td className="px-4 py-3">
          {active ? (
            <Link className="text-accent no-underline hover:underline" href={`/skills/${encodeURIComponent(database.databaseId)}`}>
              Registry
            </Link>
          ) : <span className="text-muted">-</span>}
        </td>
      ) : null}
      <td className="px-4 py-3">
        <Link className="text-accent no-underline hover:underline" href={`/dashboard/${encodeURIComponent(database.databaseId)}`}>
          Access
        </Link>
      </td>
    </tr>
  );
}

function DatabaseMobileCard({ database, mode }: { database: DatabaseRow; mode: "member" | "public" }) {
  const active = isActiveRoutableDatabase(database);
  return (
    <article className="rounded-lg border border-line bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 break-words font-semibold text-ink">{database.name}</h4>
        {mode === "member" && database.publicReadable ? <span className="rounded border border-line bg-paper px-1.5 py-0.5 text-[11px] font-medium text-muted">Public</span> : null}
      </div>
      <p className="mt-1 break-all font-mono text-[11px] text-muted">{database.databaseId}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3">
        <DatabaseCardMeta label="Role" value={database.role} />
        <DatabaseCardMeta label="Status" value={database.status} />
        <DatabaseCardMeta label="Logical size" value={formatBytes(database.logicalSizeBytes)} />
        <DatabaseCardMeta label="Archive" value={databaseMarker(database)} />
      </dl>
      <div className="mt-4 flex flex-wrap gap-3 font-medium">
        {active ? (
          <Link className="text-accent no-underline hover:underline" href={openDatabaseHref(database)}>
            Open
          </Link>
        ) : null}
        {active && mode === "member" && database.publicReadable ? (
          <Link className="text-accent no-underline hover:underline" href={openPublicDatabaseHref(database)}>
            Open public
          </Link>
        ) : null}
        {mode === "member" ? (
          active ? (
            <Link className="text-accent no-underline hover:underline" href={`/skills/${encodeURIComponent(database.databaseId)}`}>
              Registry
            </Link>
          ) : null
        ) : null}
        {active && database.publicReadable ? <ShareDatabaseLink database={database} /> : null}
        <Link className="text-accent no-underline hover:underline" href={`/dashboard/${encodeURIComponent(database.databaseId)}`}>
          Access
        </Link>
      </div>
    </article>
  );
}

function ShareDatabaseLink({ database }: { database: DatabaseRow }) {
  return (
    <a
      aria-label={`Share ${database.name} on X`}
      className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-2 py-1 text-accent no-underline shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white"
      href={xShareDatabaseHref({ databaseId: database.databaseId, databaseName: database.name })}
      rel="noreferrer"
      target="_blank"
    >
      <Share2 aria-hidden size={14} />
      <span>Share</span>
    </a>
  );
}

function DatabaseCardMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mt-1 break-words capitalize text-ink">{value}</dd>
    </div>
  );
}

export function StatusPanel({ tone, message }: { tone: "error" | "info"; message: string }) {
  const toneClass = tone === "error" ? "border-red-200 bg-red-50 text-red-900" : "border-line bg-paper text-ink";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${toneClass}`}>{message}</div>;
}

export function CreatedDatabasePanel({ databaseId, name }: { databaseId: string; name: string }) {
  return (
    <div className="rounded-lg border border-line bg-paper px-4 py-3 text-sm text-ink">
      Created <span className="font-semibold">{name}</span> <span className="font-mono text-xs text-muted">{databaseId}</span>.{" "}
      <Link className="text-accent no-underline hover:underline" href={`/dashboard/${encodeURIComponent(databaseId)}`}>
        Manage reservation
      </Link>
    </div>
  );
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return value;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let unitIndex = -1;
  let current = bytes;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(current >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function databaseMarker(database: DatabaseSummary): string {
  if (database.archivedAtMs) return `Archived ${formatTimestamp(database.archivedAtMs)}`;
  if (database.status === "pending") return "Pending";
  if (database.creditsSuspendedAtMs) return `Suspended ${formatTimestamp(database.creditsSuspendedAtMs)}`;
  return "-";
}

function isActiveRoutableDatabase(database: DatabaseRow): boolean {
  return database.status === "active" && isRoutableDatabaseId(database.databaseId);
}

function openDatabaseHref(database: DatabaseRow): string {
  const base = `/${encodeURIComponent(database.databaseId)}/Wiki`;
  return !database.member && database.publicReadable ? `${base}?read=anonymous` : base;
}

function openPublicDatabaseHref(database: DatabaseRow): string {
  return publicDatabasePath(database.databaseId);
}

function formatTimestamp(value: string): string {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString() : value;
}
