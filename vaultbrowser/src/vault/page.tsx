"use client";

import { useLayoutEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import type { VaultClient } from "@kinic/vault-client";
import { useVaultAuth } from "../auth";

import { createPrivateVaultClient } from "./actor";
import { VaultWorkspace } from "./workspace";
import { FileKey2, FolderLock, KeyRound, ShieldCheck } from "lucide-react";

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
export default function VaultPage() {
  const { identity, loading } = useVaultAuth();
  return (
    <main className="vault-page">
      {identity && !loading ? (
        <PrivateSession key={identityKey(identity)} identity={identity} />
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
function PrivateSession({ identity }: { identity: Identity }) {
  const [client, setClient] = useState<VaultClient>();
  const [failed, setFailed] = useState(false);
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
  }, [identity]);
  if (!client)
    return (
      <output>
        {failed
          ? "Private Vault could not connect. Reload to try again."
          : "Connecting to Private Vault…"}
      </output>
    );
  return <VaultWorkspace client={client} />;
}
