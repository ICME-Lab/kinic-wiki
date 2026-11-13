import { useState } from "react";
import { bytes, type VaultClient } from "@kinic/vault-client";
import type { Header } from "@kinic/vault-client/contracts";
import { VaultButton, VaultPanel } from "./ui";
import type { VaultWork } from "./workspace";

export function VaultEncryptedCleanup({
  client,
  selected,
  disabled,
  run,
  onChanged,
}: {
  client: VaultClient;
  selected: Header;
  disabled: boolean;
  run: VaultWork;
  onChanged: () => Promise<void>;
}) {
  const [progress, setProgress] = useState("");
  return (
    <VaultPanel label="Encrypted storage cleanup">
      <details className="[&:not([open])>div]:hidden">
        <summary className="cursor-pointer font-semibold">
          Encrypted storage cleanup
        </summary>
        <div className="mt-3 grid min-w-0 gap-3 text-sm">
          <p>
            Cleanup uses your current Internet Identity and remains available
            with zero prepaid balance. Full purge permanently deletes this Vault
            and every version.
          </p>
          <p>If interrupted, select the same action to resume cleanup.</p>
          <VaultButton
            disabled={disabled}
            onClick={() =>
              run(async () => {
                const ticket = client.session.capture();
                await client.collect();
                client.session.check(ticket);
                setProgress("Cleanup complete");
                await onChanged();
              })
            }
          >
            Collect expired data
          </VaultButton>
          <VaultButton
            disabled={disabled}
            onClick={() => {
              if (
                !window.confirm(
                  "Permanently purge this Vault and all its history? This cannot be undone.",
                )
              )
                return;
              run(async () => {
                const ticket = client.session.capture();
                try {
                  await client.deleteVault(bytes(selected.id));
                } catch (cause) {
                  client.session.check(ticket);
                  if (
                    cause instanceof Error &&
                    ["Conflict", "NotFound"].includes(cause.message)
                  )
                    await onChanged();
                  throw cause;
                }
                // deleteVault intentionally closes the selected context when done.
                await onChanged();
              });
            }}
          >
            Permanently purge entire Vault
          </VaultButton>
          {progress ? <output>{progress}</output> : null}
        </div>
      </details>
    </VaultPanel>
  );
}
