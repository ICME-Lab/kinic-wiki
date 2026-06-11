"use client";

import Link from "next/link";
import { BookOpen, PlugZap, PowerOff, Settings, Share2, TerminalSquare, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { AdminNotice } from "@/components/admin-ui";
import { formatCycles as formatCycleBalance } from "@/lib/cycles";
import { databaseCyclesView, databaseCyclesHref, type DatabaseCycleView } from "@/lib/cycles-state";
import type { CyclesBillingConfig, DatabaseSummary } from "@/lib/types";
import { isRoutableDatabaseId, publicDatabasePath, xShareDatabaseHref } from "@/lib/share-links";

const OFFICIAL_KINIC_WIKI_DATABASE_ID = "db_kva4v2twg6jv";
const OFFICIAL_KINIC_WIKI_DATABASE_NAME = "Official Kinic Wiki";

export type DatabaseRow = DatabaseSummary & {
  member: boolean;
  publicReadable: boolean;
};

export type HeaderWalletProvider = "oisy" | "plug";

export function WalletControls({
  balanceLoading,
  busyProvider,
  connectedBalanceLabel,
  connectedLabel,
  connectedProvider,
  disabled,
  externalWalletsAvailable,
  onConnect,
  onDisconnect
}: {
  balanceLoading: boolean;
  busyProvider: HeaderWalletProvider | null;
  connectedBalanceLabel: string | null;
  connectedLabel: string | null;
  connectedProvider: HeaderWalletProvider | null;
  disabled: boolean;
  externalWalletsAvailable: boolean;
  onConnect: (provider: HeaderWalletProvider) => void;
  onDisconnect: (provider: HeaderWalletProvider) => void;
}) {
  const oisyConnected = connectedProvider === "oisy";
  const plugConnected = connectedProvider === "plug";
  const externalWalletDisabled = !externalWalletsAvailable;
  const oisyDisabled = !oisyConnected && externalWalletDisabled;
  const plugDisabled = !plugConnected && externalWalletDisabled;
  return (
    <div className="flex flex-wrap gap-2">
      <WalletConnectButton
        busy={busyProvider === "oisy"}
        ariaLabel={oisyConnected ? "Disconnect OISY" : undefined}
        balanceLabel={oisyConnected ? connectedBalanceLabel : null}
        balanceLoading={oisyConnected && balanceLoading}
        connected={oisyConnected}
        connectedLabel={oisyConnected ? connectedLabel : null}
        disabled={disabled || busyProvider !== null || oisyDisabled}
        hoverIcon={oisyConnected ? <PowerOff aria-hidden size={15} /> : null}
        icon={<Wallet aria-hidden size={15} />}
        label="OISY"
        onClick={() => (oisyConnected ? onDisconnect("oisy") : onConnect("oisy"))}
      />
      <WalletConnectButton
        busy={busyProvider === "plug"}
        ariaLabel={plugConnected ? "Disconnect Plug" : undefined}
        balanceLabel={plugConnected ? connectedBalanceLabel : null}
        balanceLoading={plugConnected && balanceLoading}
        connected={plugConnected}
        connectedLabel={plugConnected ? connectedLabel : null}
        disabled={disabled || busyProvider !== null || plugDisabled}
        hoverIcon={plugConnected ? <PowerOff aria-hidden size={15} /> : null}
        icon={<PlugZap aria-hidden size={15} />}
        label="Plug"
        onClick={() => (plugConnected ? onDisconnect("plug") : onConnect("plug"))}
      />
    </div>
  );
}

function WalletConnectButton({
  ariaLabel,
  balanceLabel,
  balanceLoading,
  busy,
  connected,
  connectedLabel,
  disabled,
  hoverIcon,
  icon,
  label,
  title,
  onClick
}: {
  ariaLabel?: string;
  balanceLabel: string | null;
  balanceLoading: boolean;
  busy: boolean;
  connected: boolean;
  connectedLabel: string | null;
  disabled: boolean;
  hoverIcon: ReactNode | null;
  icon: ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  const classes = connected
    ? "border-action bg-action text-white hover:border-accent hover:bg-accent"
    : "border-line bg-white text-ink hover:border-accent hover:text-accent";
  const primaryLabel = busy ? "Connecting..." : connectedLabel ?? label;
  const secondaryLabel = balanceLoading ? "Loading KINIC" : balanceLabel;
  return (
    <button
      aria-label={ariaLabel}
      className={`group inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${classes}`}
      disabled={disabled}
      title={title}
      type="button"
      onClick={onClick}
    >
      <span className="relative inline-flex size-[15px] shrink-0 items-center justify-center">
        <span className={hoverIcon && !disabled ? "absolute inset-0 inline-flex items-center justify-center transition-opacity group-hover:opacity-0" : "absolute inset-0 inline-flex items-center justify-center"}>
          {icon}
        </span>
        {hoverIcon && !disabled ? <span className="absolute inset-0 inline-flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">{hoverIcon}</span> : null}
      </span>
      <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5">
        <span className="truncate">{primaryLabel}</span>
        {connected && secondaryLabel ? <span className="font-mono text-xs opacity-90">/ {secondaryLabel}</span> : null}
      </span>
    </button>
  );
}

export function AuthControls({
  authReady,
  principal,
  loading,
  onLogin,
  onLogout
}: {
  authReady: boolean;
  principal: string | null;
  loading: boolean;
  onLogin: () => void;
  onLogout: () => void;
}) {
  if (!principal) {
    return (
      <button
        className="rounded-lg border border-action bg-action px-4 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
        disabled={!authReady}
        data-tid="login-button"
        type="button"
        onClick={onLogin}
      >
        Internet Identity
      </button>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" disabled={loading} type="button" onClick={onLogout}>
        Logout
      </button>
    </div>
  );
}

export function DatabaseBody({
  createDatabaseAction,
  cyclesConfig,
  loading,
  myDatabases,
  principal,
  publicError,
  publicDatabases,
  purchasedDatabases
}: {
  createDatabaseAction?: ReactNode;
  cyclesConfig: CyclesBillingConfig | null;
  loading: boolean;
  myDatabases: DatabaseRow[];
  principal: string | null;
  publicError: string | null;
  publicDatabases: DatabaseRow[];
  purchasedDatabases: DatabaseRow[];
}) {
  if (loading) return <div className="p-6 text-sm text-muted">Loading databases...</div>;
  if (!principal) {
    return <DatabaseSection action={createDatabaseAction} cyclesConfig={cyclesConfig} emptyMessage="No public databases are available." mode="public" publicError={publicError} rows={publicDatabases} showTitle={false} title="Public databases" />;
  }
  return (
    <div className="grid gap-5">
      <DatabaseSection action={createDatabaseAction} cyclesConfig={cyclesConfig} emptyMessage="No databases are linked to this principal." mode="member" rows={myDatabases} title="My databases" />
      <DatabaseSection cyclesConfig={cyclesConfig} emptyMessage="No purchased databases are linked to this principal." mode="member" rows={purchasedDatabases} title="Purchased databases" />
      <DatabaseSection cyclesConfig={cyclesConfig} emptyMessage="No public databases are available." mode="public" publicError={publicError} rows={publicDatabases} title="Public databases" />
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
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="inline-flex items-center justify-center gap-2 rounded-lg border border-action bg-action px-3 py-2 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent" href={publicDatabasePath(OFFICIAL_KINIC_WIKI_DATABASE_ID)}>
            <BookOpen aria-hidden size={15} />
            <span>Open</span>
          </Link>
          <Link className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink no-underline hover:border-accent hover:text-accent" href="/cli">
            <TerminalSquare aria-hidden size={15} />
            <span>CLI</span>
          </Link>
        </div>
      </div>
    </section>
  );
}

function DatabaseSection({
  action,
  cyclesConfig,
  description,
  emptyMessage,
  mode,
  publicError = null,
  rows,
  showTitle = true,
  title
}: {
  action?: ReactNode;
  cyclesConfig: CyclesBillingConfig | null;
  description?: string;
  emptyMessage: string;
  mode: "member" | "public";
  publicError?: string | null;
  rows: DatabaseRow[];
  showTitle?: boolean;
  title: string;
}) {
  if (rows.length === 0) {
    return (
      <section className={showTitle ? "rounded-lg border border-line bg-paper shadow-sm" : "p-4"}>
        {showTitle ? <DatabaseSectionHeader action={action} description={description} title={title} /> : null}
        {publicError && mode === "public" ? <p className={showTitle ? "px-4 pt-3 text-sm text-muted" : "mt-2 text-sm text-muted"}>{publicError}</p> : null}
        <p className={showTitle ? "px-4 pb-4 pt-3 text-sm text-muted" : "mt-2 text-sm text-muted"}>{emptyMessage}</p>
      </section>
    );
  }
  return (
    <section className={showTitle ? "rounded-lg border border-line bg-paper shadow-sm" : undefined}>
      {showTitle ? <DatabaseSectionHeader action={action} description={description} publicError={mode === "public" ? publicError : null} title={title} /> : null}
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
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Size</th>
              <th className="px-4 py-3 font-medium">Cycles</th>
              <th className="px-4 py-3 font-medium">Share</th>
              {mode === "member" ? <th className="px-4 py-3 font-medium">Top up</th> : null}
              <th className="px-4 py-3 font-medium">Manage</th>
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

function DatabaseSectionHeader({ action, description, publicError = null, title }: { action?: ReactNode; description?: string; publicError?: string | null; title: string }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description ? <p className="mt-1 text-xs leading-5 text-muted">{description}</p> : null}
        {publicError ? <p className="mt-2 text-sm text-muted">{publicError}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function DatabaseTableRow({ cyclesConfig, database, mode }: { cyclesConfig: CyclesBillingConfig | null; database: DatabaseRow; mode: "member" | "public" }) {
  const active = isActiveRoutableDatabase(database);
  const cycles = databaseCyclesView(database, cyclesConfig);
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-3">
        <div className="flex min-w-[180px] flex-wrap items-center gap-2">
          {active ? (
            <Link className="font-semibold text-accent no-underline hover:underline" href={openDatabaseHref(database)}>
              {database.name}
            </Link>
          ) : (
            <span className="font-semibold text-ink">{database.name}</span>
          )}
          {database.publicReadable ? <PublicBadge /> : null}
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-[11px] text-muted">{database.databaseId}</td>
      <td className="px-4 py-3 capitalize text-ink">{database.role}</td>
      <td className="px-4 py-3 text-ink">{databaseStatusSummary(database, cycles)}</td>
      <td className="px-4 py-3 text-ink">{formatBytes(database.logicalSizeBytes)}</td>
      <td className="px-4 py-3 text-ink">{databaseCyclesBalanceSummary(database)}</td>
      <td className="px-4 py-3">{active && database.publicReadable ? <ShareDatabaseLink database={database} /> : <span className="text-muted">-</span>}</td>
      {mode === "member" ? (
        <td className="px-4 py-3">
          <DatabaseActionLink href={databaseCyclesHref(database)} icon={<Wallet aria-hidden size={14} />} label="Top up" />
        </td>
      ) : null}
      <td className="px-4 py-3">
        <DatabaseActionLink href={`/dashboard/project/${encodeURIComponent(database.databaseId)}`} icon={<Settings aria-hidden size={14} />} label="Manage" />
      </td>
    </tr>
  );
}

function DatabaseMobileCard({ cyclesConfig, database, mode }: { cyclesConfig: CyclesBillingConfig | null; database: DatabaseRow; mode: "member" | "public" }) {
  const active = isActiveRoutableDatabase(database);
  const cycles = databaseCyclesView(database, cyclesConfig);
  return (
    <article className="rounded-lg border border-line bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 break-words font-semibold">
          {active ? (
            <Link className="text-accent no-underline hover:underline" href={openDatabaseHref(database)}>
              {database.name}
            </Link>
          ) : (
            <span className="text-ink">{database.name}</span>
          )}
        </h4>
        {database.publicReadable ? <PublicBadge /> : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3">
        <DatabaseCardMeta label="ID" value={database.databaseId} />
        <DatabaseCardMeta label="Role" value={database.role} />
        <DatabaseCardMeta label="Status" value={databaseStatusSummary(database, cycles)} />
        <DatabaseCardMeta label="Size" value={formatBytes(database.logicalSizeBytes)} />
        <DatabaseCardMeta label="Cycles" value={databaseCyclesBalanceSummary(database)} />
      </dl>
      <div className="mt-4 flex flex-wrap gap-3 font-medium">
        {mode === "member" ? (
          <DatabaseActionLink href={databaseCyclesHref(database)} icon={<Wallet aria-hidden size={14} />} label="Top up" />
        ) : null}
        {active && database.publicReadable ? <ShareDatabaseLink database={database} /> : null}
        <DatabaseActionLink href={`/dashboard/project/${encodeURIComponent(database.databaseId)}`} icon={<Settings aria-hidden size={14} />} label="Manage" />
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

function PublicBadge() {
  return <span className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-white px-1 text-[11px] font-semibold text-muted">P</span>;
}

function DatabaseActionLink({ ariaLabel, external = false, href, icon, label }: { ariaLabel?: string; external?: boolean; href: string; icon: ReactNode; label: string }) {
  const className =
    "inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm font-medium text-accent no-underline shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white";
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

function databaseStatusSummary(database: DatabaseRow, cycles: DatabaseCycleView): string {
  const databaseStatus = formatStatus(database.status);
  if (database.status === "pending") return "Pending · Needs cycles";
  if (!cycles.configAvailable) return `${databaseStatus} · Cycles unknown`;
  if (database.status !== "active") return databaseStatus;
  if (cycles.state === "suspended") return "Suspended";
  if (cycles.state === "low-balance") return "Low cycles";
  return "Active";
}

function databaseCyclesBalanceSummary(database: DatabaseRow): string {
  const balance = parseCyclesBalance(database.cyclesBalance);
  return balance === null ? "-" : formatCycleBalance(balance);
}

function parseCyclesBalance(value: string | null | undefined): bigint | null {
  if (!value || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}

function formatStatus(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function DatabaseCardMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mt-1 break-words text-ink">{value}</dd>
    </div>
  );
}

export function StatusPanel({ tone, message }: { tone: "error" | "info"; message: string }) {
  return <AdminNotice tone={tone} message={message} />;
}

export function CreatedDatabasePanel({ databaseId, name }: { databaseId: string; name: string }) {
  return (
    <div className="rounded-lg border border-line bg-paper px-4 py-3 text-sm text-ink">
      Created <span className="font-semibold">{name}</span> <span className="font-mono text-xs text-muted">{databaseId}</span>.{" "}
      <Link className="text-accent no-underline hover:underline" href={`/dashboard/project/${encodeURIComponent(databaseId)}`}>
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
  return publicDatabasePath(database.databaseId);
}
