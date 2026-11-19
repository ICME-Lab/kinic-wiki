import { useCallback, useLayoutEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Pencil, Settings, Users } from "lucide-react";
import { isValidVaultName, type VaultClient } from "@kinic/vault-client";
import type { Header } from "@kinic/vault-client/contracts";
import { useModalDialog } from "@kinic/ui/use-modal-dialog";
import { VaultButton, VaultField } from "./ui";

export const vaultDisplayName = (header: Header, fallback: string) => header.name?.[0] || fallback;

export function VaultActions({ header, fallback, client, disabled, canRename, onRename, onSettings }: {
  header: Header;
  fallback: string;
  client: VaultClient;
  disabled: boolean;
  canRename: boolean;
  onRename: (name: string) => void;
  onSettings: (members: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const editingRef = useRef(false);
  const openingSettings = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = vaultDisplayName(header, fallback);
  const cancel = useCallback(() => {
    editingRef.current = false;
    setEditing(false);
    queueMicrotask(() => trigger.current?.focus());
  }, []);
  useLayoutEffect(() => {
    const detach = client.session.addLockCleanup(() => { editingRef.current = false; setEditing(false); setOpen(false); });
    return () => { detach(); };
  }, [client]);
  return <>
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button ref={trigger} type="button" className="vault-button vault-button--ghost vault-vault-more" id={`vault-actions-${Array.from(header.id).join("-")}`} aria-label={`Actions for ${name}`} title={`Actions for ${name}`} disabled={disabled}>
          <Ellipsis size={17} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="vault-document-menu" align="end" sideOffset={4} onCloseAutoFocus={event => {
          if (editingRef.current || openingSettings.current) event.preventDefault();
          if (openingSettings.current) requestAnimationFrame(() => document.getElementById("vault-settings-title")?.focus());
          openingSettings.current = false;
        }}>
          <DropdownMenu.Item className="vault-document-menu-item" disabled={disabled} onSelect={() => { openingSettings.current = true; onSettings(false); }}>
            <Settings size={14} aria-hidden />Vault settings
          </DropdownMenu.Item>
          {"Active" in header.state ? (
            <DropdownMenu.Item className="vault-document-menu-item" disabled={disabled} onSelect={() => { openingSettings.current = true; onSettings(true); }}>
              <Users size={14} aria-hidden />Manage members
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className="vault-document-menu-item vault-rename-item" disabled={disabled || !canRename || !("Active" in header.state)} onSelect={() => { editingRef.current = true; setEditing(true); }}>
            <Pencil size={14} aria-hidden />Rename Vault
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {editing ? <RenameDialog client={client} name={name} onCancel={cancel} onSave={value => { if (!editingRef.current) return; cancel(); onRename(value); }} /> : null}
  </>;
}

function RenameDialog({ client, name, onSave, onCancel }: { client: VaultClient; name: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(name);
  const live = useRef(true);
  const { dialogRef, handleCancel } = useModalDialog(onCancel, false);
  const trimmed = value.trim();
  const valid = isValidVaultName(trimmed);
  useLayoutEffect(() => {
    live.current = true;
    const detach = client.session.addLockCleanup(() => {
      live.current = false;
      const input = dialogRef.current?.querySelector("input");
      if (input) input.value = "";
      dialogRef.current?.close();
      onCancel();
    });
    return () => { live.current = false; detach(); };
  }, [client, dialogRef, onCancel]);
  return <dialog ref={dialogRef} onCancel={handleCancel} className="vault-confirm-dialog" aria-label="Rename Vault" data-vault-sensitive="true">
    <h2>Rename Vault</h2>
    <VaultField label="Vault name" value={value} onChange={event => setValue(event.target.value)} />
    <p className="vault-field-hint">Use up to 64 characters. Vault names are not encrypted.</p>
    <div className="vault-disclosure-actions">
      <VaultButton onClick={onCancel}>Cancel</VaultButton>
      <VaultButton tone="primary" disabled={!valid || trimmed === name} onClick={() => { if (live.current && valid && trimmed !== name) onSave(trimmed); }}>Save name</VaultButton>
    </div>
  </dialog>;
}
