"use client";

// Where: dashboard database owner controls.
// What: Irreversible database deletion confirmation UI.
// Why: Delete needs stronger confirmation than ordinary ACL changes.

import { useState } from "react";
import { useModalDialog } from "@/components/use-modal-dialog";
import type { BusyAction } from "./access-control";
import { ActionButton } from "./action-button";

export function DatabaseDangerZone(props: {
  activeEntitlementCount: string | null;
  cyclesBalance: string;
  busy: boolean;
  busyAction: BusyAction | null;
  databaseId: string;
  databaseTitle: string;
  onDelete: () => Promise<string | null>;
}) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteDisabled = props.busy;
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
    const error = await props.onDelete();
    if (error) setDeleteError(error);
  }
  return (
    <>
      <section className="rounded-lg border border-red-200 bg-red-50/60 shadow-sm">
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-red-950">Delete database</h3>
            <p className="mt-1 text-sm leading-6 text-red-900">
              This action is irreversible. Archive first if recovery is required.
            </p>
            <p className="mt-2 break-all font-mono text-xs text-red-900">
              {props.databaseTitle} / {props.databaseId}
            </p>
            <DeleteEntitlementNotice count={props.activeEntitlementCount} />
            <DeleteCyclesNotice />
          </div>
          <ActionButton disabled={deleteDisabled} onClick={openDeleteDialog} variant="danger">
            Delete database
          </ActionButton>
        </div>
      </section>
      {deleteDialogOpen ? (
        <ConfirmDeleteDatabaseDialog
          busy={props.busy}
          activeEntitlementCount={props.activeEntitlementCount}
          databaseId={props.databaseId}
          databaseTitle={props.databaseTitle}
          deleting={props.busyAction?.kind === "delete"}
          deleteError={deleteError}
          onCancel={cancelDeleteDialog}
          onConfirm={confirmDelete}
        />
      ) : null}
    </>
  );
}

function ConfirmDeleteDatabaseDialog(props: {
  activeEntitlementCount: string | null;
  busy: boolean;
  databaseId: string;
  databaseTitle: string;
  deleting: boolean;
  deleteError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { dialogRef, handleCancel } = useModalDialog(props.onCancel, props.busy);
  const [typedDatabaseId, setTypedDatabaseId] = useState("");
  const deleteConfirmed = typedDatabaseId === props.databaseId;
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label="Delete database"
      className="fixed inset-0 z-50 m-0 hidden h-full w-full max-h-none max-w-none items-center justify-center border-0 bg-ink/30 px-4 open:flex"
      onCancel={handleCancel}
    >
      <button aria-label="Close delete database dialog" className="absolute inset-0" disabled={props.deleting} tabIndex={-1} type="button" onClick={props.onCancel} />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-lg">
        <h3 className="text-lg font-semibold text-ink">Delete database</h3>
        <p className="mt-3 text-sm leading-6 text-muted">
          Delete {props.databaseTitle}. This action is irreversible. Archive first if recovery is required.
        </p>
        <DeleteEntitlementNotice count={props.activeEntitlementCount} />
        <p className="mt-3 break-all rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-ink">{props.databaseId}</p>
        {props.deleteError ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-900" role="alert">
            {props.deleteError}
          </p>
        ) : null}
        <label className="mt-4 grid gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.12em] text-muted">Type database ID to confirm</span>
          <input
            data-modal-initial-focus
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
    </dialog>
  );
}

function DeleteCyclesNotice() {
  return <p className="mt-3 text-sm leading-6 text-red-900">Remaining cycles will be discarded.</p>;
}

function DeleteEntitlementNotice({ count }: { count: string | null }) {
  if (!count || count === "0") return null;
  return <p className="mt-3 text-sm leading-6 text-red-900">{count} active paid readers will lose marketplace access after deletion.</p>;
}
