"use client";

import { useLayoutEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import type { VaultClient } from "@kinic/vault-client";
import { useVaultAuth } from "../auth";

import { createPrivateVaultClient } from "./actor";
import { VaultWorkspace } from "./workspace";

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
    <main className="mx-auto max-w-6xl p-5">
      {identity && !loading ? (
        <PrivateSession key={identityKey(identity)} identity={identity} />
      ) : (
        <section className="rounded-xl border border-line bg-white p-5">
          <h1 className="text-xl font-semibold">Private Vault</h1>
          <p className="mt-2 text-sm text-muted">
            Sign in with Internet Identity to access your private Vaults.
          </p>
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
