"use client";

import { useVaultAuth } from "../auth";

import { identityKey, PrivateVaultClient } from "./private-session";
import { VaultWorkspace } from "./workspace";
import { FileKey2, FolderLock, KeyRound, ShieldCheck } from "lucide-react";

export default function VaultPage() {
  const { identity, loading } = useVaultAuth();
  return (
    <main className="vault-page">
      {identity && !loading ? (
        <PrivateVaultClient
          key={identityKey(identity)}
          identity={identity}
          fallback={<output>Connecting to Private Vault…</output>}
          failed={
            <output>
              Private Vault could not connect. Reload to try again.
            </output>
          }
        >
          {(client) => <VaultWorkspace client={client} />}
        </PrivateVaultClient>
      ) : (
        <section className="vault-welcome vault-panel">
          <div className="vault-empty-icon">
            <FolderLock size={36} aria-hidden />
          </div>
          <p className="vault-eyebrow">YOUR PRIVATE WORKSPACE</p>
          <h1 className="text-3xl font-semibold tracking-tight">
            A space for what stays private.
          </h1>
          <p className="max-w-md text-sm leading-6 text-muted">
            Sign in with Internet Identity to access your private Vaults.
          </p>
          <div className="vault-welcome-features">
            <span>
              <ShieldCheck size={19} aria-hidden />
              Browser encryption
            </span>
            <span>
              <KeyRound size={19} aria-hidden />
              Internet Identity access
            </span>
            <span>
              <FileKey2 size={19} aria-hidden />
              Private documents
            </span>
          </div>
        </section>
      )}
    </main>
  );
}
