import { useCallback, useLayoutEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Flame, Pencil, Trash2 } from "lucide-react";
import type { Item, VaultClient } from "@kinic/vault-client";
import { useModalDialog } from "@kinic/ui/use-modal-dialog";
import { VaultButton, VaultField } from "./ui";

export function DocumentActions({ item, client, disabled, writesDisabled, canPurge, onRename, onDelete }: {
  item: Item;
  client: VaultClient;
  disabled: boolean;
  writesDisabled: boolean;
  canPurge: boolean;
  onRename: (item: Item, name: string) => void;
  onDelete: (item: Item, permanent: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"rename" | "delete" | "purge">();
  const requested = useRef<typeof mode>(undefined);
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
      requested.current = undefined;
      setOpen(false);
      setMode(undefined);
    });
    return () => { detach(); };
  }, [client]);
  const request = (action: NonNullable<typeof mode>) => {
    requested.current = action;
  };
  const writeBlocked = disabled || writesDisabled || item.revision.deleted;
  return <>
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button ref={trigger} type="button" className="vault-button vault-button--ghost vault-document-more" aria-label={`Actions for ${name}`} title={`Actions for ${name}`} disabled={disabled}>
          <Ellipsis size={17} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="vault-document-menu" align="end" sideOffset={4} onCloseAutoFocus={(event) => {
          const action = requested.current;
          if (!action) return;
          event.preventDefault();
          requested.current = undefined;
          confirming.current = true;
          setMode(action);
        }}>
          <DropdownMenu.Item className="vault-document-menu-item" disabled={writeBlocked} onSelect={() => request("rename")}>
            <Pencil size={14} aria-hidden />Change name
          </DropdownMenu.Item>
          <DropdownMenu.Item className="vault-document-menu-item" disabled={writeBlocked} onSelect={() => request("delete")}>
            <Trash2 size={14} aria-hidden />Delete document
          </DropdownMenu.Item>
          {canPurge ? <>
            <DropdownMenu.Separator className="vault-document-menu-separator" />
            <DropdownMenu.Item className="vault-document-menu-item" disabled={disabled} onSelect={() => request("purge")}>
              <Flame size={14} aria-hidden />Permanently delete document and history
            </DropdownMenu.Item>
          </> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {mode === "rename" ? (
      <DocumentNameDialog
        client={client}
        title={item.metadata.title}
        disabled={writeBlocked}
        onCancel={cancel}
        onSave={(name) => {
          if (!confirming.current) return;
          cancel();
          onRename(item, name);
        }}
      />
    ) : null}
    {mode === "delete" || (mode === "purge" && canPurge) ? <DocumentDeletionDialog key={mode} item={item} client={client} permanent={mode === "purge"} disabled={mode === "delete" ? writeBlocked : disabled} onCancel={cancel} onDelete={() => { if (!confirming.current) return; cancel(); onDelete(item, mode === "purge"); }} /> : null}
  </>;
}

function DocumentNameDialog({ client, title, disabled, onCancel, onSave }: {
  client: VaultClient;
  title: string;
  disabled: boolean;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(title);
  const { dialogRef, handleCancel } = useModalDialog(onCancel, false);
  const name = value.trim();
  const valid = !disabled && name.length > 0 && name.length <= 512 && name !== title;
  useLayoutEffect(() => {
    const detach = client.session.addLockCleanup(() => {
      const dialog = dialogRef.current;
      const input = dialog?.querySelector("input");
      if (input) {
        input.value = "";
        input.removeAttribute("value");
      }
      dialog?.close();
    });
    return () => { detach(); };
  }, [client, dialogRef]);
  return (
    <dialog ref={dialogRef} onCancel={handleCancel} className="vault-confirm-dialog vault-document-confirmation" aria-label="Change document name" data-vault-sensitive="true">
      <h2>Change document name</h2>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(name);
      }}>
        <VaultField label="Document name" placeholder="Untitled" value={value} maxLength={512} disabled={disabled} onChange={(event) => setValue(event.target.value)} />
        <div className="vault-disclosure-actions">
          <VaultButton onClick={onCancel}>Cancel</VaultButton>
          <VaultButton type="submit" tone="primary" disabled={!valid}>Save name</VaultButton>
        </div>
      </form>
    </dialog>
  );
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
