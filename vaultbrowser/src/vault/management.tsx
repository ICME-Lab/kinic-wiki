import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { bytes, type VaultClient } from "@kinic/vault-client";
import type { Header } from "@kinic/vault-client/contracts";
import { ArrowLeft, Eraser, Flame, KeyRound } from "lucide-react";
import { VaultButton, VaultField, VaultPanel } from "./ui";
import { StatusPill } from "@kinic/ui/status-pill";
import type { VaultWork } from "./workspace";

export function VaultSettings({
  active = true,
  scope = "vault",
  account,
  client,
  selected,
  vaultName,
  disabled,
  run,
  onChanged,
  onBack,
  onForgetKeys,
}: {
  active?: boolean;
  scope?: "account" | "vault";
  account?: ReactNode;
  client: VaultClient;
  selected?: Header;
  vaultName: string;
  disabled: boolean;
  run: VaultWork;
  onChanged: () => Promise<void>;
  onBack: () => void;
  onForgetKeys?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (active) heading.current?.focus(); }, [active]);
  const vaultKey = selected ? Array.from(bytes(selected.id)).join(",") : "";
  return (
    <section hidden={!active} className="vault-settings" aria-labelledby="vault-settings-title">
      <div className="vault-settings-header">
        <VaultButton tone="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden />Back to Vault
        </VaultButton>
        <h2 id="vault-settings-title" ref={heading} tabIndex={-1}>{scope === "account" ? "Account settings" : selected ? `${vaultName} settings` : "Vault settings"}</h2>
      </div>
      <div hidden={scope !== "account"}>{account}</div>
      {active ? <>
      {scope === "account" ? <SettingsGroup title="Maintenance">
        <VaultPanel label="Maintenance" className="vault-settings-list">
          <SettingRow
            icon={<KeyRound size={16} />}
            title="Saved browser keys"
            description="Removing saved keys closes any open Vault on this browser. Opening your Vaults again may require a paid key retrieval. Your documents are kept."
            action={
              <VaultButton size="sm" disabled={disabled} onClick={onForgetKeys ?? (() => run(() => client.forgetDeviceKeys()))}>
                Delete saved keys from this browser
              </VaultButton>
            }
          />
          <StorageMaintenance client={client} disabled={disabled} run={run} onChanged={onChanged} />
        </VaultPanel>
      </SettingsGroup> : null}
      {scope === "vault" && selected ? (
        <SettingsGroup title="Danger zone" danger>
          <VaultPanel label="Danger zone" className="vault-settings-list vault-danger-zone">
            <VaultDeletion key={vaultKey} client={client} selected={selected} vaultName={vaultName} disabled={disabled} run={run} onChanged={onChanged} />
          </VaultPanel>
        </SettingsGroup>
      ) : scope === "vault" ? <p className="vault-setting-empty">Choose a Vault from its actions menu to manage it.</p> : null}
      </> : null}
    </section>
  );
}

function SettingsGroup({ title, danger = false, children }: { title: string; danger?: boolean; children: ReactNode }) {
  return (
    <div className={`vault-settings-group${danger ? " vault-settings-group--danger" : ""}`}>
      <h3 className="vault-settings-group-title">{title}</h3>
      {children}
    </div>
  );
}

function SettingRow({ icon, title, description, action, children, sensitive = false }: {
  icon?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  sensitive?: boolean;
}) {
  return (
    <div className="vault-setting-row" data-vault-sensitive={sensitive ? "true" : undefined}>
      <div className="vault-setting-text">
        <h4>{icon ? <span aria-hidden>{icon}</span> : null}{title}</h4>
        <p>{description}</p>
      </div>
      {action ? <div className="vault-setting-action">{action}</div> : null}
      {children ? <div className="vault-setting-extra">{children}</div> : null}
    </div>
  );
}

function StorageMaintenance({ client, disabled, run, onChanged }: {
  client: VaultClient;
  disabled: boolean;
  run: VaultWork;
  onChanged: () => Promise<void>;
}) {
  const [progress, setProgress] = useState("");
  return (
    <SettingRow
      icon={<Eraser size={16} />}
      title="Storage maintenance"
      description="Unused storage is cleaned up automatically. You can also remove expired uploads and older versions beyond the history limit now. Current documents are kept."
      action={
        <VaultButton size="sm" disabled={disabled} onClick={() => run(async () => {
          const ticket = client.session.capture();
          await client.collect();
          client.session.check(ticket);
          setProgress("Storage maintenance complete");
          await onChanged();
        })}>
          Free up unused storage
        </VaultButton>
      }
    >
      {progress ? <output><StatusPill tone="positive" label={progress} /></output> : null}
    </SettingRow>
  );
}

function VaultDeletion({ client, selected, vaultName, disabled, run, onChanged }: {
  client: VaultClient;
  selected: Header;
  vaultName: string;
  disabled: boolean;
  run: VaultWork;
  onChanged: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  return (
    <SettingRow
      icon={<Flame size={16} />}
      title={`Delete ${vaultName}`}
      description={`This permanently deletes ${vaultName}, all its documents and every saved version. This cannot be undone.`}
    >
      <div className="vault-confirm-row">
        <VaultField
          label={`Type ${vaultName} to confirm`}
          value={confirmation}
          disabled={disabled}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <VaultButton size="sm" tone="danger" disabled={disabled || confirmation !== vaultName} onClick={() => {
          if (disabled || confirmation !== vaultName) return;
          run(async () => {
            const ticket = client.session.capture();
            try {
              await client.deleteVault(bytes(selected.id));
            } catch (cause) {
              client.session.check(ticket);
              if (cause instanceof Error && ["Conflict", "NotFound"].includes(cause.message)) await onChanged();
              throw cause;
            }
            await onChanged();
          });
        }}>
          Permanently delete this Vault
        </VaultButton>
      </div>
    </SettingRow>
  );
}
