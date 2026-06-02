"use client";

import Link from "next/link";
import { BookOpen, Settings, Share2, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { databaseCyclesView, databaseCyclesHref } from "@/lib/cycles-state";
import type { CyclesBillingConfig, DatabaseSummary } from "@/lib/types";
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
  cyclesConfig,
  loading,
  myDatabases,
  principal,
  publicError,
  publicDatabases
}: {
  cyclesConfig: CyclesBillingConfig | null;
  loading: boolean;
  myDatabases: DatabaseRow[];
  principal: string | null;
  publicError: string | null;
  publicDatabases: DatabaseRow[];
}) {
  if (loading) return <div className="p-6 text-sm text-muted">Loading databases...</div>;
  if (!principal) {
    return <DatabaseSection cyclesConfig={cyclesConfig} description="Readable without login. These open in anonymous read mode." emptyMessage="No public databases are available." mode="public" publicError={publicError} rows={publicDatabases} showTitle={false} title="Public databases" />;
  }
  return (
    <div className="grid gap-5">
      <DatabaseSection cyclesConfig={cyclesConfig} description="Databases where your signed-in principal has a direct role." emptyMessage="No databases are linked to this principal." mode="member" rows={myDatabases} title="My databases" />
      <DatabaseSection cyclesConfig={cyclesConfig} description="Readable without login. These open in anonymous read mode." emptyMessage="No public databases are available." mode="public" publicError={publicError} rows={publicDatabases} title="Public databases" />
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
  cyclesConfig,
  description,
  emptyMessage,
  mode,
  publicError = null,
  rows,
  showTitle = true,
  title
}: {
  cyclesConfig: CyclesBillingConfig | null;
  description: string;
  emptyMessage: string;
  mode: "member" | "public";
  publicError?: string | null;
  rows: DatabaseRow[];
  showTitle?: boolean;
  title: string;
}) {
  if (rows.length === 0) {
    return (
      <section className={showTitle ? "rounded-lg border border-line bg-paper p-4 shadow-sm" : "p-4"}>
        {showTitle ? <h3 className="text-sm font-semibold text-ink">{title}</h3> : null}
        {showTitle ? <p className="mt-1 text-xs leading-5 text-muted">{description}</p> : null}
        {publicError && mode === "public" ? <p className="mt-2 text-sm text-muted">{publicError}</p> : null}
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
          {publicError && mode === "public" ? <p className="mt-2 text-sm text-muted">{publicError}</p> : null}
        </div>
      ) : null}
      {!showTitle && publicError && mode === "public" ? <p className="px-4 pt-4 text-sm text-muted">{publicError}</p> : null}
      <div className="grid gap-3 p-3 sm:hidden">
        {rows.map((database) => (
          <DatabaseMobileCard key={database.databaseId} cyclesConfig={cyclesConfig} database={database} mode={mode} />
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
              <th className="px-4 py-3 font-medium">Cycles</th>
              <th className="px-4 py-3 font-medium">Open</th>
              <th className="px-4 py-3 font-medium">Share</th>
              {mode === "member" ? <th className="px-4 py-3 font-medium">Skills</th> : null}
              <th className="px-4 py-3 font-medium">Access</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((database) => (
              <DatabaseTableRow key={database.databaseId} cyclesConfig={cyclesConfig} database={database} mode={mode} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DatabaseTableRow({ cyclesConfig, database, mode }: { cyclesConfig: CyclesBillingConfig | null; database: DatabaseRow; mode: "member" | "public" }) {
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
      <td className="px-4 py-3 text-ink">{databaseCyclesView(database, cyclesConfig).summary}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-2">
          {active ? <DatabaseActionLink href={openDatabaseHref(database)} icon={<BookOpen aria-hidden size={14} />} label="Open" /> : <span className="text-muted">-</span>}
          {active && mode === "member" && database.publicReadable ? <DatabaseActionLink href={openPublicDatabaseHref(database)} icon={<BookOpen aria-hidden size={14} />} label="Open public" /> : null}
        </div>
      </td>
      <td className="px-4 py-3">{active && database.publicReadable ? <ShareDatabaseLink database={database} /> : <span className="text-muted">-</span>}</td>
      {mode === "member" ? (
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-2">
            {active ? (
              <Link className="text-accent no-underline hover:underline" href={`/skills/${encodeURIComponent(database.databaseId)}`}>
                Registry
              </Link>
            ) : null}
            <DatabaseActionLink href={databaseCyclesHref(database)} icon={<Wallet aria-hidden size={14} />} label="Cycles" />
          </div>
        </td>
      ) : null}
      <td className="px-4 py-3">
        <DatabaseActionLink href={`/dashboard/${encodeURIComponent(database.databaseId)}`} icon={<Settings aria-hidden size={14} />} label="Access" />
      </td>
    </tr>
  );
}

function DatabaseMobileCard({ cyclesConfig, database, mode }: { cyclesConfig: CyclesBillingConfig | null; database: DatabaseRow; mode: "member" | "public" }) {
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
        <DatabaseCardMeta label="Cycles" value={databaseCyclesView(database, cyclesConfig).summary} />
      </dl>
      <div className="mt-4 flex flex-wrap gap-3 font-medium">
        {active ? (
          <DatabaseActionLink href={openDatabaseHref(database)} icon={<BookOpen aria-hidden size={14} />} label="Open" />
        ) : null}
        {active && mode === "member" && database.publicReadable ? (
          <DatabaseActionLink href={openPublicDatabaseHref(database)} icon={<BookOpen aria-hidden size={14} />} label="Open public" />
        ) : null}
        {mode === "member" ? (
          active ? (
            <Link className="text-accent no-underline hover:underline" href={`/skills/${encodeURIComponent(database.databaseId)}`}>
              Registry
            </Link>
          ) : null
        ) : null}
        {mode === "member" ? (
          <DatabaseActionLink href={databaseCyclesHref(database)} icon={<Wallet aria-hidden size={14} />} label="Cycles" />
        ) : null}
        {active && database.publicReadable ? <ShareDatabaseLink database={database} /> : null}
        <DatabaseActionLink href={`/dashboard/${encodeURIComponent(database.databaseId)}`} icon={<Settings aria-hidden size={14} />} label="Access" />
      </div>
    </article>
  );
}

function ShareDatabaseLink({ database }: { database: DatabaseRow }) {
  return (
    <DatabaseActionLink
      external
      ariaLabel={`Share ${database.name} on X`}
      href={xShareDatabaseHref({ databaseId: database.databaseId, databaseName: database.name })}
      icon={<Share2 aria-hidden size={14} />}
      label="Share"
    />
  );
}

function DatabaseActionLink({ ariaLabel, external = false, href, icon, label }: { ariaLabel?: string; external?: boolean; href: string; icon: ReactNode; label: string }) {
  const className =
    "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm font-medium text-accent no-underline shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white";
  if (external) {
    return (
      <a aria-label={ariaLabel} className={className} href={href} rel="noreferrer" target="_blank">
        {icon}
        <span>{label}</span>
      </a>
    );
  }
  return (
    <Link aria-label={ariaLabel} className={className} href={href}>
      {icon}
      <span>{label}</span>
    </Link>
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
