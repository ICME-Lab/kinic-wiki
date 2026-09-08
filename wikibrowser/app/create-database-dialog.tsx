"use client";

// Home dashboard database creation dialog: collect the display name before creating a DB.

import { Plus, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useModalDialog } from "@/components/use-modal-dialog";
export function CreateDatabaseDialog({
  createDisabled,
  createLabel,
  creating,
  databaseName,
  fundingSourceContent,
  fundingRequired,
  open,
  requiredBalanceLabel,
  validationError,
  onCancel,
  onChange,
  onSubmit
}: {
  createDisabled: boolean;
  createLabel: string;
  creating: boolean;
  databaseName: string;
  fundingSourceContent: ReactNode;
  fundingRequired: boolean;
  open: boolean;
  requiredBalanceLabel: string;
  validationError: string | null;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { dialogRef, handleCancel } = useModalDialog(onCancel, creating, open);
  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createDisabled) return;
    onSubmit();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label="Create database"
      className="fixed inset-0 z-50 m-0 hidden h-full w-full max-h-none max-w-none items-center justify-center border-0 bg-ink/30 px-4 open:flex"
      onCancel={handleCancel}
    >
      <button aria-label="Close create database dialog" className="absolute inset-0" disabled={creating} tabIndex={-1} type="button" onClick={onCancel} />
      <form className="relative z-10 w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-lg" onSubmit={submit}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-ink">Create database</h3>
            {!fundingRequired ? (
              <p className="mt-2 text-sm leading-6 text-muted">
                Includes an initial free grant of {requiredBalanceLabel}. No KINIC payment is required.
              </p>
            ) : null}
          </div>
          <button aria-label="Close" className="rounded-lg border border-line bg-white p-2 text-muted hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-60" disabled={creating} type="button" onClick={onCancel}>
            <X aria-hidden size={16} />
          </button>
        </div>
        <div className="mt-5 grid gap-2">
          <label className="text-xs uppercase tracking-[0.12em] text-muted" htmlFor="database-name-input">
            Database name
          </label>
          <input
            data-modal-initial-focus
            id="database-name-input"
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            maxLength={80}
            placeholder="Team skills"
            type="text"
            value={databaseName}
            onChange={(event) => onChange(event.target.value)}
          />
          <p className="text-xs leading-5 text-muted">Use 1..80 characters. The name can be changed later.</p>
          {databaseName.trim().length > 0 && validationError ? <p className="text-xs text-red-700">{validationError}</p> : null}
        </div>
        {fundingRequired ? <div className="mt-5">{fundingSourceContent}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink hover:border-accent disabled:cursor-not-allowed disabled:opacity-60" disabled={creating} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            aria-busy={creating || undefined}
            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
            disabled={createDisabled}
            type="submit"
          >
            <Plus aria-hidden size={15} />
            <span>{creating ? "Creating..." : createLabel}</span>
          </button>
        </div>
      </form>
    </dialog>
  );
}
