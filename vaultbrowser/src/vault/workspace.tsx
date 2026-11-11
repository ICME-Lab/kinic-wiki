"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Funding } from "../funding";
import { bytes, ok, type Item, type VaultClient } from "@kinic/vault-client";
import type {
  Header,
  Quota,
  UnfinishedVault,
  VaultConfig,
  GlobalCapacity,
  CredentialInfo,
} from "@kinic/vault-client/contracts";
import { b64, unb64 } from "@kinic/vault-crypto/documents";
import { VaultButton, VaultPanel, vaultError } from "./ui";
import { VaultRecovery } from "./recovery";
import { VaultSetup } from "./setup";
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
  const [balance, setBalance] = useState(0n);
  const [capacity, setCapacity] = useState<GlobalCapacity>();
  const [credentials, setCredentials] = useState<CredentialInfo[]>([]);
  const [credential, setCredential] = useState("");
  const privateDOM = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const workId = useRef(0);
  useLayoutEffect(() => {
    alive.current = true;
    client.session.onLock = () => {
      if (!alive.current) return;
      workId.current++;
      busyRef.current = false;
      setBusy(false);
      setUnlocked(false);
      setItems([]);
      setQuota(undefined);
      setKit(undefined);
      setGeneration(client.session.capture());
      setError("");
    };
    const detach = client.session.addLockCleanup(() => {
      for (const panel of privateDOM.current?.querySelectorAll(
        "[data-vault-sensitive]",
      ) ?? []) {
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) walker.currentNode.nodeValue = "";
      }
      for (const input of privateDOM.current?.querySelectorAll(
        "input, textarea",
      ) ?? []) {
        (input as HTMLInputElement).value = "";
        input.removeAttribute("value");
      }
    });
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
      detach();
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
    // Creation/unlock first lock synchronously; claim this operation after that reset.
    const pending = operation();
    const id = ++workId.current;
    busyRef.current = true;
    setBusy(true);
    const g = client.session.capture();
    const current = () =>
      alive.current && client.session.capture() === g && workId.current === id;
    void pending
      .catch((cause) => {
        if (current()) setError(vaultError(cause));
      })
      .finally(() => {
        if (alive.current && workId.current === id) {
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
    const currentVaults = ok(list);
    setVaults(currentVaults);
    setSelected((previous) =>
      previous
        ? currentVaults.find(
            (v) => b64(bytes(v.id)) === b64(bytes(previous.id)),
          )
        : undefined,
    );
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
    const [c, b, cap, creds] = await Promise.all([
      client.actor.get_config(),
      client.actor.account_balance(),
      client.actor.global_capacity(),
      client.actor.list_credentials(),
    ]);
    client.session.check(g);
    if (!alive.current) return;
    const settings = ok(c)[0];
    setConfig(settings);
    setBalance(ok(b));
    setCapacity(ok(cap));
    const currentCredentials = ok(creds);
    setCredentials(currentCredentials);
    setCredential((previous) =>
      currentCredentials.some((c) => b64(bytes(c.id)) === previous)
        ? previous
        : "",
    );
    client.configurePasskeys(
      settings?.origin === location.origin ? settings.rp_id : "",
    );
  }, [client]);
  useEffect(() => {
    const g = client.session.capture();
    void Promise.all([refreshConfiguration(), refreshLists()]).catch(
      (cause) => {
        if (alive.current && g === client.session.capture())
          setError(vaultError(cause));
      },
    );
  }, [client, refreshConfiguration, refreshLists]);
  const eligible =
    !!config && config.origin === location.origin && balance >= 20_000_000n;
  return (
    <div ref={privateDOM} className="grid min-w-0 gap-5">
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
        Vault encryption keys, plaintext and search stay in this browser
        session. Vault locks after 5 minutes of inactivity or 1 minute in a
        hidden tab. Your browser and the canister updater remain trusted.
      </p>
      <VaultPanel label="Vault account">
        <p className="font-semibold">
          Prepaid balance: {balance.toString()} cycles
        </p>
        <p className="break-all text-sm">
          Vault principal: {client.identity.getPrincipal().toText()}
        </p>
        <p className="text-sm text-muted">
          Fund this principal with KINIC from your wallet. The paying wallet may
          differ from your Vault sign-in.
        </p>
        <VaultButton onClick={() => run(refreshConfiguration)}>
          Refresh balance
        </VaultButton>
        {capacity ? (
          <div className="grid gap-2 text-sm">
            <p>
              Shared capacity: {capacity.used.toLocaleString()} /{" "}
              {capacity.limit.toLocaleString()} bytes. Accounting reserve:{" "}
              {capacity.accounting_reserved.toLocaleString()} bytes (16 MiB
              within the 200 MiB total).
            </p>
            <p>
              Storage includes ciphertext, history, pending operations and
              control records. Each namespace reserves 512 KiB within its limits
              for completion and cleanup. Owner limits are separate; funding
              does not increase storage capacity. No shared database payer is
              used.
            </p>
            {capacity.overcommitted ? (
              <output>
                Capacity is overcommitted by {capacity.overage.toLocaleString()}{" "}
                bytes. Export and cleanup remain available.
              </output>
            ) : null}
          </div>
        ) : (
          <output>Checking shared storage capacity before funding…</output>
        )}
        {capacity ? (
          <Funding
            key={`funding-${generation}`}
            client={client}
            onFunded={refreshConfiguration}
          />
        ) : null}
        {credentials.length ? (
          <label className="grid gap-1 text-sm">
            Authorizing passkey
            <select
              value={credential}
              className="min-h-10 min-w-0 rounded-lg border border-line bg-white px-3"
              onChange={(e) => {
                setCredential(e.target.value);
                client.selectCredential(
                  e.target.value ? unb64(e.target.value) : undefined,
                );
              }}
            >
              <option value="">
                {credentials.length === 1
                  ? "Use registered passkey"
                  : "Choose a registered passkey"}
              </option>
              {credentials.map((c, i) => (
                <option key={b64(bytes(c.id))} value={b64(bytes(c.id))}>
                  Passkey {i + 1}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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
      <VaultRecovery
        client={client}
        disabled={busy}
        enabled={eligible}
        credential={
          credential
            ? unb64(credential)
            : credentials.length === 1
              ? bytes(credentials[0].id)
              : undefined
        }
        run={run}
        onChanged={async () => {
          await Promise.all([refreshLists(), refreshConfiguration()]);
        }}
      />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <VaultPanel label="Vaults">
          <h2 className="font-semibold">Vaults</h2>
          <p className="text-sm text-muted">
            3 Vaults · 100 MiB each · 200 MiB total including history and
            pending data. Shared capacity also includes 16 MiB for accounting.
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
          <VaultButton
            disabled={busy}
            onClick={() =>
              run(async () => {
                await Promise.all([refreshConfiguration(), refreshLists()]);
              })
            }
          >
            Refresh Vaults
          </VaultButton>
          <VaultButton
            disabled={busy}
            onClick={() =>
              run(async () => {
                await client.retryMutation();
                await refreshLists();
              })
            }
          >
            Retry signed request
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
              {"Pending" in entry.state || "Purging" in entry.state ? (
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
                      await client.cancelSetup(entry);
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
              {selected.generation[0] ? (
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
                    onChanged={refreshConfiguration}
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
