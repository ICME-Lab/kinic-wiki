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
    <VaultPanel label="Recovery secret setup" sensitive>
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
            const data = client.recoveryKit(kit);
            try {
              client.session.download(data, "vault-recovery-kit.json");
            } finally {
              data.fill(0);
            }
          })
        }
      >
        Download recovery kit
      </VaultButton>
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
        Confirm and activate Vault
      </VaultButton>
    </VaultPanel>
  );
}
