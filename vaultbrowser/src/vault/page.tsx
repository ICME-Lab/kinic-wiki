"use client";

import { useLayoutEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import type { VaultClient } from "@kinic/vault-client";
import { useVaultAuth } from "../auth";

import { createPrivateVaultClient } from "./actor";
import { VaultWorkspace } from "./workspace";
import { FileKey2, FolderLock, KeyRound, ShieldCheck } from "lucide-react";
import {VaultNavigationScope,useVaultNavigation} from "../navigation";
import {VaultHelp,VaultNotFound} from "../help";
import { VaultButton } from "./ui";

// Identity object identity matters even when a refreshed delegation has the same principal.
const identityIds = new WeakMap<Identity, number>();
let nextIdentityId = 0;
function identityKey(identity: Identity) {
  let id = identityIds.get(identity);
  if (id === undefined) {
    id = ++nextIdentityId;
    identityIds.set(identity, id);
  }
  return `${identity.getPrincipal().toText()}:${id}`;
}
export function VaultWelcome({
  onSignIn,
  signInDisabled = false,
}: {
  onSignIn?: () => void;
  signInDisabled?: boolean;
}) {
  return (
    <section className="vault-welcome" aria-labelledby="vault-welcome-title">
      <div className="vault-welcome-hero">
        <div className="vault-welcome-mark">
          <FolderLock size={30} aria-hidden />
        </div>
        <p className="vault-eyebrow">Your private workspace</p>
        <h1 id="vault-welcome-title">Private Vault</h1>
        <p className="vault-welcome-lede">
          Sign in with Internet Identity and create your Vault. Your notes,
          credentials and files are encrypted in your
          browser before they are stored.
        </p>
        {onSignIn ? (
          <VaultButton
            tone="primary"
            size="lg"
            disabled={signInDisabled}
            onClick={onSignIn}
          >
            <KeyRound size={17} aria-hidden />
            Continue with Internet Identity
          </VaultButton>
        ) : null}
      </div>
      <ul className="vault-welcome-features">
        <li>
          <ShieldCheck size={20} aria-hidden />
          <strong>Browser encryption</strong>
          <span>Documents are encrypted on this device before upload.</span>
        </li>
        <li>
          <KeyRound size={20} aria-hidden />
          <strong>Internet Identity access</strong>
          <span>No extra Vault password or passkey to remember.</span>
        </li>
        <li>
          <FileKey2 size={20} aria-hidden />
          <strong>Private documents</strong>
          <span>Notes, credentials and attachments with version history.</span>
        </li>
      </ul>
    </section>
  );
}
export default function VaultPage(){return <VaultNavigationScope><VaultPageContent/></VaultNavigationScope>;}
function VaultPageContent() {
  const nav=useVaultNavigation();
  const { identity, loading, ready, login } = useVaultAuth();
  return (
    <main className="vault-page" id="vault-main" tabIndex={-1}>
      {identity && !loading ? (
        <PrivateSession key={identityKey(identity)} identity={identity} />
      ) : nav.view === "help" ? <VaultHelp/> : nav.view === "not-found" ? <VaultNotFound/> : (
        <VaultWelcome
          onSignIn={login}
          signInDisabled={loading || !ready}
        />
      )}
    </main>
  );
}
function PrivateSession({ identity }: { identity: Identity }) {
  const [client, setClient] = useState<VaultClient>();
  const [failed, setFailed] = useState(false);
  const [attempt,setAttempt]=useState(0);
  useLayoutEffect(() => {
    let disposed = false;
    let current: VaultClient | undefined;
    void createPrivateVaultClient(identity)
      .then((value) => {
        if (disposed) {
          value.destroy();
          return;
        }
        current = value;
        setClient(value);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      current?.destroy();
    };
  }, [identity,attempt]);
  if (!client)
    return (
      failed ? <section className="vault-connecting" role="alert"><p>Private Vault could not connect.</p><VaultButton onClick={()=>{setFailed(false);setAttempt(value=>value+1);}}>Retry connection</VaultButton></section>
      : <output className="vault-connecting">Connecting to Private Vault…</output>
    );
  return <VaultWorkspace client={client} />;
}
