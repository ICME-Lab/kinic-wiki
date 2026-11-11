import { useState } from "react";
import type { VaultClient } from "@kinic/vault-client";
import { VaultButton, VaultField, VaultPanel } from "./ui";
import type { VaultWork } from "./workspace";
export function VaultSetup({
  client,
  kit,
  disabled,
  run,
  onActivated,
}: {
  client: VaultClient;
  kit: Awaited<ReturnType<VaultClient["createKit"]>>;
  disabled: boolean;
  run: VaultWork;
  onActivated: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  return (
    <VaultPanel label="Recovery secret setup">
      <h2 className="font-semibold">Save your recovery secret</h2>
      <p className="text-sm text-muted">
        Store it separately from your encrypted backup, then re-enter it to
        confirm. This secret alone cannot recover the Vault.
      </p>
      <output
        aria-label="New recovery secret"
        className="break-all rounded-lg border border-line p-3 font-mono text-sm"
      >
        {kit.secret}
      </output>
      <VaultButton
        disabled={disabled}
        onClick={() =>
          run(async () => {
            await navigator.clipboard.writeText(kit.secret);
          })
        }
      >
        Copy recovery secret
      </VaultButton>
      <p className="text-sm text-muted">
        The clipboard is not cleared automatically.
      </p>
      <VaultField
        label="Re-enter saved recovery secret"
        type="password"
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
      />
      <VaultButton
        disabled={disabled || !confirmation}
        onClick={() =>
          run(async () => {
            const pending = client.activate(kit, confirmation);
            setConfirmation("");
            await pending;
            client.session.check(kit.generation);
            await onActivated();
          })
        }
      >
        Confirm and register passkey
      </VaultButton>
    </VaultPanel>
  );
}
export function VaultRestore({
  client,
  disabled,
  run,
  onRestored,
}: {
  client: VaultClient;
  disabled: boolean;
  run: VaultWork;
  onRestored: () => Promise<void>;
}) {
  const [file, setFile] = useState<File>();
  const [secret, setSecret] = useState("");
  return (
    <details className="min-w-0 text-sm [&:not([open])>div]:hidden">
      <summary className="cursor-pointer font-medium">
        Restore encrypted backup
      </summary>
      <div className="mt-3 grid min-w-0 gap-3">
        <p className="text-muted">
          Restore to a new Vault. Existing Vaults are never overwritten.
        </p>
        <VaultField
          label="Backup file"
          type="file"
          accept=".kvault"
          onChange={(e) => setFile(e.target.files?.[0])}
        />
        <VaultField
          label="Restore recovery secret"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <VaultButton
          disabled={disabled || !file || !secret}
          onClick={() =>
            run(async () => {
              if (!file || file.size > 256 * 1024 * 1024)
                throw Error("SizeLimit");
              client.session.lock();
              const g = client.session.capture();
              const secretText = secret;
              setSecret("");
              const data = new Uint8Array(await file.arrayBuffer());
              client.session.check(g);
              const pending = client.restore(data, secretText, false);
              const restoring = client.session.capture();
              try {
                await pending;
                client.session.check(restoring);
                await onRestored();
              } finally {
                data.fill(0);
              }
            })
          }
        >
          Verify and restore
        </VaultButton>
      </div>
    </details>
  );
}
