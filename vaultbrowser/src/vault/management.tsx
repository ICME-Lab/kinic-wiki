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
        <VaultField
          label="Export recovery secret"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <VaultButton
          disabled={disabled || (!unlocked && !secret)}
          onClick={() =>
            run(async () => {
              const g = client.session.capture();
              const secretText = secret;
              setSecret("");
              const next = unlocked
                ? await client.backup()
                : await client.backupWithRecovery(selected, secretText);
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
}: {
  client: VaultClient;
  disabled: boolean;
  run: VaultWork;
}) {
  const [credentials, setCredentials] = useState<CredentialInfo[]>([]);
  const refresh = async () => {
    const g = client.session.capture();
    const list = ok(await client.actor.list_credentials());
    client.session.check(g);
    setCredentials(list);
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
            passkey cannot be removed.
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
  const [objects, setObjects] = useState<
    { object: Uint8Array | number[]; deleted: boolean }[]
  >([]);
  const [cursor, setCursor] = useState<Uint8Array>(new Uint8Array());
  const [loaded, setLoaded] = useState(false);
  const load = async (after: Uint8Array, append: boolean) => {
    const g = client.session.capture();
    const page = ok(await client.actor.list_objects(selected.id, after));
    client.session.check(g);
    const rows = page.entries.map((entry) => ({
      object: entry.object,
      deleted: entry.deleted,
    }));
    setObjects((previous) => (append ? [...previous, ...rows] : rows));
    setCursor(page.next[0] ? bytes(page.next[0]) : new Uint8Array());
    setLoaded(true);
  };
  return (
    <VaultPanel label="Encrypted storage cleanup">
      <details className="[&:not([open])>div]:hidden">
        <summary className="cursor-pointer font-semibold">
          Encrypted storage cleanup
        </summary>
        <div className="mt-3 grid min-w-0 gap-3">
          <p className="text-sm text-muted">
            Without unlocking, titles remain hidden. Permanently deleting an
            encrypted object removes every version. Existing backup files remain
            unchanged. This cleanup is available when cycles are low.
          </p>
          <VaultButton
            disabled={disabled}
            onClick={() => run(() => load(new Uint8Array(), false))}
          >
            List encrypted object IDs
          </VaultButton>
          {loaded && !objects.length ? (
            <p className="text-sm text-muted">No encrypted objects.</p>
          ) : null}
          {objects.map((object) => {
            const id = b64(bytes(object.object));
            return (
              <div className="grid min-w-0 gap-2 text-sm" key={id}>
                <span className="break-all font-mono">
                  {id}
                  {object.deleted ? " (deleted)" : ""}
                </span>
                <VaultButton
                  disabled={disabled}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Permanently delete encrypted object ${id} and all its history? This cannot be undone.`,
                      )
                    )
                      return;
                    run(async () => {
                      const g = client.session.capture();
                      ok(
                        await client.actor.purge_object(
                          selected.id,
                          object.object,
                        ),
                      );
                      client.session.check(g);
                      await load(new Uint8Array(), false);
                      await onChanged();
                    });
                  }}
                >
                  Purge object {id}
                </VaultButton>
              </div>
            );
          })}
          {cursor.length ? (
            <VaultButton
              disabled={disabled}
              onClick={() => run(() => load(cursor, true))}
            >
              Load more encrypted objects
            </VaultButton>
          ) : null}
        </div>
      </details>
    </VaultPanel>
  );
}
