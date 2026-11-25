import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useModalDialog } from "@kinic/ui/use-modal-dialog";
import { VaultButton } from "./ui";

export type ConfirmOptions = {
  title: string;
  description: ReactNode;
  /** Distinct from the trigger label so the dialog's action is unambiguous. */
  confirmLabel: string;
};
type Pending = ConfirmOptions & { resolve: (confirmed: boolean) => void };

/**
 * Asks before a destructive action. Resolves false on Cancel, Escape, a newer
 * request, or unmount, so the caller runs the action only on an explicit yes.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);
  const current = useRef<Pending | null>(null);
  useEffect(() => () => {
    current.current?.resolve(false);
    current.current = null;
  }, []);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    current.current?.resolve(false);
    const next = { ...options, resolve };
    current.current = next;
    setPending(next);
  }), []);
  const finish = useCallback((confirmed: boolean) => {
    const request = current.current;
    current.current = null;
    setPending(null);
    request?.resolve(confirmed);
  }, []);
  const dialog = pending ? <ConfirmDialog request={pending} finish={finish} /> : null;
  return [confirm, dialog];
}

function ConfirmDialog({ request, finish }: { request: ConfirmOptions; finish: (confirmed: boolean) => void }) {
  const id = useId();
  const { dialogRef, handleCancel } = useModalDialog(() => finish(false), false);
  return (
    <dialog
      ref={dialogRef}
      onCancel={handleCancel}
      className="vault-confirm-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
    >
      <h2 id={`${id}-title`}>{request.title}</h2>
      <p id={`${id}-description`}>{request.description}</p>
      <div className="vault-confirm-actions">
        <VaultButton data-modal-initial-focus onClick={() => finish(false)}>Cancel</VaultButton>
        <VaultButton tone="danger" onClick={() => finish(true)}>{request.confirmLabel}</VaultButton>
      </div>
    </dialog>
  );
}
