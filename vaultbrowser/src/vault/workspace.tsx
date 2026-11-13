"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronRight,
  FolderLock,
  LockKeyhole,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { Funding } from "../funding";
import { bytes, ok, type Item, type VaultClient } from "@kinic/vault-client";
import type {
  Header,
  Quota,
  VaultConfig,
  GlobalCapacity,
  PendingUploadSummary,
} from "@kinic/vault-client/contracts";
import { b64 } from "@kinic/vault-crypto/documents";
import { VaultButton, VaultPanel, vaultError } from "./ui";
import { VaultDocuments } from "./documents";
import { VaultEncryptedCleanup } from "./management";

export type VaultWork = (operation: () => Promise<void>) => void;
const id = (h: Header) => b64(bytes(h.id));
export function VaultWorkspace({ client }: { client: VaultClient }) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [vaults, setVaults] = useState<Header[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUploadSummary[]>(
    [],
  );
  const [uploadAfter, setUploadAfter] = useState<Uint8Array>();
  const [selected, setSelected] = useState<Header>();
  const selectedRef = useRef<Header | undefined>(undefined);
  const select = useCallback((header?: Header) => {
    selectedRef.current = header;
    setSelected(header);
  }, []);
  const [items, setItems] = useState<Item[]>([]);
  const [quota, setQuota] = useState<Quota>();
  const [opened, setOpened] = useState(false);
  const [generation, setGeneration] = useState(client.session.capture());
  const [creationPending, setCreationPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<VaultConfig>();
  const [balance, setBalance] = useState(0n);
  const [capacity, setCapacity] = useState<GlobalCapacity>();
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
      setOpened(false);
      select(undefined);
      setItems([]);
      setQuota(undefined);
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
  }, [client, select]);
  const run: VaultWork = (operation) => {
    if (busyRef.current || !alive.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    // create/open may synchronously close the old context before their first await.
    const pending = operation();
    const request = ++workId.current;
    busyRef.current = true;
    setBusy(true);
    const ticket = client.session.capture();
    const current = () =>
      alive.current &&
      client.session.capture() === ticket &&
      workId.current === request;
    void pending
      .catch((cause) => {
        if (current()) setError(vaultError(cause));
      })
      .finally(() => {
        if (alive.current && workId.current === request) {
          busyRef.current = false;
          setBusy(false);
        }
      });
  };
  const refreshLists = useCallback(async () => {
    const ticket = client.session.capture();
    const [list, uploads] = await Promise.all([
      client.listVaults(),
      client.pendingUploads(),
    ]);
    client.session.check(ticket);
    if (!alive.current) return;
    const previous = selectedRef.current;
    const listed = previous
      ? list.find((h) => id(h) === id(previous))
      : undefined;
    setVaults(list);
    setPendingUploads(uploads.entries);
    setUploadAfter(uploads.next[0] ? bytes(uploads.next[0]) : undefined);
    // Also fence an outstanding key attempt if its selected header disappears
    // or changes binding. Sequence changes alone are harmless.
    if (
      previous &&
      (!listed ||
        listed.key_name !== previous.key_name ||
        b64(bytes(listed.nonce)) !== b64(bytes(previous.nonce)) ||
        b64(bytes(listed.public_key)) !== b64(bytes(previous.public_key)) ||
        ("Active" in previous.state && !("Active" in listed.state)))
    ) {
      client.session.lock();
      return;
    }
    // A list refresh must validate, never directly install a header into the root binding.
    if (client.header && client.session.root) {
      if (!list.some((h) => id(h) === id(client.header!))) {
        client.session.lock();
        return;
      }
      const h = await client.refreshHeader();
      client.session.check(ticket);
      if (!alive.current) return;
      select(h);
    } else if (listed) select(listed);
  }, [client, select]);
  const refresh = async () => {
    const ticket = client.session.capture();
    const [list, q, header] = await Promise.all([
      client.items(),
      client.quota(),
      client.refreshHeader(),
    ]);
    client.session.check(ticket);
    if (!alive.current) return;
    setItems(list);
    setQuota(q);
    select(header);
    setOpened(true);
    await refreshLists();
  };
  const refreshConfiguration = useCallback(async () => {
    const ticket = client.session.capture();
    const [c, b, cap] = await Promise.all([
      client.actor.get_config(),
      client.actor.account_balance(),
      client.actor.global_capacity(),
    ]);
    client.session.check(ticket);
    if (!alive.current) return;
    setConfig(ok(c)[0]);
    setBalance(ok(b));
    setCapacity(ok(cap));
  }, [client]);
  useEffect(() => {
    const ticket = client.session.capture();
    void Promise.all([refreshConfiguration(), refreshLists()]).catch(
      (cause) => {
        if (alive.current && ticket === client.session.capture())
          setError(vaultError(cause));
      },
    );
  }, [client, refreshConfiguration, refreshLists, generation]);
  const open = async (header: Header) => {
    if (!("Active" in header.state)) {
      client.session.lock();
      select(header);
      return;
    }
    const pending = client.open(header);
    // Capture after the synchronous switch; keep the header selectable on key failure.
    const ticket = client.session.capture();
    select(header);
    await pending;
    client.session.check(ticket);
    if (!alive.current) return;
    await refresh();
  };
  // The canister reserve is not owner credit. The server checks exact paid admission.
  const eligible = !!config && balance > 0n;
  return (
    <div ref={privateDOM} className="vault-workspace grid min-w-0 gap-5">
      <div className="vault-workspace-header flex flex-wrap items-center justify-between gap-3">
        <div className="vault-workspace-heading">
          <h1 className="text-2xl font-semibold tracking-tight">
            Private Vault
          </h1>
          <div className="vault-status-strip" aria-label="Vault session status">
            <span
              className={`vault-status ${opened ? "vault-status--unlocked" : ""}`}
            >
              <span aria-hidden />
              {opened ? "Vault open" : "Vault closed"}
            </span>
          </div>
        </div>
        <div className="vault-header-actions">
          <VaultButton onClick={() => client.session.lock()}>
            <LockKeyhole size={16} aria-hidden />
            Close Vault
          </VaultButton>
        </div>
      </div>
      {!config ? (
        <p className="text-sm text-muted">
          Vault creation is unavailable until the service is configured. Cleanup
          remains available.
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
      <p id="vault-loss-disclosure" className="text-sm text-muted">
        This release has no backup or independent recovery. Losing access to
        Internet Identity permanently loses access to your Vaults unless you
        recover Internet Identity itself.
      </p>
      <div
        className={`vault-workspace-grid ${navigationOpen ? "vault-navigation-open" : ""}`}
      >
        <VaultButton
          className="vault-navigation-toggle"
          id="vault-navigation-toggle"
          aria-label="Toggle Vault navigation"
          aria-expanded={navigationOpen}
          aria-controls="vault-navigation"
          onClick={() => setNavigationOpen((open) => !open)}
        >
          <FolderLock size={16} aria-hidden />
          Vaults
          <ChevronRight size={14} aria-hidden />
        </VaultButton>
        <div id="vault-navigation" className="vault-navigation">
          <VaultPanel label="Vaults" className="vault-sidebar">
            <div className="vault-sidebar-title">
              <FolderLock size={18} aria-hidden />
              <h2 className="font-semibold">Vaults</h2>
              <span>{vaults.length}/3</span>
            </div>
            <p className="text-xs leading-5 text-muted">
              A separate space for what stays private.
            </p>
            <VaultButton
              tone="primary"
              aria-describedby="vault-loss-disclosure"
              disabled={busy || !eligible}
              onClick={() =>
                run(async () => {
                  setCreationPending(true);
                  const pending = client.create();
                  const ticket = client.session.capture();
                  const header = await pending;
                  client.session.check(ticket);
                  if (!alive.current) return;
                  setCreationPending(false);
                  select(header);
                  await refreshLists();
                  client.session.check(ticket);
                  await open(header);
                })
              }
            >
              <Plus size={16} aria-hidden />
              {creationPending ? "Retry Vault creation" : "Create Vault"}
            </VaultButton>
            <VaultButton disabled={busy} onClick={() => run(refreshLists)}>
              <RefreshCw size={15} aria-hidden />
              Refresh Vaults
            </VaultButton>
            {vaults.map((h, index) => (
              <VaultButton
                key={id(h)}
                className="vault-switcher"
                disabled={busy}
                aria-pressed={selected ? id(selected) === id(h) : false}
                onClick={() => {
                  setNavigationOpen(false);
                  if (navigationOpen)
                    document.getElementById("vault-navigation-toggle")?.focus();
                  run(() => open(h));
                }}
              >
                <FolderLock size={17} aria-hidden />
                <span>
                  Vault {index + 1} · {Object.keys(h.state)[0]}
                </span>
                <ChevronRight size={15} aria-hidden />
              </VaultButton>
            ))}
          </VaultPanel>
        </div>
        <div className="vault-main grid min-w-0 content-start gap-4">
          {selected ? (
            <>
              {!opened ? (
                <VaultPanel label="Open Vault" className="vault-selected">
                  {"Active" in selected.state ? (
                    <>
                      <p>
                        Select this Vault to open it with Internet Identity. If
                        the key service was unavailable, retry opening the same
                        Vault.
                      </p>
                      <VaultButton
                        disabled={busy}
                        onClick={() => run(() => open(selected))}
                      >
                        Retry opening Vault
                      </VaultButton>
                    </>
                  ) : (
                    <p>
                      This Vault is{" "}
                      {Object.keys(selected.state)[0].toLowerCase()}. Use
                      cleanup to remove its unfinished data.
                    </p>
                  )}
                </VaultPanel>
              ) : (
                <>
                  {quota ? (
                    <p className="text-sm">
                      Storage: {quota.charged.toLocaleString()} /{" "}
                      {quota.limit.toLocaleString()} bytes; reserved{" "}
                      {quota.reserved.toLocaleString()} bytes.
                    </p>
                  ) : null}
                  <VaultDocuments
                    key={`documents-${generation}`}
                    client={client}
                    items={items}
                    disabled={busy}
                    writesDisabled={!eligible}
                    run={run}
                    refresh={refresh}
                  />
                  <VaultButton
                    disabled={busy || client.hasPendingSave}
                    onClick={() =>
                      run(async () => {
                        const ticket = client.session.capture();
                        await client.retryMutation();
                        client.session.check(ticket);
                        await refresh();
                      })
                    }
                  >
                    Retry interrupted change
                  </VaultButton>
                </>
              )}
              <VaultEncryptedCleanup
                key={`cleanup-${generation}`}
                client={client}
                selected={selected}
                disabled={busy || client.hasPendingSave}
                run={run}
                onChanged={refreshLists}
              />
            </>
          ) : (
            <VaultPanel label="Choose a Vault" className="vault-empty">
              <div className="vault-empty-icon">
                <FolderLock size={32} aria-hidden />
              </div>
              <h2 className="font-semibold">Choose or create a Vault</h2>
              <p className="text-sm text-muted">
                Your Internet Identity provides access. No separate Vault
                credential is needed.
              </p>
            </VaultPanel>
          )}
        </div>
      </div>
      <div className="vault-management-grid">
        <details className="vault-disclosure [&:not([open])>div]:hidden">
          <summary>
            <Wallet size={17} aria-hidden />
            Account &amp; storage
            <ChevronRight size={16} aria-hidden />
          </summary>
          <div className="vault-disclosure-body">
            <VaultPanel label="Vault account">
              <p className="font-semibold">
                Prepaid balance: {balance.toString()} cycles
              </p>
              <p className="break-all text-sm">
                Vault principal: {client.identity.getPrincipal().toText()}
              </p>
              <VaultButton
                disabled={busy}
                onClick={() => run(refreshConfiguration)}
              >
                Refresh balance
              </VaultButton>
              {capacity ? (
                <p className="text-sm">
                  Shared capacity: {capacity.used.toLocaleString()} /{" "}
                  {capacity.limit.toLocaleString()} bytes. Storage includes
                  ciphertext, history and pending operations. Funding does not
                  increase storage limits.
                  {capacity.overcommitted
                    ? " Capacity is overcommitted; cleanup remains available."
                    : ""}
                </p>
              ) : (
                <output>Checking shared storage capacity…</output>
              )}
              {capacity ? (
                <Funding
                  key={`funding-${generation}`}
                  client={client}
                  onFunded={refreshConfiguration}
                />
              ) : null}
            </VaultPanel>
          </div>
        </details>
        <details className="vault-disclosure [&:not([open])>div]:hidden">
          <summary className="cursor-pointer text-sm font-medium">
            Interrupted uploads
          </summary>
          <div className="vault-disclosure-body">
            <p className="text-sm">
              Cancel unfinished uploads with zero prepaid balance.
            </p>
            <VaultButton disabled={busy} onClick={() => run(refreshLists)}>
              Refresh interrupted uploads
            </VaultButton>
            {pendingUploads.map((upload, index) => (
              <VaultButton
                key={b64(bytes(upload.upload))}
                disabled={busy || client.hasPendingSave}
                onClick={() =>
                  run(async () => {
                    const ticket = client.session.capture();
                    try {
                      await client.cancelUpload(
                        bytes(upload.vault),
                        bytes(upload.upload),
                        upload.cancel_job[0]
                          ? bytes(upload.cancel_job[0])
                          : undefined,
                      );
                    } catch (cause) {
                      client.session.check(ticket);
                      if (
                        cause instanceof Error &&
                        ["Conflict", "NotFound"].includes(cause.message)
                      )
                        await refreshLists();
                      throw cause;
                    }
                    client.session.check(ticket);
                    await refreshLists();
                  })
                }
              >
                Cancel interrupted upload {index + 1}
              </VaultButton>
            ))}
            {uploadAfter ? (
              <VaultButton
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const ticket = client.session.capture();
                    const page = await client.pendingUploads(
                      new Uint8Array(uploadAfter),
                    );
                    client.session.check(ticket);
                    setPendingUploads((previous) => [
                      ...previous,
                      ...page.entries,
                    ]);
                    setUploadAfter(
                      page.next[0] ? bytes(page.next[0]) : undefined,
                    );
                  })
                }
              >
                Load more interrupted uploads
              </VaultButton>
            ) : null}
          </div>
        </details>
      </div>
      <p className="vault-trust-note">
        <LockKeyhole size={14} aria-hidden />
        Select a Vault to open it with your current Internet Identity. Private
        views close after 5 minutes of inactivity or 1 minute in a hidden tab.
        Sign out to end authentication. Your browser and the canister updater
        remain trusted.
      </p>
    </div>
  );
}
