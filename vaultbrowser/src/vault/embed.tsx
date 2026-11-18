import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bytes, type Item, type VaultClient } from "@kinic/vault-client";
import { useVaultAuth } from "../auth";
import {
  identityKey,
  PrivateVaultClient,
  useIsolatedVaultSession,
} from "./private-session";
import { decodeId, encodeId, type VaultIds } from "./routes";
import {
  parseCredential,
  VaultReadOnly,
  type ReadOnlyContent,
} from "./read-only";
import { VaultButton } from "./ui";

function Unavailable() {
  return <p role="status">This private document is unavailable.</p>;
}

export function VaultEmbedPage({ ids }: { ids?: VaultIds }) {
  const auth = useVaultAuth();
  const [attempt, setAttempt] = useState(0);
  const target = useMemo(
    () =>
      ids
        ? { vault: decodeId(ids.vault), object: decodeId(ids.object) }
        : undefined,
    [ids],
  );
  const embedded = window.top !== window;
  const signedIn = auth.identity && !auth.loading;
  return (
    <main className="vault-isolated">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Private document</h1>
        {target && signedIn ? (
          <VaultButton onClick={auth.logout}>Sign out</VaultButton>
        ) : null}
      </header>
      {target && signedIn ? (
        <PrivateVaultClient
          key={`${identityKey(auth.identity!)}-${attempt}`}
          identity={auth.identity!}
          failed={
            <>
              <Unavailable />
              <VaultButton onClick={() => setAttempt((value) => value + 1)}>
                Retry
              </VaultButton>
            </>
          }
          fallback={<output>Opening private document…</output>}
        >
          {(client) => <VaultEmbedDocument client={client} {...target} />}
        </PrivateVaultClient>
      ) : (
        <>
          <Unavailable />
          {target ? (
            <>
              <VaultButton
                tone="primary"
                disabled={auth.loading || !auth.ready}
                onClick={auth.login}
              >
                Sign in with Internet Identity
              </VaultButton>
              {embedded ? (
                <div className="grid justify-items-start gap-2">
                  <a
                    className="underline underline-offset-2"
                    href={location.pathname}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in Vault to sign in
                  </a>
                  <VaultButton onClick={() => location.reload()}>
                    Retry in this page
                  </VaultButton>
                </div>
              ) : null}
              {auth.error ? <output>{auth.error}</output> : null}
            </>
          ) : null}
        </>
      )}
    </main>
  );
}

type Loaded = { item: Item; content: ReadOnlyContent };
export function VaultEmbedDocument({
  client,
  vault,
  object,
}: {
  client: VaultClient;
  vault: Uint8Array;
  object: Uint8Array;
}) {
  const [doc, setDoc] = useState<Loaded>();
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const privateDOM = useRef<HTMLElement>(null);
  const busy = useRef(false);
  const visibleRevision = useRef<bigint | undefined>(undefined);
  const loadSerial = useRef(0);
  const reset = useCallback(() => {
    visibleRevision.current = undefined;
    setDoc(undefined);
    setLoading(false);
    setDownloading(false);
    busy.current = false;
  }, []);
  const loadDocument = useCallback(async () => {
    const ticket = client.session.capture();
    const serial = ++loadSerial.current;
    const revision = await client.latest(object);
    client.session.check(ticket);
    if (
      serial !== loadSerial.current ||
      visibleRevision.current === revision.revision
    )
      return;
    const item = await client.readItem(revision);
    const body =
      item.metadata.kind === "attachment"
        ? undefined
        : await client.read(item.revision);
    const wipeBody = () => body?.plaintext.fill(0);
    const detach = body && client.session.addLockCleanup(wipeBody);
    try {
      client.session.check(ticket);
      if (serial !== loadSerial.current) return;
      // The document can disappear or change while its chunks are being read.
      const head = await client.latest(object);
      client.session.check(ticket);
      if (serial !== loadSerial.current) return;
      if (head.revision !== revision.revision) throw Error("TargetChanged");
      let content: ReadOnlyContent = { kind: "attachment" };
      if (body) {
        const text = new TextDecoder().decode(body.plaintext);
        content =
          item.metadata.kind === "credential"
            ? parseCredential(text)
            : { kind: "note", body: text };
      }
      visibleRevision.current = revision.revision;
      setDoc({ item, content });
      setLoading(false);
    } finally {
      wipeBody();
      detach?.();
    }
  }, [client, object]);
  useIsolatedVaultSession(client, privateDOM, reset, loadDocument);
  useLayoutEffect(() => {
    const pending = client.openAccess(vault);
    const ticket = client.session.capture();
    setLoading(true);
    void pending
      .then(() => {
        client.session.check(ticket);
        return loadDocument();
      })
      .catch(() => {
        if (ticket === client.session.capture()) client.session.lock();
      });
    return () => {
      client.session.lock();
    };
  }, [client, vault, loadDocument, attempt]);
  const download = () => {
    if (busy.current || !doc) return;
    const ticket = client.session.capture();
    busy.current = true;
    setDownloading(true);
    void (async () => {
      const latest = await client.latest(object);
      client.session.check(ticket);
      if (latest.revision !== doc.item.revision.revision)
        throw Error("TargetChanged");
      const result = await client.read(latest);
      const wipe = () => result.plaintext.fill(0);
      const detach = client.session.addLockCleanup(wipe);
      try {
        client.session.check(ticket);
        const head = await client.latest(object);
        client.session.check(ticket);
        if (head.revision !== latest.revision) throw Error("TargetChanged");
        const file = `document-${encodeId(bytes(object))}`;
        client.session.download(
          result.plaintext,
          result.metadata.filename || file,
        );
      } finally {
        wipe();
        detach();
      }
    })()
      .catch(() => {
        if (ticket === client.session.capture()) client.session.lock();
      })
      .finally(() => {
        if (ticket !== client.session.capture()) return;
        busy.current = false;
        setDownloading(false);
      });
  };
  if (loading) return <output>Opening private document…</output>;
  if (!doc)
    return (
      <>
        <Unavailable />
        <VaultButton onClick={() => setAttempt((value) => value + 1)}>
          Retry
        </VaultButton>
      </>
    );
  return (
    <article
      ref={privateDOM}
      className="grid min-w-0 gap-3 border-t border-line pt-3"
    >
      <h2 className="break-words text-xl font-semibold">
        {doc.item.metadata.title || "Untitled"}
      </h2>
      <VaultReadOnly
        key={doc.item.revision.revision.toString()}
        content={doc.content}
      />
      {doc.content.kind === "attachment" ? (
        <VaultButton
          className="justify-self-start"
          disabled={downloading}
          onClick={download}
        >
          Download attachment
        </VaultButton>
      ) : null}
    </article>
  );
}
