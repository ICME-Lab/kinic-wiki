"use client";

import Link from "next/link";
import { BookOpen, Share2, Wallet } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { ANONYMOUS_PRINCIPAL, LLM_WRITER_LABEL, LLM_WRITER_PRINCIPAL, databaseRoleFromValue, isBusyGrant, isBusyRevoke, principalDisplayName, type BusyAction } from "./access-control";
import { ActionButton } from "./action-button";
import { DatabaseDangerZone } from "./database-danger-zone";
import { MemberTable } from "./member-table";
import { formatRawCycles } from "@/lib/cycles";
import { databaseCyclesView, databaseCyclesHref } from "@/lib/cycles-state";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import type { CyclesBillingConfig, DatabaseCycleEntry, DatabaseCyclesPendingPurchase, DatabaseMember, DatabaseRole, DatabaseSummary, MarketCreateListingRequest, MarketListing, MarketUpdateListingRequest } from "@/lib/types";
import { isRoutableDatabaseId, publicDatabasePath, xShareDatabaseHref } from "@/lib/share-links";

type PendingAclAction = {
  title: string;
  message: string;
  confirmLabel: string;
  principalText: string;
  role?: DatabaseRole;
  kind: "grant" | "revoke";
};

export type DashboardTab = "access" | "cycles-history";

export function AuthControls(props: { authReady: boolean; loading: boolean; principal: string | null; onLogin: () => void; onLogout: () => void }) {
  if (!props.principal) {
    return (
      <ActionButton disabled={!props.authReady} dataTid="login-button" onClick={props.onLogin} variant="primary">
        Internet Identity
      </ActionButton>
    );
  }
  return (
    <ActionButton disabled={props.loading} loading={props.loading} loadingLabel="Logging out..." onClick={props.onLogout} variant="secondary">
      Logout
    </ActionButton>
  );
}

export function SummaryPanel({
  cyclesConfig,
  database,
  databaseId,
  principal,
  publicReadable
}: {
  cyclesConfig: CyclesBillingConfig | null;
  database: DatabaseSummary | null;
  databaseId: string;
  principal: string;
  publicReadable: boolean;
}) {
  const routable = isRoutableDatabaseId(databaseId);
  const active = database?.status === "active";
  const openHref = active && routable ? (publicReadable ? publicDatabasePath(databaseId) : `/${encodeURIComponent(databaseId)}/Wiki`) : null;
  const cycles = databaseCyclesView(database, cyclesConfig);
  const purchaseHref = database ? databaseCyclesHref(database) : null;
  return (
    <section className="grid gap-3 rounded-lg border border-line bg-paper p-4 text-sm shadow-sm sm:grid-cols-2 lg:grid-cols-5">
      <Field label="Principal" value={principal} />
      <Field label="Database" value={database?.name ?? databaseId} />
      <Field label="Database ID" value={databaseId} />
      <Field label="Your Role" value={database?.role ?? "-"} />
      <Field label="Status" value={databaseStatusLabel(database?.status)} />
      <Field label="Logical size" value={database ? formatBytes(database.logicalSizeBytes) : "-"} />
      <Field label="Cycles" value={cycles.summary} />
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-3">
        {purchaseHref ? <SummaryActionLink href={purchaseHref} icon={<Wallet aria-hidden size={14} />} label="Cycles" /> : null}
        {openHref ? <SummaryActionLink href={openHref} icon={<BookOpen aria-hidden size={14} />} label="Open" /> : null}
        {active && publicReadable && routable ? (
          <SummaryActionLink
            external
            ariaLabel={`Share ${database?.name ?? databaseId} on X`}
            href={xShareDatabaseHref({ databaseId, databaseName: database?.name ?? databaseId })}
            icon={<Share2 aria-hidden size={14} />}
            label="Share"
          />
        ) : null}
      </div>
    </section>
  );
}

export function PendingDatabasePanel(props: {
  busy: boolean;
  busyAction: BusyAction | null;
  databaseId: string;
  databaseName: string;
  onDelete: () => Promise<string | null>;
}) {
  return (
    <section className="rounded-lg border border-line bg-paper shadow-sm">
      <div className="grid gap-2 border-b border-line px-4 py-4">
        <h2 className="text-lg font-semibold text-ink">Reserved database</h2>
        <p className="text-sm leading-6 text-muted">This database is reserved until the first cycle purchase completes. VFS, skills, and member management are available after activation.</p>
      </div>
      <DatabaseDangerZone activeEntitlementCount={null} cyclesBalance="0" busy={props.busy} busyAction={props.busyAction} databaseId={props.databaseId} databaseName={props.databaseName} onDelete={props.onDelete} />
    </section>
  );
}

