"use client";

// Home dashboard database creation dialog: collect the display name before creating a DB.

import { Plus, X } from "lucide-react";
import type { FormEvent } from "react";

export function CreateDatabaseDialog({
  createDisabled,
  creating,
  databaseName,
  open,
  validationError,
  onCancel,
  onChange,
  onSubmit
}: {
  createDisabled: boolean;
  creating: boolean;
  databaseName: string;
  open: boolean;
  validationError: string | null;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createDisabled) return;
    onSubmit();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-4">
      <form aria-modal="true" className="w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-lg" role="dialog" onSubmit={submit}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-ink">Create database</h3>
            <p className="mt-2 text-sm leading-6 text-muted">A generated database ID will be used for routes and access.</p>
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
            <span>{creating ? "Creating..." : "Create"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
