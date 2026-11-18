import { useCallback, useLayoutEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Flame, Trash2 } from "lucide-react";
import type { Item, VaultClient } from "@kinic/vault-client";
import { useModalDialog } from "@kinic/ui/use-modal-dialog";
import { VaultButton, VaultField } from "./ui";

export function DocumentActions({ item, client, disabled, writesDisabled, onDelete }: {
  item: Item;
  client: VaultClient;
  disabled: boolean;
  writesDisabled: boolean;
  onDelete: (item: Item, permanent: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"delete" | "purge">();
  const confirming = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = item.metadata.title || "Untitled";
  const cancel = useCallback(() => {
    confirming.current = false;
    setMode(undefined);
    queueMicrotask(() => trigger.current?.focus());
  }, []);
  useLayoutEffect(() => {
    const detach = client.session.addLockCleanup(() => {
      confirming.current = false;
      setOpen(false);
      setMode(undefined);
    });
    return () => { detach(); };
  }, [client]);
  const request = (permanent: boolean) => {
    confirming.current = true;
    setMode(permanent ? "purge" : "delete");
  };
  return <>
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button ref={trigger} type="button" className="vault-button vault-button--ghost vault-document-more" aria-label={`Actions for ${name}`} title={`Actions for ${name}`} disabled={disabled}>
          <Ellipsis size={17} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="vault-document-menu" align="end" sideOffset={4} onCloseAutoFocus={event => { if (confirming.current) event.preventDefault(); }}>
          <DropdownMenu.Item className="vault-document-menu-item" disabled={disabled || writesDisabled || item.revision.deleted} onSelect={() => request(false)}>
            <Trash2 size={14} aria-hidden />Delete document
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="vault-document-menu-separator" />
          <DropdownMenu.Item className="vault-document-menu-item" disabled={disabled} onSelect={() => request(true)}>
            <Flame size={14} aria-hidden />Permanently delete document and history
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {mode ? <DocumentDeletionDialog key={mode} item={item} client={client} permanent={mode === "purge"} disabled={disabled} onCancel={cancel} onDelete={() => { if (!confirming.current) return; cancel(); onDelete(item, mode === "purge"); }} /> : null}
  </>;
}

function DocumentDeletionDialog({ item, client, permanent, disabled, onCancel, onDelete }: {
  item: Item;
  client: VaultClient;
  permanent: boolean;
  disabled: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const live = useRef(true);
  const { dialogRef, handleCancel } = useModalDialog(onCancel, disabled);
  const action = permanent ? "Permanently delete document and history" : "Delete document";
  useLayoutEffect(() => {
    live.current = true;
    const detach = client.session.addLockCleanup(() => {
      live.current = false;
      const dialog = dialogRef.current;
      if (dialog) {
        dialog.querySelectorAll("input").forEach(input => { input.value = ""; });
        dialog.querySelectorAll("h2, p, label > span").forEach(node => { node.textContent = ""; });
        dialog.close();
      }
      onCancel();
    });
    return () => { live.current = false; detach(); };
  }, [client, dialogRef, onCancel]);
  return <dialog ref={dialogRef} onCancel={handleCancel} className="vault-confirm-dialog vault-document-confirmation" aria-label={action} data-vault-sensitive="true">
    <h2>{action}</h2>
    <p>{permanent ? `This permanently deletes ${item.metadata.title || "Untitled"} and every saved version. This cannot be undone.` : `Delete ${item.metadata.title || "Untitled"}? Saved versions remain available in version history.`}</p>
    <VaultField label="Type delete to confirm" value={confirmation} disabled={disabled} onChange={event => setConfirmation(event.target.value)} />
    <div className="vault-disclosure-actions">
      <VaultButton data-modal-initial-focus disabled={disabled} onClick={onCancel}>Cancel</VaultButton>
      <VaultButton tone="danger" disabled={disabled || confirmation !== "delete"} onClick={() => { if (live.current && !disabled && confirmation === "delete") onDelete(); }}>{action}</VaultButton>
    </div>
  </dialog>;
}
