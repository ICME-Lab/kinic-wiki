"use client";

import Link from "next/link";
import { Share2 } from "lucide-react";
import type { DatabaseSummary } from "@/lib/types";
import { publicDatabasePath, xShareDatabaseHref } from "@/lib/share-links";

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
    return <DatabaseSection emptyMessage="No public databases are available." mode="public" publicError={publicError} rows={publicDatabases} showTitle={false} title="Public databases" />;
  }
  return (
    <div className="divide-y divide-line">
      <DatabaseSection emptyMessage="No databases are linked to this principal." mode="member" rows={myDatabases} title="My databases" />
      {publicDatabases.length > 0 || publicError ? <DatabaseSection emptyMessage="No public databases are available." mode="public" publicError={publicError} rows={publicDatabases} title="Public databases" /> : null}
    </div>
  );
}

function DatabaseSection({
  emptyMessage,
  mode,
  publicError = null,
  rows,
  showTitle = true,
  title
}: {
  emptyMessage: string;
  mode: "member" | "public";
  publicError?: string | null;
  rows: DatabaseRow[];
  showTitle?: boolean;
  title: string;
}) {
  if (publicError && mode === "public") {
    return (
      <section className="p-4">
        {showTitle ? <h3 className="text-sm font-semibold text-ink">{title}</h3> : null}
        <p className="mt-2 text-sm text-muted">{publicError}</p>
      </section>
    );
  }
  if (rows.length === 0) {
    return (
      <section className="p-4">
        {showTitle ? <h3 className="text-sm font-semibold text-ink">{title}</h3> : null}
        <p className="mt-2 text-sm text-muted">{emptyMessage}</p>
      </section>
    );
  }
  return (
    <section>
      {showTitle ? (
        <div className="px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
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
              <tr key={database.databaseId} className="border-t border-line">
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
                    <Link className="text-accent no-underline hover:underline" href={openDatabaseHref(database)}>
                      Open
                    </Link>
                    {mode === "member" && database.publicReadable ? (
                      <Link className="text-accent no-underline hover:underline" href={openPublicDatabaseHref(database)}>
                        Open public
                      </Link>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3">{database.publicReadable ? <ShareDatabaseLink database={database} /> : <span className="text-muted">-</span>}</td>
                {mode === "member" ? (
                  <td className="px-4 py-3">
                    <Link className="text-accent no-underline hover:underline" href={`/skills/${encodeURIComponent(database.databaseId)}`}>
                      Registry
                    </Link>
                  </td>
                ) : null}
                <td className="px-4 py-3">
                  <Link className="text-accent no-underline hover:underline" href={`/dashboard/${encodeURIComponent(database.databaseId)}`}>
                    Access
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DatabaseMobileCard({ database, mode }: { database: DatabaseRow; mode: "member" | "public" }) {
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
        <Link className="text-accent no-underline hover:underline" href={openDatabaseHref(database)}>
          Open
        </Link>
        {mode === "member" && database.publicReadable ? (
          <Link className="text-accent no-underline hover:underline" href={openPublicDatabaseHref(database)}>
            Open public
          </Link>
        ) : null}
        {mode === "member" ? (
          <Link className="text-accent no-underline hover:underline" href={`/skills/${encodeURIComponent(database.databaseId)}`}>
            Registry
          </Link>
        ) : null}
        {database.publicReadable ? <ShareDatabaseLink database={database} /> : null}
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
      <Link className="text-accent no-underline hover:underline" href={`/${encodeURIComponent(databaseId)}/Wiki`}>
        Open
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
  if (database.deletedAtMs) return `Deleted ${formatTimestamp(database.deletedAtMs)}`;
  if (database.archivedAtMs) return `Archived ${formatTimestamp(database.archivedAtMs)}`;
  return "-";
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
