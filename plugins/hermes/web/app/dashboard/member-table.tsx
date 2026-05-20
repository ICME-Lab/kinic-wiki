"use client";

// Where: wikibrowser/app/dashboard/member-table.tsx
// What: Database member role table with owner edit mode and public read-only mode.
// Why: Public dashboards should expose access state without granting management controls.

import { useState } from "react";
import { ActionButton } from "./action-button";
import { ANONYMOUS_PRINCIPAL, DATABASE_ROLES, databaseRoleFromValue, isBusyGrant, isBusyRevoke, principalDisplayName, type BusyAction } from "./access-control";
import type { DatabaseMember, DatabaseRole } from "@/lib/types";

export function MemberTable(props: {
  busy: boolean;
  busyAction: BusyAction | null;
  members: DatabaseMember[];
  principal: string;
  readOnly?: boolean;
  onRevoke: (member: DatabaseMember) => void;
  onRoleChange: (member: DatabaseMember, role: DatabaseRole) => void;
}) {
  if (props.members.length === 0) {
    return <div className="p-6 text-sm text-muted">No members.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-white/70 text-xs uppercase tracking-[0.12em] text-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Principal</th>
            <th className="px-4 py-3 font-medium">Role</th>
            {props.readOnly ? null : <th className="px-4 py-3 font-medium">Created</th>}
            {props.readOnly ? null : <th className="px-4 py-3 font-medium">Revoke</th>}
          </tr>
        </thead>
        <tbody>
          {props.members.map((member) => (
            <MemberRow
              key={member.principal}
              busy={props.busy}
              busyAction={props.busyAction}
              member={member}
              principal={props.principal}
              readOnly={props.readOnly ?? false}
              onRevoke={props.onRevoke}
              onRoleChange={props.onRoleChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow(props: {
  busy: boolean;
  busyAction: BusyAction | null;
  member: DatabaseMember;
  principal: string;
  readOnly: boolean;
  onRevoke: (member: DatabaseMember) => void;
  onRoleChange: (member: DatabaseMember, role: DatabaseRole) => void;
}) {
  const [role, setRole] = useState<DatabaseRole>(props.member.role);
  const ownMember = props.member.principal === props.principal;
  const anonymousMember = props.member.principal === ANONYMOUS_PRINCIPAL;
  const revokeBusy = isBusyRevoke(props.busyAction, props.member.principal);
  const roleBusy = isBusyGrant(props.busyAction, props.member.principal, role);
  const changed = role !== props.member.role;
  return (
    <tr className={`border-t border-line ${revokeBusy || roleBusy ? "bg-accentSoft/70" : ""}`}>
      <td className="px-4 py-3 font-mono text-xs text-ink">{principalDisplayName(props.member.principal)}</td>
      <td className="px-4 py-3">
        {props.readOnly ? (
          <span className="text-sm text-ink">{props.member.role}</span>
        ) : (
          <div className="flex min-w-[210px] items-center gap-2">
            <select
              className="rounded-lg border border-line px-2 py-1.5 text-sm"
              disabled={props.busy || ownMember || anonymousMember}
              value={role}
              onChange={(event) => setRole(databaseRoleFromValue(event.target.value))}
            >
              {DATABASE_ROLES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <ActionButton disabled={props.busy || ownMember || anonymousMember || !changed} loading={roleBusy} loadingLabel="Saving..." onClick={() => props.onRoleChange(props.member, role)} size="compact" variant="primary">
              Save
            </ActionButton>
          </div>
        )}
      </td>
      {props.readOnly ? null : <td className="px-4 py-3 text-muted">{formatTimestamp(props.member.createdAtMs)}</td>}
      {props.readOnly ? null : (
        <td className="px-4 py-3">
          <ActionButton disabled={props.busy || ownMember} loading={revokeBusy} loadingLabel="Revoking..." onClick={() => props.onRevoke(props.member)} size="compact" variant="secondary">
            Revoke
          </ActionButton>
        </td>
      )}
    </tr>
  );
}

function formatTimestamp(value: string): string {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString() : value;
}
