"use client";

import { useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { useVaultAuth } from "../auth";

import { identityKey, PrivateVaultClient } from "./private-session";
import { VaultWorkspace } from "./workspace";
import { FileKey2, FolderLock, KeyRound, ShieldCheck } from "lucide-react";
import {VaultNavigationScope,useVaultNavigation} from "../navigation";
import {VaultHelp,VaultNotFound} from "../help";
import { VaultButton } from "./ui";

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
  const [attempt, setAttempt] = useState(0);
  return (
    <PrivateVaultClient
      key={attempt}
      identity={identity}
      fallback={<output className="vault-connecting">Connecting to Private Vault…</output>}
      failed={
        <section className="vault-connecting" role="alert">
          <p>Private Vault could not connect.</p>
          <VaultButton onClick={() => setAttempt((value) => value + 1)}>Retry connection</VaultButton>
        </section>
      }
    >
      {(client) => <VaultWorkspace client={client} />}
    </PrivateVaultClient>
  );
}
