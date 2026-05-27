"use client";

// Where: dashboard database owner controls.
// What: Irreversible database deletion confirmation UI.
// Why: Delete needs stronger confirmation than ordinary ACL changes.

import { useState } from "react";
import type { BusyAction } from "./access-control";
import { ActionButton } from "./action-button";

export function DatabaseDangerZone(props: {
  busy: boolean;
  busyAction: BusyAction | null;
  databaseId: string;
  databaseName: string;
  onDelete: () => Promise<string | null>;
}) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
      <div className="grid gap-3 border-t border-red-200 bg-red-50/60 p-4">
        <div>
          <h3 className="text-sm font-semibold text-red-950">Delete database</h3>
          <p className="mt-1 text-sm leading-6 text-red-900">
            This action is irreversible. Archive first if recovery is required.
          </p>
          <p className="mt-2 break-all font-mono text-xs text-red-900">
            {props.databaseName} / {props.databaseId}
          </p>
        </div>
        <div>
          <ActionButton disabled={props.busy} onClick={openDeleteDialog} variant="danger">
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
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typedDatabaseId, setTypedDatabaseId] = useState("");
  const deleteConfirmed = typedDatabaseId === props.databaseId;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-lg">
        <h3 className="text-lg font-semibold text-ink">Delete database</h3>
        <p className="mt-3 text-sm leading-6 text-muted">
          Delete {props.databaseName}. This action is irreversible. Archive first if recovery is required.
        </p>
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
