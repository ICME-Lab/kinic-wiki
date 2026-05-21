"use client";

import Link from "next/link";
import { Share2 } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { ANONYMOUS_PRINCIPAL, LLM_WRITER_LABEL, LLM_WRITER_PRINCIPAL, databaseRoleFromValue, isBusyGrant, isBusyRevoke, principalDisplayName, type BusyAction } from "./access-control";
import { ActionButton } from "./action-button";
import { MemberTable } from "./member-table";
import type { DatabaseMember, DatabaseRole, DatabaseSummary } from "@/lib/types";
import { publicDatabasePath, xShareDatabaseHref } from "@/lib/share-links";

type PendingAclAction = {
  title: string;
  message: string;
  confirmLabel: string;
  principalText: string;
  role?: DatabaseRole;
  kind: "grant" | "revoke";
};

export function AuthControls(props: { authReady: boolean; loading: boolean; principal: string | null; onLogin: () => void; onLogout: () => void }) {
  if (!props.principal) {
    return (
      <ActionButton disabled={!props.authReady} dataTid="login-button" onClick={props.onLogin} variant="primary">
        Login with Internet Identity
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
  database,
  databaseId,
  principal,
  publicReadable
}: {
  database: DatabaseSummary | null;
  databaseId: string;
  principal: string;
  publicReadable: boolean;
}) {
  const openHref = publicReadable ? publicDatabasePath(databaseId) : `/${encodeURIComponent(databaseId)}/Wiki`;
  return (
    <section className="grid gap-3 rounded-lg border border-line bg-paper p-4 text-sm shadow-sm sm:grid-cols-2 lg:grid-cols-5">
      <Field label="Principal" value={principal} />
      <Field label="Database" value={database?.name ?? databaseId} />
      <Field label="Database ID" value={databaseId} />
      <Field label="Role" value={database?.role ?? "-"} />
      <Field label="Status" value={database?.status ?? "-"} />
      <Field label="Logical size" value={database ? formatBytes(database.logicalSizeBytes) : "-"} />
      <Link className="text-accent no-underline hover:underline" href={openHref}>
        Open
      </Link>
      {publicReadable ? (
        <a
          aria-label={`Share ${database?.name ?? databaseId} on X`}
          className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-2 py-1 text-accent no-underline shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white"
          href={xShareDatabaseHref({ databaseId, databaseName: database?.name ?? databaseId })}
          rel="noreferrer"
          target="_blank"
        >
          <Share2 aria-hidden size={14} />
          <span>Share</span>
        </a>
      ) : null}
    </section>
  );
}

export function OwnerPanel(props: {
  busy: boolean;
  busyAction: BusyAction | null;
  databaseName: string;
  members: DatabaseMember[];
  principal: string;
  onGrant: (principalText: string, role: DatabaseRole) => void;
  onRename: (name: string) => void;
  onRevoke: (principalText: string) => void;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAclAction | null>(null);
  const [databaseName, setDatabaseName] = useState(props.databaseName);
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
        message: `Grant writer access to ${LLM_WRITER_LABEL}. Worker writes can create and update wiki drafts.`,
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
  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = databaseName.trim();
    if (!nextName || nextName === props.databaseName || props.busy) return;
    props.onRename(nextName);
  }
  return (
    <section className="rounded-lg border border-line bg-paper shadow-sm">
      <div className="grid gap-3 border-b border-line px-4 py-4">
        <h2 className="text-lg font-semibold text-ink">Members</h2>
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={submitRename}>
          <label className="grid flex-1 gap-1 text-sm">
            <span className="text-xs uppercase tracking-[0.12em] text-muted">Database name</span>
            <input
              className="rounded-lg border border-line bg-white px-3 py-2 text-ink outline-none focus:border-accent"
              maxLength={80}
              type="text"
              value={databaseName}
              onChange={(event) => setDatabaseName(event.target.value)}
            />
          </label>
          <ActionButton disabled={props.busy || databaseName.trim() === "" || databaseName.trim() === props.databaseName} loading={props.busyAction?.kind === "rename"} loadingLabel="Saving..." type="submit" variant="secondary">
            Rename
          </ActionButton>
        </form>
        <AclQuickAction label="Public" enabled={publicEnabled} busy={props.busy} actionBusy={publicBusy} enabledLabel="Disable public" disabledLabel="Enable public" onDisable={() => publicMember && requestRevoke(publicMember)} onEnable={() => requestGrant(ANONYMOUS_PRINCIPAL, "reader")} />
        <AclQuickAction label={LLM_WRITER_LABEL} enabled={llmWriterEnabled} busy={props.busy} actionBusy={llmWriterBusy} enabledLabel="Disable LLM writer" disabledLabel={llmWriterButtonLabel} onDisable={() => llmWriterMember && requestRevoke(llmWriterMember)} onEnable={() => requestGrant(LLM_WRITER_PRINCIPAL, "writer")} />
        <p className="rounded-lg border border-line bg-white px-3 py-2 text-xs leading-5 text-muted">
          URL ingest trigger sessions are valid for 30 minutes. Revoking writer access does not immediately invalidate an already issued session ticket before it expires.
        </p>
      </div>
      <GrantForm busy={props.busy} busyAction={props.busyAction} onGrant={requestGrant} />
      <MemberTable busy={props.busy} busyAction={props.busyAction} members={props.members} principal={props.principal} onRevoke={requestRevoke} onRoleChange={requestRoleChange} />
      {pendingAction ? <ConfirmAclDialog action={pendingAction} busy={props.busy} busyAction={props.busyAction} onCancel={() => setPendingAction(null)} onConfirm={confirmPendingAction} /> : null}
    </section>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4">
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

function AclQuickAction(props: { label: string; enabled: boolean; busy: boolean; actionBusy: boolean; enabledLabel: string; disabledLabel: string; onDisable: () => void; onEnable: () => void }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted">
        {props.label}: {props.enabled ? "enabled" : "disabled"}
      </p>
      <ActionButton disabled={props.busy} loading={props.actionBusy} loadingLabel={props.enabled ? "Disabling..." : "Enabling..."} onClick={props.enabled ? props.onDisable : props.onEnable} variant={props.enabled ? "secondary" : "primary"}>
        {props.enabled ? props.enabledLabel : props.disabledLabel}
      </ActionButton>
    </div>
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