export function OwnerPanel(props: {
  cyclesBalance: string;
  busy: boolean;
  busyAction: BusyAction | null;
  databaseId: string;
  databaseName: string;
  activeEntitlementCount: string | null;
  marketBusy: boolean;
  marketError: string | null;
  marketListings: MarketListing[];
  members: DatabaseMember[];
  principal: string;
  onCreateListing: (request: MarketCreateListingRequest) => void;
  onDelete: () => Promise<string | null>;
  onGrant: (principalText: string, role: DatabaseRole) => void;
  onPauseListing: (listingId: string) => void;
  onPublishListing: (listingId: string) => void;
  onRevoke: (principalText: string) => void;
  onUpdateListing: (request: MarketUpdateListingRequest) => void;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAclAction | null>(null);
  const publicMember = props.members.find((member) => member.principal === ANONYMOUS_PRINCIPAL);
  const publicEnabled = Boolean(publicMember);
  const publicBusy = isBusyGrant(props.busyAction, ANONYMOUS_PRINCIPAL, "reader") || isBusyRevoke(props.busyAction, ANONYMOUS_PRINCIPAL);
  const llmWriterMember = props.members.find((member) => member.principal === LLM_WRITER_PRINCIPAL);
  const llmWriterEnabled = llmWriterMember?.role === "writer";
  const llmWriterBusy = isBusyGrant(props.busyAction, LLM_WRITER_PRINCIPAL, "writer") || isBusyRevoke(props.busyAction, LLM_WRITER_PRINCIPAL);
  const llmWriterButtonLabel = llmWriterMember ? (llmWriterEnabled ? "Disable LLM writer" : "Set LLM writer") : "Enable LLM writer";
  function requestGrant(principalText: string, role: DatabaseRole) {
    if (principalText === ANONYMOUS_PRINCIPAL) {
      setPendingAction({
        title: "Enable public access",
        message: `Grant reader access to anonymous principal ${ANONYMOUS_PRINCIPAL}. Anyone can read this database through the public browser.`,
        confirmLabel: "Enable public",
        principalText,
        role: "reader",
        kind: "grant"
      });
      return;
    }
    if (principalText === LLM_WRITER_PRINCIPAL) {
      setPendingAction({
        title: llmWriterButtonLabel,
        message: `Grant writer access to ${LLM_WRITER_LABEL}. Worker writes can create and update wiki drafts, and stop when role or cycles state changes.`,
        confirmLabel: llmWriterButtonLabel,
        principalText,
        role: "writer",
        kind: "grant"
      });
      return;
    }
    if (role === "owner") {
      setPendingAction({
        title: "Grant owner access",
        message: `Grant owner access to ${principalText}. Owners can grant and revoke database access.`,
        confirmLabel: "Grant owner",
        principalText,
        role,
        kind: "grant"
      });
      return;
    }
    props.onGrant(principalText, role);
  }
  function requestRoleChange(member: DatabaseMember, role: DatabaseRole) {
    if (member.role === role) return;
    if (member.principal === ANONYMOUS_PRINCIPAL && role !== "reader") return;
    if (role === "owner") {
      setPendingAction({
        title: "Grant owner access",
        message: `Change ${principalDisplayName(member.principal)} from ${member.role} to owner. Owners can grant and revoke database access.`,
        confirmLabel: "Grant owner",
        principalText: member.principal,
        role,
        kind: "grant"
      });
      return;
    }
    if (member.role === "owner") {
      setPendingAction({
        title: "Change owner access",
        message: `Change ${principalDisplayName(member.principal)} from owner to ${role}. This principal will lose database management access.`,
        confirmLabel: "Change role",
        principalText: member.principal,
        role,
        kind: "grant"
      });
      return;
    }
    props.onGrant(member.principal, role);
  }
  function requestRevoke(member: DatabaseMember) {
    if (member.principal === ANONYMOUS_PRINCIPAL) {
      setPendingAction({
        title: "Disable public access",
        message: `Revoke anonymous reader access from ${ANONYMOUS_PRINCIPAL}. Public browser reads will stop working for this database.`,
        confirmLabel: "Disable public",
        principalText: member.principal,
        kind: "revoke"
      });
      return;
    }
    if (member.principal === LLM_WRITER_PRINCIPAL) {
      setPendingAction({
        title: "Disable LLM writer",
        message: `Revoke ${LLM_WRITER_LABEL} access. Worker writes will stop for this database.`,
        confirmLabel: "Disable LLM writer",
        principalText: member.principal,
        kind: "revoke"
      });
      return;
    }
    if (member.role === "owner") {
      setPendingAction({
        title: "Revoke owner access",
        message: `Revoke owner access from ${principalDisplayName(member.principal)}. This principal will lose database management access.`,
        confirmLabel: "Revoke owner",
        principalText: member.principal,
        kind: "revoke"
      });
      return;
    }
    props.onRevoke(member.principal);
  }
  function confirmPendingAction() {
    if (!pendingAction) return;
    if (pendingAction.kind === "grant" && pendingAction.role) {
      props.onGrant(pendingAction.principalText, pendingAction.role);
    } else {
      props.onRevoke(pendingAction.principalText);
    }
    setPendingAction(null);
  }
  return (
    <section className="rounded-lg border border-line bg-paper shadow-sm">
      <div className="grid gap-3 border-b border-line px-4 py-4">
        <h2 className="text-lg font-semibold text-ink">Members</h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <AclQuickAction enabled={publicEnabled} busy={props.busy} actionBusy={publicBusy} enabledLabel="Disable public" disabledLabel="Enable public" onDisable={() => publicMember && requestRevoke(publicMember)} onEnable={() => requestGrant(ANONYMOUS_PRINCIPAL, "reader")} />
          <AclQuickAction enabled={llmWriterEnabled} busy={props.busy} actionBusy={llmWriterBusy} enabledLabel="Disable LLM writer" disabledLabel={llmWriterButtonLabel} onDisable={() => llmWriterMember && requestRevoke(llmWriterMember)} onEnable={() => requestGrant(LLM_WRITER_PRINCIPAL, "writer")} />
        </div>
        <p className="rounded-lg border border-line bg-white px-3 py-2 text-xs leading-5 text-muted">
          URL ingest trigger sessions are valid for 30 minutes. Revoking writer access does not immediately invalidate an already issued session ticket before it expires.
        </p>
      </div>
      <GrantForm busy={props.busy} busyAction={props.busyAction} onGrant={requestGrant} />
      <MemberTable busy={props.busy} busyAction={props.busyAction} members={props.members} principal={props.principal} onRevoke={requestRevoke} onRoleChange={requestRoleChange} />
      {pendingAction ? <ConfirmAclDialog action={pendingAction} busy={props.busy} busyAction={props.busyAction} onCancel={() => setPendingAction(null)} onConfirm={confirmPendingAction} /> : null}
      <MarketListingsPanel
        busy={props.marketBusy}
        databaseId={props.databaseId}
        databaseName={props.databaseName}
        error={props.marketError}
        listings={props.marketListings}
        onCreate={props.onCreateListing}
        onPause={props.onPauseListing}
        onPublish={props.onPublishListing}
        onUpdate={props.onUpdateListing}
      />
      <DatabaseDangerZone
        activeEntitlementCount={props.activeEntitlementCount}
        cyclesBalance={props.cyclesBalance}
        busy={props.busy}
        busyAction={props.busyAction}
        databaseId={props.databaseId}
        databaseName={props.databaseName}
        onDelete={props.onDelete}
      />
    </section>
  );
}

function MarketListingsPanel(props: {
  busy: boolean;
  databaseId: string;
  databaseName: string;
  error: string | null;
  listings: MarketListing[];
  onCreate: (request: MarketCreateListingRequest) => void;
  onPause: (listingId: string) => void;
  onPublish: (listingId: string) => void;
  onUpdate: (request: MarketUpdateListingRequest) => void;
}) {
  const [selectedListingId, setSelectedListingId] = useState("");
  const [title, setTitle] = useState(props.databaseName);
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("1");
  const [tags, setTags] = useState("");
  const selected = props.listings.find((listing) => listing.listingId === selectedListingId) ?? null;
  const priceE8s = parseKinicInput(price);
  const submitDisabled = props.busy || !title.trim() || !description.trim() || !priceE8s;

  function selectListing(listing: MarketListing) {
    setSelectedListingId(listing.listingId);
    setTitle(listing.title);
    setDescription(listing.description);
    setPrice(decimalFromE8s(listing.priceE8s));
    setTags(tagsFromJson(listing.tagsJson));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled || !priceE8s) return;
    const base = {
      databaseId: props.databaseId,
      title: title.trim(),
      description: description.trim(),
      llmSummary: null,
      summarySnapshotRevision: null,
      sampleExcerptsJson: "[]",
      sampleQuestionsJson: "[]",
      tagsJson: tagsJsonFromInput(tags),
      priceE8s
    };
    if (selected) {
      props.onUpdate({
        ...base,
        listingId: selected.listingId,
        expectedRevision: selected.revision
      });
    } else {
      props.onCreate(base);
    }
  }

  return (
    <div className="grid gap-4 border-t border-line px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Marketplace</h3>
          <p className="mt-1 text-sm leading-6 text-muted">DB owner can sell paid reader access.</p>
        </div>
        <Link className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-accent no-underline hover:border-accent" href="/marketplace">
          Marketplace
        </Link>
      </div>
      {props.error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{props.error}</p> : null}
      {props.listings.length ? (
        <div className="grid gap-2">
          {props.listings.map((listing) => (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm" key={listing.listingId}>
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{listing.title}</p>
                <p className="font-mono text-xs text-muted">
                  {listing.status} / {formatTokenAmountFromE8s(listing.priceE8s)} / {listing.purchaseCount} purchases
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton disabled={props.busy} onClick={() => selectListing(listing)} variant="secondary">
                  Edit
                </ActionButton>
                {listing.status === "Active" ? (
                  <ActionButton disabled={props.busy} onClick={() => props.onPause(listing.listingId)} variant="secondary">
                    Pause
                  </ActionButton>
                ) : (
                  <ActionButton disabled={props.busy} onClick={() => props.onPublish(listing.listingId)} variant="primary">
                    Publish
                  </ActionButton>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <form className="grid gap-3" onSubmit={submit}>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase text-muted">Title</span>
            <input className="rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-accent" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase text-muted">Price KINIC</span>
            <input className="rounded-lg border border-line bg-white px-3 py-2 font-mono outline-none focus:border-accent" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
          </label>
        </div>
        <label className="grid gap-1 text-sm">
          <span className="text-xs uppercase text-muted">Description</span>
          <textarea className="min-h-24 rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-accent" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs uppercase text-muted">Tags</span>
          <input className="rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-accent" value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <ActionButton disabled={submitDisabled} loading={props.busy} loadingLabel="Saving..." type="submit" variant="primary">
            {selected ? "Edit listing" : "Sell"}
          </ActionButton>
          {selected ? (
            <ActionButton
              disabled={props.busy}
              onClick={() => {
                setSelectedListingId("");
                setTitle(props.databaseName);
                setDescription("");
                setPrice("1");
                setTags("");
              }}
              variant="secondary"
            >
              New listing
            </ActionButton>
          ) : null}
        </div>
      </form>
    </div>
  );
}

export function RenameDatabaseDialog(props: {
  busy: boolean;
  busyAction: BusyAction | null;
  databaseName: string;
  draft: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: (name: string) => void;
}) {
  const trimmed = props.draft.trim();
  const renameBusy = props.busyAction?.kind === "rename";
  const submitDisabled = props.busy || trimmed === "" || trimmed === props.databaseName;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) return;
    props.onSubmit(trimmed);
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4"
      onMouseDown={(event) => {
        if (!props.busy && event.target === event.currentTarget) props.onCancel();
      }}
    >
      <form className="w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-lg" onSubmit={submit}>
        <h3 className="text-lg font-semibold text-ink">Rename database</h3>
        <label className="mt-4 grid gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.12em] text-muted">Database name</span>
          <input
            className="rounded-lg border border-line bg-white px-3 py-2 text-ink outline-none focus:border-accent"
            maxLength={80}
            type="text"
            value={props.draft}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <ActionButton disabled={props.busy} onClick={props.onCancel} variant="secondary">
            Cancel
          </ActionButton>
          <ActionButton disabled={submitDisabled} loading={renameBusy} loadingLabel="Saving..." type="submit" variant="primary">
            Rename
          </ActionButton>
        </div>
      </form>
    </div>
  );
}

export function ReadonlyMembersPanel(props: { memberError: string | null; members: DatabaseMember[]; principal: string }) {
  return (
    <section className="rounded-lg border border-line bg-paper shadow-sm">
      <div className="grid gap-2 border-b border-line px-4 py-4">
        <h2 className="text-lg font-semibold text-ink">Members</h2>
        <p className="text-sm leading-6 text-muted">Public database access is read-only for this principal.</p>
      </div>
      {props.memberError ? <div className="border-b border-line px-4 py-3 text-sm text-red-900">{props.memberError}</div> : null}
      <MemberTable
        busy={false}
        busyAction={null}
        members={props.members}
        principal={props.principal}
        readOnly
        onRevoke={() => {}}
        onRoleChange={() => {}}
      />
    </section>
  );
}

export function StatusPanel({ tone, message }: { tone: "error" | "info"; message: string }) {
  const toneClass = tone === "error" ? "border-red-200 bg-red-50 text-red-900" : "border-line bg-paper text-ink";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${toneClass}`}>{message}</div>;
}

export function DashboardTabs({ activeTab, onChange }: { activeTab: DashboardTab; onChange: (tab: DashboardTab) => void }) {
  return (
    <nav aria-label="Database dashboard sections" className="flex flex-wrap gap-2 border-b border-line">
      <DashboardTabButton active={activeTab === "access"} label="Access" onClick={() => onChange("access")} />
      <DashboardTabButton active={activeTab === "cycles-history"} label="Cycles History" onClick={() => onChange("cycles-history")} />
    </nav>
  );
}

export function CyclesHistoryPanel(props: {
  authenticated: boolean;
  entries: DatabaseCycleEntry[];
  entriesError: string | null;
  entriesLoading: boolean;
  nextCursor: string | null;
  pendingError: string | null;
  pendingLoading: boolean;
  pendingPurchases: DatabaseCyclesPendingPurchase[];
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-line bg-paper shadow-sm">
        <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Pending purchases</h2>
            <p className="mt-1 text-sm leading-6 text-muted">Owner, billing authority, and payer can inspect purchase operations.</p>
          </div>
          <ActionButton disabled={props.entriesLoading || props.pendingLoading} loading={props.pendingLoading} loadingLabel="Refreshing..." onClick={props.onRefresh} size="compact" variant="secondary">
            Refresh
          </ActionButton>
        </div>
        {!props.authenticated ? <PanelNotice tone="info" message="Login to view pending purchases." /> : null}
        {props.pendingError ? <PanelNotice tone="error" message={props.pendingError} /> : null}
        {props.pendingLoading ? <PanelNotice tone="info" message="Loading pending purchases..." /> : null}
        {!props.pendingLoading && props.authenticated && !props.pendingError && props.pendingPurchases.length === 0 ? <PanelNotice tone="info" message="No pending purchases." /> : null}
        {props.pendingPurchases.length > 0 ? <PendingPurchasesTable purchases={props.pendingPurchases} /> : null}
      </section>

      <section className="rounded-lg border border-line bg-paper shadow-sm">
        <div className="grid gap-2 border-b border-line px-4 py-4">
          <h2 className="text-lg font-semibold text-ink">Ledger entries</h2>
          <p className="text-sm leading-6 text-muted">Entries are shown in entry ID order. Reader and writer caller values come from the canister redaction policy.</p>
        </div>
        {props.entriesError ? <PanelNotice tone="error" message={props.entriesError} /> : null}
        {props.entriesLoading && props.entries.length === 0 ? <PanelNotice tone="info" message="Loading ledger entries..." /> : null}
        {!props.entriesLoading && !props.entriesError && props.entries.length === 0 ? <PanelNotice tone="info" message="No ledger entries." /> : null}
        {props.entries.length > 0 ? <LedgerEntriesTable entries={props.entries} /> : null}
        {props.nextCursor ? (
          <div className="border-t border-line px-4 py-3">
            <ActionButton disabled={props.entriesLoading} loading={props.entriesLoading} loadingLabel="Loading..." onClick={props.onLoadMore} size="compact" variant="secondary">
              Load more
            </ActionButton>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DashboardTabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  const activeClass = active ? "border-accent bg-white text-accent shadow-sm" : "border-transparent bg-transparent text-muted hover:border-line hover:bg-white hover:text-ink";
  return (
    <button aria-selected={active} className={`-mb-px rounded-t-lg border px-4 py-2 text-sm font-medium ${activeClass}`} role="tab" type="button" onClick={onClick}>
      {label}
    </button>
  );
}

function PendingPurchasesTable({ purchases }: { purchases: DatabaseCyclesPendingPurchase[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[960px] w-full text-left text-sm">
        <thead className="bg-white text-xs uppercase tracking-[0.12em] text-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Operation</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Required action</th>
            <th className="px-4 py-3 font-medium">Cycles</th>
            <th className="px-4 py-3 font-medium">Payment</th>
            <th className="px-4 py-3 font-medium">Ledger block</th>
            <th className="px-4 py-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {purchases.map((purchase) => (
            <tr key={purchase.operationId}>
              <td className="px-4 py-3 font-mono text-xs text-ink">{purchase.operationId}</td>
              <td className="px-4 py-3 text-ink">{purchase.status}</td>
              <td className="px-4 py-3">
                <RequiredActionBadge action={purchase.requiredAction} />
              </td>
              <td className="px-4 py-3 font-mono text-xs text-ink">{formatCycleString(purchase.amountCycles)}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink">{formatTokenAmountFromE8s(purchase.paymentAmountE8s)}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink">{purchase.ledgerBlockIndex ?? "-"}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink">{formatTimestamp(purchase.createdAtMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LedgerEntriesTable({ entries }: { entries: DatabaseCycleEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[1040px] w-full text-left text-sm">
        <thead className="bg-white text-xs uppercase tracking-[0.12em] text-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Entry</th>
            <th className="px-4 py-3 font-medium">Kind</th>
            <th className="px-4 py-3 font-medium">Amount</th>
            <th className="px-4 py-3 font-medium">Balance after</th>
            <th className="px-4 py-3 font-medium">Caller</th>
            <th className="px-4 py-3 font-medium">Method</th>
            <th className="px-4 py-3 font-medium">Ledger block</th>
            <th className="px-4 py-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {entries.map((entry) => (
            <tr key={entry.entryId}>
              <td className="px-4 py-3 font-mono text-xs text-ink">{entry.entryId}</td>
              <td className="px-4 py-3 text-ink">{entry.kind}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink">{formatCycleString(entry.amountCycles)}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink">{formatCycleString(entry.balanceAfterCycles)}</td>
              <td className="max-w-[220px] truncate px-4 py-3 font-mono text-xs text-ink" title={entry.caller}>{entry.caller}</td>
              <td className="px-4 py-3 text-ink">{entry.method ?? "-"}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink">{entry.ledgerBlockIndex ?? "-"}</td>
              <td className="px-4 py-3 font-mono text-xs text-ink">{formatTimestamp(entry.createdAtMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequiredActionBadge({ action }: { action: string }) {
  const warning = action === "billing_authority_review";
  const toneClass = warning ? "border-amber-200 bg-amber-50 text-amber-900" : "border-line bg-white text-ink";
  return <span className={`inline-flex rounded-lg border px-2 py-1 text-xs font-medium ${toneClass}`}>{action}</span>;
}

function PanelNotice({ message, tone }: { message: string; tone: "error" | "info" }) {
  const toneClass = tone === "error" ? "text-red-900" : "text-muted";
  return <div className={`border-b border-line px-4 py-3 text-sm ${toneClass}`}>{message}</div>;
}

function GrantForm({ busy, busyAction, onGrant }: { busy: boolean; busyAction: BusyAction | null; onGrant: (principalText: string, role: DatabaseRole) => void }) {
  const [principalText, setPrincipalText] = useState("");
  const [role, setRole] = useState<DatabaseRole>("reader");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = principalText.trim();
    if (!trimmed) return;
    onGrant(trimmed, role);
    setPrincipalText("");
  }
  const trimmedPrincipal = principalText.trim();
  const grantBusy = busyAction?.kind === "grant";
  return (
    <form className="grid gap-3 border-b border-line p-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px_auto]">
        <input className="rounded-lg border border-line px-3 py-2 font-mono text-sm" value={principalText} onChange={(event) => setPrincipalText(event.target.value)} placeholder="principal" />
        <select className="rounded-lg border border-line px-3 py-2 text-sm" value={role} onChange={(event) => setRole(databaseRoleFromValue(event.target.value))}>
          <option value="reader">reader</option>
          <option value="writer">writer</option>
          <option value="owner">owner</option>
        </select>
        <ActionButton disabled={busy} loading={grantBusy} loadingLabel="Granting..." type="submit" variant="primary">
          Grant
        </ActionButton>
      </div>
      <p className="text-xs text-muted">{trimmedPrincipal ? `This will grant ${role} access to principal ${trimmedPrincipal}.` : `Enter a principal to grant ${role} access.`}</p>
    </form>
  );
}

function ConfirmAclDialog(props: { action: PendingAclAction; busy: boolean; busyAction: BusyAction | null; onCancel: () => void; onConfirm: () => void }) {
  const confirmBusy =
    props.action.kind === "grant" && props.action.role
      ? isBusyGrant(props.busyAction, props.action.principalText, props.action.role)
      : isBusyRevoke(props.busyAction, props.action.principalText);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4"
      onMouseDown={(event) => {
        if (!props.busy && event.target === event.currentTarget) props.onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-lg">
        <h3 className="text-lg font-semibold text-ink">{props.action.title}</h3>
        <p className="mt-3 text-sm leading-6 text-muted">{props.action.message}</p>
        <p className="mt-3 break-all rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-ink">{principalDisplayName(props.action.principalText)}</p>
        <div className="mt-5 flex justify-end gap-2">
          <ActionButton disabled={props.busy} onClick={props.onCancel} variant="secondary">
            Cancel
          </ActionButton>
          <ActionButton disabled={props.busy} loading={confirmBusy} loadingLabel="Applying..." onClick={props.onConfirm} variant="danger">
            {props.action.confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function AclQuickAction(props: { enabled: boolean; busy: boolean; actionBusy: boolean; enabledLabel: string; disabledLabel: string; onDisable: () => void; onEnable: () => void }) {
  return (
    <ActionButton disabled={props.busy} loading={props.actionBusy} loadingLabel={props.enabled ? "Disabling..." : "Enabling..."} onClick={props.enabled ? props.onDisable : props.onEnable} variant={props.enabled ? "secondary" : "primary"}>
      {props.enabled ? props.enabledLabel : props.disabledLabel}
    </ActionButton>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-ink" title={value}>
        {value}
      </div>
    </div>
  );
}

function SummaryActionLink({ ariaLabel, external = false, href, icon, label }: { ariaLabel?: string; external?: boolean; href: string; icon: ReactNode; label: string }) {
  const className =
    "inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm font-medium text-accent no-underline shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white";
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

function databaseStatusLabel(status: DatabaseSummary["status"] | undefined): string {
  if (!status) return "-";
  const labels: Record<DatabaseSummary["status"], string> = {
    pending: "Pending",
    archived: "Archived",
    archiving: "Archiving",
    active: "Active",
    restoring: "Restoring",
    deleted: "Deleted"
  };
  return labels[status];
}

function parseKinicInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const e8s = `${whole}${fraction.padEnd(8, "0")}`.replace(/^0+(?=\d)/, "");
  return BigInt(e8s) > 0n ? e8s : null;
}

function decimalFromE8s(value: string): string {
  if (!/^\d+$/.test(value)) return "1";
  const padded = value.padStart(9, "0");
  const whole = padded.slice(0, -8).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-8).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function tagsJsonFromInput(value: string): string {
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return JSON.stringify(tags);
}

function tagsFromJson(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return "";
    const tags = parsed.filter((item): item is string => typeof item === "string");
    return tags.join(", ");
  } catch {
    return "";
  }
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1024) return Number.isFinite(bytes) ? `${bytes} B` : value;
  const units = ["KB", "MB", "GB"];
  let current = bytes;
  let unitIndex = -1;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(current >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatCycleString(value: string): string {
  if (!/^-?[0-9]+$/.test(value)) return value;
  return `${formatRawCycles(BigInt(value))} cycles`;
}

function formatTimestamp(value: string): string {
  if (!/^-?[0-9]+$/.test(value)) return value;
  const time = Number(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toISOString();
}
