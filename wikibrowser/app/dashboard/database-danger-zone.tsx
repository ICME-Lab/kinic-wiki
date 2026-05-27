"use client";

// Where: dashboard database owner controls.
// What: Irreversible database deletion confirmation UI.
// Why: Delete needs stronger confirmation than ordinary ACL changes.

import { useState } from "react";
import Link from "next/link";
import type { BusyAction } from "./access-control";
import { ActionButton } from "./action-button";
import { formatTokenAmountFromE8s } from "@/lib/token-amount";

const DELETE_BALANCE_WRITEOFF_LIMIT_E8S = 100_000_000n;

export function DatabaseDangerZone(props: {
  billingBalanceE8s: string;
  busy: boolean;
  busyAction: BusyAction | null;
  databaseId: string;
  databaseName: string;
  pendingOperationCount: number;
  onDelete: (allowBalanceWriteoff: boolean) => Promise<string | null>;
}) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const balanceE8s = parseE8s(props.billingBalanceE8s);
  const hasPendingOperations = props.pendingOperationCount > 0;
  const hasWithdrawableBalance = balanceE8s >= DELETE_BALANCE_WRITEOFF_LIMIT_E8S;
  const hasWriteoffBalance = balanceE8s > 0n && balanceE8s < DELETE_BALANCE_WRITEOFF_LIMIT_E8S;
  const deleteDisabled = props.busy || hasPendingOperations || hasWithdrawableBalance;
  function openDeleteDialog() {
    setDeleteError(null);
    setDeleteDialogOpen(true);
  }
  function cancelDeleteDialog() {
    setDeleteError(null);
    setDeleteDialogOpen(false);
  }
  async function confirmDelete() {
    setDeleteError(null);
    const error = await props.onDelete(hasWriteoffBalance);
    if (error) setDeleteError(error);
  }
  return (
    <>
      <div className="grid gap-3 border-t border-red-200 bg-red-50/60 p-4">
        <div>
          <h3 className="text-sm font-semibold text-red-950">Delete database</h3>
          <p className="mt-1 text-sm leading-6 text-red-900">
            This action is irreversible. Archive first if recovery is required.
          </p>
          <p className="mt-2 break-all font-mono text-xs text-red-900">
            {props.databaseName} / {props.databaseId}
          </p>
          <DeleteBillingNotice balanceE8s={balanceE8s} pendingOperationCount={props.pendingOperationCount} />
        </div>
        <div>
          <ActionButton disabled={deleteDisabled} onClick={openDeleteDialog} variant="danger">
            Delete database
          </ActionButton>
        </div>
      </div>
      {deleteDialogOpen ? (
        <ConfirmDeleteDatabaseDialog
          busy={props.busy}
          databaseId={props.databaseId}
          databaseName={props.databaseName}
          deleting={props.busyAction?.kind === "delete"}
          deleteError={deleteError}
          writeoffAmountE8s={hasWriteoffBalance ? balanceE8s : 0n}
          onCancel={cancelDeleteDialog}
          onConfirm={confirmDelete}
        />
      ) : null}
    </>
  );
}

function ConfirmDeleteDatabaseDialog(props: {
  busy: boolean;
  databaseId: string;
  databaseName: string;
  deleting: boolean;
  deleteError: string | null;
  writeoffAmountE8s: bigint;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typedDatabaseId, setTypedDatabaseId] = useState("");
  const [writeoffConfirmed, setWriteoffConfirmed] = useState(false);
  const requiresWriteoffConsent = props.writeoffAmountE8s > 0n;
  const deleteConfirmed = typedDatabaseId === props.databaseId && (!requiresWriteoffConsent || writeoffConfirmed);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-lg">
        <h3 className="text-lg font-semibold text-ink">Delete database</h3>
        <p className="mt-3 text-sm leading-6 text-muted">
          Delete {props.databaseName}. This action is irreversible. Archive first if recovery is required.
        </p>
        {requiresWriteoffConsent ? (
          <label className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950">
            <input className="mt-1 h-4 w-4" type="checkbox" checked={writeoffConfirmed} onChange={(event) => setWriteoffConfirmed(event.target.checked)} />
            <span>Write off the remaining {formatTokenAmountFromE8s(props.writeoffAmountE8s)} balance and delete this database.</span>
          </label>
        ) : null}
        <p className="mt-3 break-all rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-ink">{props.databaseId}</p>
        {props.deleteError ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-900" role="alert">
            {props.deleteError}
          </p>
        ) : null}
        <label className="mt-4 grid gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.12em] text-muted">Type database ID to confirm</span>
          <input
            className="rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
            value={typedDatabaseId}
            onChange={(event) => setTypedDatabaseId(event.target.value)}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <ActionButton disabled={props.busy} onClick={props.onCancel} variant="secondary">
            Cancel
          </ActionButton>
          <ActionButton disabled={props.busy || !deleteConfirmed} loading={props.deleting} loadingLabel="Deleting..." onClick={props.onConfirm} variant="danger">
            Delete database
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function DeleteBillingNotice({ balanceE8s, pendingOperationCount }: { balanceE8s: bigint; pendingOperationCount: number }) {
  if (pendingOperationCount > 0) {
    return (
      <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-900">
        Resolve pending billing operations before deleting. Pending operations: {pendingOperationCount}
      </p>
    );
  }
  if (balanceE8s >= DELETE_BALANCE_WRITEOFF_LIMIT_E8S) {
    return (
      <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-900">
        Withdraw balance before deleting. Current balance: {formatTokenAmountFromE8s(balanceE8s)}.{" "}
        <Link className="font-semibold text-red-950 underline" href="/cli">
          Withdraw with CLI
        </Link>
      </p>
    );
  }
  if (balanceE8s > 0n) {
    return (
      <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950">
        Remaining dust balance {formatTokenAmountFromE8s(balanceE8s)} can be written off during deletion.
      </p>
    );
  }
  return <p className="mt-3 text-sm leading-6 text-red-900">Billing balance is 0 KINIC.</p>;
}

function parseE8s(value: string): bigint {
  return /^[0-9]+$/.test(value) ? BigInt(value) : 0n;
}
