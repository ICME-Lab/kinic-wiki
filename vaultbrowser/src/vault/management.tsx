import { useEffect, useRef, useState } from "react";
import { bytes, ok, type VaultClient } from "@kinic/vault-client";
import { b64 } from "@kinic/vault-crypto/documents";
import type { CredentialInfo, Header } from "@kinic/vault-client/contracts";
import { VaultButton, VaultField, VaultPanel } from "./ui";
import type { VaultWork } from "./workspace";
export function VaultBackups({
  client,
  selected,
  unlocked,
  disabled,
  run,
  onChanged,
}: {
  client: VaultClient;
  selected: Header;
  unlocked: boolean;
  disabled: boolean;
  run: VaultWork;
  onChanged: () => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [kit, setKit] = useState<File>();
  const [kitInput, setKitInput] = useState(0);
  const [backup, setBackup] =
    useState<Awaited<ReturnType<VaultClient["backup"]>>>();
  const backupRef = useRef(backup);
  backupRef.current = backup;
  useEffect(
    () => () => {
      backupRef.current?.data.fill(0);
    },
    [],
  );
  return (
    <VaultPanel label="Encrypted backup">
      <h2 className="font-semibold">Encrypted backup</h2>
      <p className="text-sm text-muted">
        Export remains available when locked or short of cycles. Use your
        recovery secret locally to authenticate the archive without requesting a
        Vault key.
      </p>
      {!unlocked ? (
        <>
          <VaultField
            label="Export recovery secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <VaultField
            key={kitInput}
            label="Or select recovery kit"
            type="file"
            accept=".json"
            onChange={(e) => setKit(e.target.files?.[0])}
          />
        </>
      ) : null}
      <p className="text-sm text-muted">
        Portable v1 and v2 archives can also be opened with the supplied offline
        recovery tool. Keep the recovery kit separate from the encrypted
        archive.
      </p>
      <div className="flex flex-wrap gap-2">
        <VaultButton
          disabled={disabled || (!unlocked && !secret && !kit)}
          onClick={() =>
            run(async () => {
              const g = client.session.capture();
              const secretText = secret;
              setSecret("");
              const selectedKit = kit;
              setKit(undefined);
              setKitInput((k) => k + 1);
              let kitData: Uint8Array | undefined;
              const detach = client.session.addLockCleanup(() =>
                kitData?.fill(0),
              );
              let next;
              try {
                if (selectedKit) {
                  if (selectedKit.size > 4096) throw Error("InvalidKit");
                  kitData = new Uint8Array(await selectedKit.arrayBuffer());
                  client.session.check(g);
                }
                next = unlocked
                  ? await client.backup()
                  : kitData
                    ? await client.backupWithKit(selected, kitData)
                    : await client.backupWithRecovery(selected, secretText);
              } finally {
                detach();
                kitData?.fill(0);
              }
              try {
                client.session.check(g);
              } catch (cause) {
                next.data.fill(0);
                throw cause;
              }
              backupRef.current?.data.fill(0);
              setBackup(next);
              client.session.download(next.data, "vault-backup.kvault");
            })
          }
        >
          Download encrypted backup
        </VaultButton>
        {backup ? (
          <>
            <p className="w-full text-sm text-muted">
              Confirm that the file was saved. Changes after this snapshot are
              not included in this backup.
            </p>
            <VaultButton
              disabled={disabled}
              onClick={() =>
                run(async () => {
                  const g = client.session.capture();
                  await client.confirmBackup(backup.exportId, true);
                  client.session.check(g);
                  backup.data.fill(0);
                  setBackup(undefined);
                  await onChanged();
                })
              }
            >
              I saved the backup
            </VaultButton>
            <VaultButton
              disabled={disabled}
              onClick={() =>
                run(async () => {
                  const g = client.session.capture();
                  ok(await client.actor.abort_export(backup.exportId));
                  client.session.check(g);
                  backup.data.fill(0);
                  setBackup(undefined);
                  await onChanged();
                })
              }
            >
              Cancel backup
            </VaultButton>
          </>
        ) : (
          <VaultButton
            disabled={disabled}
            onClick={() =>
              run(async () => {
                const g = client.session.capture();
                const active = ok(
                  await client.actor.get_active_export_for_vault(selected.id),
                )[0];
                client.session.check(g);
                if (active) {
                  ok(await client.actor.abort_export(active.id));
                  client.session.check(g);
                  await onChanged();
                }
              })
            }
          >
            Cancel pending backup
          </VaultButton>
        )}
      </div>
    </VaultPanel>
  );
}
export function VaultPasskeys({
  client,
  disabled,
  run,
  onChanged,
}: {
  client: VaultClient;
  disabled: boolean;
  run: VaultWork;
  onChanged: () => Promise<void>;
}) {
  const [credentials, setCredentials] = useState<CredentialInfo[]>([]);
  const refresh = async () => {
    const g = client.session.capture();
    const list = ok(await client.actor.list_credentials());
    client.session.check(g);
    setCredentials(list);
    await onChanged();
  };
  return (
    <VaultPanel label="Unlock passkeys">
      <details className="[&:not([open])>div]:hidden">
        <summary className="cursor-pointer font-semibold">
          Unlock passkeys
        </summary>
        <div className="mt-3 grid gap-3">
          <p className="text-sm text-muted">
            Adding or removing a passkey requires an existing passkey. The final
            passkey cannot be removed. Ordinary removal does not rotate the
            Vault root key or replace recovery material. Use the incident
            workflow for a compromised passkey.
          </p>
          <div className="flex flex-wrap gap-2">
            <VaultButton
              disabled={disabled}
              onClick={() =>
                run(async () => {
                  await client.addCredential();
                  await refresh();
                })
              }
            >
              Add passkey
            </VaultButton>
            <VaultButton disabled={disabled} onClick={() => run(refresh)}>
              Show registered passkeys
            </VaultButton>
          </div>
          {credentials.map((credential, index) => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
              key={b64(bytes(credential.id))}
            >
              <span>Passkey {index + 1}</span>
              <VaultButton
                disabled={disabled || credentials.length <= 1}
                onClick={() =>
                  run(async () => {
                    await client.removeCredential(bytes(credential.id));
                    await refresh();
                  })
                }
              >
                Remove passkey {index + 1}
              </VaultButton>
            </div>
          ))}
        </div>
      </details>
    </VaultPanel>
  );
}

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
  useEffect(() => {
    let active = true;
    const ticket = client.session.capture();
    void client.actor
      .cleanup_status()
      .then((reply) => {
        client.session.check(ticket);
        const pending = ok(reply)[0];
        if (active && pending && !pending.complete)
          setProgress(
            `Pending cleanup batch ${pending.cursor} — resume the original Vault and action`,
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);
  return (
    <VaultPanel label="Encrypted storage cleanup">
      <details className="[&:not([open])>div]:hidden">
        <summary className="cursor-pointer font-semibold">
          Encrypted storage cleanup
        </summary>
        <div className="mt-3 grid min-w-0 gap-3 text-sm">
          <p>
            Cleanup requires a registered passkey and does not request a Vault
            key. It remains available with insufficient prepaid balance. Full
            purge permanently deletes this Vault and every version; existing
            backup files remain unchanged.
          </p>
          <p>
            Cleanup runs in bounded batches under one passkey grant. If locked
            or interrupted, select the same Vault and action to resume its
            stored progress.
          </p>
          <VaultButton
            disabled={disabled}
            onClick={() =>
              run(async () => {
                const g = client.session.capture(),
                  result = await client.cleanup(selected, false, (value) =>
                    setProgress(`Cleanup batch ${value.cursor}`),
                  );
                client.session.check(g);
                setProgress(
                  result.complete
                    ? "Cleanup complete"
                    : "Cleanup pending — continue the same action",
                );
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
                const result = await client.cleanup(selected, true, (value) =>
                  setProgress(`Purge batch ${value.cursor}`),
                );
                client.session.lock();
                if (result.complete) client.header = undefined;
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
