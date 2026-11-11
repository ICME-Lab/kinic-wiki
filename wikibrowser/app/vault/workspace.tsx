"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { bytes, ok, type Item, type VaultClient } from "@kinic/vault-client";
import type {
  Header,
  Quota,
  UnfinishedVault,
  VaultConfig,
} from "@kinic/vault-client/contracts";
import { b64 } from "@kinic/vault-crypto/documents";
import { VaultButton, VaultPanel, vaultError } from "./ui";
import { VaultSetup, VaultRestore } from "./setup";
import { VaultDocuments } from "./documents";
import {
  VaultBackups,
  VaultPasskeys,
  VaultEncryptedCleanup,
} from "./management";

export type VaultWork = (operation: () => Promise<void>) => void;
export function VaultWorkspace({ client }: { client: VaultClient }) {
  const [vaults, setVaults] = useState<Header[]>([]);
  const [unfinished, setUnfinished] = useState<UnfinishedVault[]>([]);
  const [selected, setSelected] = useState<Header>();
  const [items, setItems] = useState<Item[]>([]);
  const [quota, setQuota] = useState<Quota>();
  const [unlocked, setUnlocked] = useState(false);
  const [generation, setGeneration] = useState(client.session.capture());
  const [kit, setKit] =
    useState<Awaited<ReturnType<VaultClient["createKit"]>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<VaultConfig>();
  const [payer, setPayer] = useState("");
  const [databases, setDatabases] = useState<{ id: string; name: string }[]>(
    [],
  );
  const alive = useRef(true);
  const busyRef = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    client.session.onLock = () => {
      if (!alive.current) return;
      setUnlocked(false);
      setItems([]);
      setQuota(undefined);
      setKit(undefined);
      setGeneration(client.session.capture());
      setError("");
    };
    const activity = () => client.session.activity();
    const visible = () => client.session.visible(document.hidden);
    const hide = () => client.session.lock();
    for (const event of ["pointerdown", "keydown"])
      window.addEventListener(event, activity);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", hide);
    visible();
    const interval = window.setInterval(() => client.session.expire(), 1000);
    return () => {
      alive.current = false;
      client.session.onLock = () => {};
      client.session.lock();
      window.clearInterval(interval);
      for (const event of ["pointerdown", "keydown"])
        window.removeEventListener(event, activity);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", hide);
    };
  }, [client]);
  const run: VaultWork = (operation) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    // Operations such as create/restore lock synchronously before their first await.
    const pending = operation();
    const g = client.session.capture();
    const current = () => alive.current && client.session.capture() === g;
    void pending
      .catch((cause) => {
        if (current()) setError(vaultError(cause));
      })
      .finally(() => {
        if (alive.current) {
          busyRef.current = false;
          setBusy(false);
        }
      });
  };
  const refreshLists = useCallback(async () => {
    const g = client.session.capture();
    const [list, setup] = await Promise.all([
      client.actor.list_vaults(),
      client.actor.list_unfinished_vaults(),
    ]);
    client.session.check(g);
    if (!alive.current) return;
    setVaults(ok(list));
    setUnfinished(ok(setup));
  }, [client]);
  const refresh = async () => {
    const g = client.session.capture();
    const [list, q, header] = await Promise.all([
      client.items(),
      client.actor.get_quota(client.header!.id),
      client.actor.get_vault_header(client.header!.id),
    ]);
    client.session.check(g);
    if (!alive.current) return;
    const h = ok(header);
    client.header = h;
    setItems(list);
    setQuota(ok(q));
    setSelected(h);
    setUnlocked(true);
    await refreshLists();
  };
  const refreshConfiguration = useCallback(async () => {
    const g = client.session.capture();
    const [c, p, db] = await Promise.all([client.actor.get_config(), client.actor.get_payer(), client.payerDatabases()]);
    client.session.check(g);
    if (!alive.current) return;
    const settings = ok(c)[0];
    setConfig(settings); setPayer(ok(p)[0] ?? ""); setDatabases(db);
    client.configurePasskeys(settings?.origin === location.origin ? settings.rp_id : "");
  }, [client]);
  useEffect(() => {
    const g = client.session.capture();
    void Promise.all([refreshConfiguration(), refreshLists()]).catch(cause => {
      if (alive.current && g === client.session.capture()) setError(vaultError(cause));
    });
  }, [client, refreshConfiguration, refreshLists]);
  const eligible =
    !!config &&
    config.origin === location.origin &&
    !!payer &&
    databases.some((db) => db.id === payer);
  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Private Vault</h1>
          <p className="mt-1 text-sm text-muted">
            Encrypted notes, credentials and attachments.
          </p>
        </div>
        <VaultButton onClick={() => client.session.lock()}>
          Lock Vault
        </VaultButton>
      </div>
      <p className="text-sm text-muted">
        Keys, plaintext and search stay in this browser session. Vault locks
        after 5 minutes of inactivity or 1 minute in a hidden tab. Your browser
        and the canister updater remain trusted.
      </p>
      <VaultPanel label="Vault billing">
        <label className="grid gap-2 text-sm font-medium">
          Payer database
          <select
            aria-label="Payer database"
            className="min-h-10 max-w-full rounded-lg border border-line bg-white px-3 text-ink"
            value={payer}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              run(async () => {
                const g = client.session.capture();
                ok(await client.actor.set_payer(id));
                client.session.check(g);
                setPayer(id);
              });
            }}
          >
            <option value="">Select a database you own</option>
            {payer && !databases.some((db) => db.id === payer) ? (
              <option value={payer}>
                Current payer unavailable — select another database
              </option>
            ) : null}
            {databases.map((db) => (
              <option value={db.id} key={db.id}>
                {db.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-muted">
          Database members may see billing activity. Rebind before deleting a
          payer database; unsettled reservations must finish first.
        </p>
      </VaultPanel>
      {!config || config.origin !== location.origin ? (
        <p className="text-sm text-muted">
          Vault writes and passkeys are disabled until this exact origin and RP
          ID are configured. Recovery-secret export and interrupted-operation
          cleanup remain available.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-line p-3 text-sm text-dangerText"
        >
          {error}
        </p>
      ) : null}
      {busy ? (
        <output className="text-sm">Processing Vault operation…</output>
      ) : null}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <VaultPanel label="Vaults">
          <h2 className="font-semibold">Vaults</h2>
          <p className="text-sm text-muted">
            3 Vaults · 100 MiB each · 200 MiB total including history and
            pending data.
          </p>
          {vaults.map((v, index) => (
            <VaultButton
              key={b64(bytes(v.id))}
              disabled={busy}
              aria-pressed={
                !!selected && b64(bytes(selected.id)) === b64(bytes(v.id))
              }
              onClick={() => {
                client.session.lock();
                client.header = v;
                setSelected(v);
              }}
            >
              Vault {index + 1}
            </VaultButton>
          ))}
          <VaultButton
            disabled={busy || !eligible || vaults.length >= 3}
            onClick={() =>
              run(async () => {
                const next = await client.createKit();
                client.session.check(next.generation);
                setSelected(undefined);
                setKit(next);
              })
            }
          >
            Create Vault
          </VaultButton>
          <VaultRestore
            key={`restore-${generation}`}
            client={client}
            disabled={busy || !eligible}
            run={run}
            onRestored={refresh}
          />
          <VaultButton disabled={busy} onClick={() => run(async () => { await Promise.all([refreshConfiguration(), refreshLists()]); })}>
            Refresh Vaults
          </VaultButton>
          <VaultButton
            disabled={busy}
            onClick={() =>
              run(async () => {
                const g = client.session.capture();
                ok(await client.actor.cancel_pending_key_derivation());
                client.session.check(g);
                await refreshLists();
              })
            }
          >
            Clear interrupted key request
          </VaultButton>
          <VaultButton
            disabled={busy}
            onClick={() =>
              run(async () => {
                const g = client.session.capture();
                ok(await client.actor.collect_garbage());
                client.session.check(g);
                await refreshLists();
              })
            }
          >
            Collect pending cleanup
          </VaultButton>
          {unfinished.map((entry) => (
            <div
              className="grid gap-2 border-t border-line pt-3 text-sm"
              key={b64(bytes(entry.attempt))}
            >
              <span>
                {entry.cleaning
                  ? "Setup cleanup in progress"
                  : "Restoring" in entry.state
                    ? "Interrupted restore"
                    : "Interrupted creation"}
              </span>
              {!entry.cleaning ? (
                <VaultButton
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Discard this interrupted setup? Your original backup is unchanged.",
                      )
                    )
                      return;
                    run(async () => {
                      const g = client.session.capture();
                      ok(
                        await client.actor.cancel_vault_setup(
                          entry.vault,
                          entry.attempt,
                        ),
                      );
                      client.session.check(g);
                      await refreshLists();
                    });
                  }}
                >
                  Cancel interrupted setup
                </VaultButton>
              ) : null}
            </div>
          ))}
        </VaultPanel>
        <div className="grid min-w-0 content-start gap-4">
          {kit ? (
            <VaultSetup
              key={`setup-${generation}`}
              client={client}
              kit={kit}
              disabled={busy}
              run={run}
              onActivated={async () => {
                setKit(undefined);
                await refresh();
              }}
            />
          ) : selected ? (
            <>
              <VaultPanel label="Selected Vault">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="mr-auto font-semibold">
                    {unlocked ? "Vault unlocked" : "Vault locked"}
                  </h2>
                  {!unlocked ? (
                    <VaultButton
                      disabled={busy || !eligible}
                      onClick={() =>
                        run(async () => {
                          await client.unlock(selected);
                          await refresh();
                        })
                      }
                    >
                      Unlock with passkey
                    </VaultButton>
                  ) : null}
                </div>
                {quota ? (
                  <p className="text-sm text-muted">
                    {Number(quota.current).toLocaleString()} current bytes ·{" "}
                    {Number(quota.charged).toLocaleString()} charged ·{" "}
                    {Number(quota.reserved).toLocaleString()} reserved ·{" "}
                    {Number(quota.limit).toLocaleString()} limit
                  </p>
                ) : null}
                <p className="text-sm text-muted">
                  {selected.backup_sequence[0] === undefined
                    ? "No confirmed backup"
                    : selected.sequence > selected.backup_sequence[0]
                      ? "Changes since last backup"
                      : "Backup saved and confirmed"}
                </p>
              </VaultPanel>
              <VaultBackups
                key={`backup-${generation}`}
                client={client}
                selected={selected}
                unlocked={unlocked}
                disabled={busy}
                run={run}
                onChanged={async () => {
                  if (client.header) setSelected(client.header);
                  await refreshLists();
                }}
              />
              {!unlocked ? (
                <VaultEncryptedCleanup
                  key={`cleanup-${generation}`}
                  client={client}
                  selected={selected}
                  disabled={busy}
                  run={run}
                  onChanged={async () => {
                    await refreshLists();
                  }}
                />
              ) : null}
              {unlocked ? (
                <>
                  <VaultDocuments
                    key={`documents-${generation}`}
                    client={client}
                    items={items}
                    disabled={busy}
                    writesDisabled={!eligible}
                    run={run}
                    refresh={refresh}
                  />
                  <VaultPasskeys
                    key={`passkeys-${generation}`}
                    client={client}
                    disabled={busy || !eligible}
                    run={run}
                  />
                </>
              ) : null}
            </>
          ) : (
            <VaultPanel label="Choose a Vault">
              <h2 className="font-semibold">Choose or create a Vault</h2>
              <p className="text-sm text-muted">
                Keep the encrypted backup and recovery secret in separate safe
                places. Both are required for recovery.
              </p>
            </VaultPanel>
          )}
        </div>
      </div>
    </div>
  );
}
