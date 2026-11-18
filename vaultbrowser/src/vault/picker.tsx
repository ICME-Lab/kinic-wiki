import { useCallback, useEffect, useRef, useState } from "react";
import { bytes, type Item, type VaultClient } from "@kinic/vault-client";
import type { VaultAccess } from "@kinic/vault-client/contracts";
import { useVaultAuth } from "../auth";
import { CANONICAL_WIKI_ORIGIN, loadConfig } from "../config";
import {
  identityKey,
  PrivateVaultClient,
  useIsolatedVaultSession,
} from "./private-session";
import {
  connectWikiPicker,
  encodeId,
  sendVaultSelection,
  type WikiOpener,
} from "./routes";
import { VaultButton } from "./ui";

export function VaultPickerPage() {
  const [opener, setOpener] = useState<WikiOpener>();
  const { identity, loading, ready, error, login, logout } = useVaultAuth();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let cancel: (() => void) | undefined;
    if (!window.opener || window.top !== window) return;
    void loadConfig()
      .then((config) => {
        const origin = config.local ? config.wikiOrigin : CANONICAL_WIKI_ORIGIN;
        if (disposed || !origin) return;
        cancel = connectWikiPicker(origin, setOpener);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      cancel?.();
    };
  }, []);
  return (
    <main className="vault-isolated vault-isolated--picker">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Select a Vault document</h1>
        {opener && identity ? (
          <VaultButton onClick={logout}>Sign out</VaultButton>
        ) : null}
      </header>
      {!opener ? (
        <p>Open this picker from Wiki.</p>
      ) : identity && !loading ? (
        <PrivateVaultClient
          key={`${identityKey(identity)}-${attempt}`}
          identity={identity}
          fallback={<output>Connecting to Private Vault…</output>}
          failed={
            <>
              <p>Vault is unavailable.</p>
              <VaultButton onClick={() => setAttempt((value) => value + 1)}>
                Retry
              </VaultButton>
            </>
          }
        >
          {(client) => <VaultPickerDocuments client={client} opener={opener} />}
        </PrivateVaultClient>
      ) : (
        <>
          <p>Sign in to choose a private document.</p>
          <VaultButton
            tone="primary"
            disabled={loading || !ready}
            onClick={login}
          >
            Sign in with Internet Identity
          </VaultButton>
          {error ? <p role="alert">{error}</p> : null}
        </>
      )}
    </main>
  );
}

function VaultPickerDocuments({
  client,
  opener,
}: {
  client: VaultClient;
  opener: WikiOpener;
}) {
  const [vaults, setVaults] = useState<VaultAccess[]>([]);
  const [after, setAfter] = useState<Uint8Array>();
  const [selected, setSelected] = useState<string>();
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const privateDOM = useRef<HTMLElement>(null);
  const reset = useCallback(() => {
    setSelected(undefined);
    setItems([]);
    setLoading(false);
    busy.current = false;
  }, []);
  useIsolatedVaultSession(client, privateDOM, reset);
  const run = useCallback(
    (operation: () => Promise<void>) => {
      if (busy.current) return;
      setError("");
      const pending = operation();
      const ticket = client.session.capture();
      setLoading(true);
      busy.current = true;
      void pending
        .catch(() => {
          if (ticket === client.session.capture())
            setError("Private Vault data is unavailable. Try again.");
        })
        .finally(() => {
          if (ticket !== client.session.capture()) return;
          setLoading(false);
          busy.current = false;
        });
    },
    [client],
  );
  const load = useCallback(
    async (cursor?: Uint8Array) => {
      const ticket = client.session.capture();
      const page = await client.listAccessibleVaults(cursor);
      client.session.check(ticket);
      setVaults((previous) =>
        cursor
          ? [
              ...previous,
              ...page.entries.filter(
                (entry) =>
                  !previous.some(
                    (v) => encodeId(v.header.id) === encodeId(entry.header.id),
                  ),
              ),
            ]
          : page.entries,
      );
      setAfter(page.next[0] ? bytes(page.next[0]) : undefined);
      if (cursor || !client.session.root) return;
      const activeId = client.header && encodeId(client.header.id);
      if (
        !page.next.length &&
        !page.entries.some(({ header }) => encodeId(header.id) === activeId)
      ) {
        client.session.lock();
        return;
      }
      // The open Vault may lie beyond the first page. Check that exact grant.
      try {
        await client.refreshHeader();
      } catch (error) {
        if (ticket === client.session.capture()) client.session.lock();
        throw error;
      }
    },
    [client],
  );
  useEffect(() => run(() => load()), [load, run]);
  const open = async (entry: VaultAccess) => {
    const pending = client.openAccess(bytes(entry.header.id));
    const ticket = client.session.capture();
    setSelected(encodeId(entry.header.id));
    setItems([]);
    await pending;
    client.session.check(ticket);
    const documents = await client.items({ includeDeleted: false });
    client.session.check(ticket);
    setItems(documents);
  };
  const choose = async (item: Item) => {
    const ticket = client.session.capture();
    const revision = await client.latest(bytes(item.revision.object));
    client.session.check(ticket);
    if (
      !sendVaultSelection(opener, {
        vault: encodeId(revision.vault),
        object: encodeId(revision.object),
      })
    )
      throw Error("OpenerUnavailable");
    client.session.lock();
    window.close();
  };
  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-dangerText">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {vaults.map((entry, index) => {
          const { header, role } = entry;
          return "Active" in header.state ? (
            <VaultButton
              key={encodeId(header.id)}
              disabled={loading}
              aria-pressed={selected === encodeId(header.id)}
              onClick={() => run(() => open(entry))}
            >
              Vault {index + 1} · {Object.keys(role)[0]}
            </VaultButton>
          ) : null;
        })}
        {after ? (
          <VaultButton
            disabled={loading}
            onClick={() => run(() => load(after))}
          >
            Load more Vaults
          </VaultButton>
        ) : null}
        <VaultButton disabled={loading} onClick={() => run(() => load())}>
          Refresh Vaults
        </VaultButton>
      </div>
      {loading ? <output>Opening Vault…</output> : null}
      {selected && items.length ? (
        <section
          ref={privateDOM}
          aria-label="Private documents"
          className="grid gap-2 border-t border-line pt-3"
        >
          {items.map((item) => (
            <VaultButton
              key={encodeId(item.revision.object)}
              disabled={loading}
              className="justify-start break-words text-left"
              onClick={() => run(() => choose(item))}
            >
              {item.metadata.title || "Untitled"}
            </VaultButton>
          ))}
        </section>
      ) : selected && !loading && !error ? (
        <p>No documents in this Vault.</p>
      ) : null}
    </>
  );
}
