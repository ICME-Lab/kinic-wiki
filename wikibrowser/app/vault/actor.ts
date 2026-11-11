import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { idlFactory } from "@kinic/vfs-candid";
import { isLocalReplicaHost } from "@kinic/vfs-client-core";
import { VaultClient } from "@kinic/vault-client";
import type { VaultActor } from "@kinic/vault-client/contracts";
import type { RawDatabaseSummary } from "@/lib/vfs-client/raw-types";

export const vaultMethods = [
  "abort_export",
  "activate_vault",
  "begin_export",
  "begin_restore",
  "begin_restore_revision",
  "begin_revision",
  "begin_unlock",
  "cancel_vault_setup",
  "collect_garbage",
  "commit_restore",
  "commit_restore_revision",
  "commit_revision",
  "delete_object",
  "derive_vault_key",
  "export_index",
  "finish_export",
  "get_active_export_for_vault",
  "get_chunk",
  "get_export_chunk",
  "get_manifest",
  "get_quota",
  "get_vault_header",
  "list_credentials",
  "list_history",
  "list_objects",
  "list_unfinished_vaults",
  "list_vaults",
  "manage_unlock_credential",
  "prepare_unlock_credential",
  "purge_object",
  "put_chunk",
  "put_restore_chunk",
  "reserve_vault",
  "get_config",
  "get_payer",
  "set_payer",
  "cancel_pending_key_derivation",
] as const satisfies readonly (keyof VaultActor)[];
export type IntegratedVaultActor = {
  [K in keyof VaultActor as `vault_${K}`]: VaultActor[K];
} & {
  list_databases(): Promise<{ Ok: RawDatabaseSummary[] } | { Err: string }>;
};
export function adaptVaultActor(actor: IntegratedVaultActor): VaultActor {
  return Object.fromEntries(
    vaultMethods.map((name) => [
      name,
      (...args: unknown[]) =>
        (actor[`vault_${name}`] as (...args: unknown[]) => unknown)(...args),
    ]),
  ) as VaultActor;
}
export async function createPrivateVaultClient(identity: Identity) {
  const host = import.meta.env.VITE_WIKI_IC_HOST || "https://icp0.io";
  const canister = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID || "";
  const local = isLocalReplicaHost(host);
  const agent = HttpAgent.createSync({ host, identity });
  if (local) await agent.fetchRootKey();
  // No shared Wiki actor, health, query or plaintext cache.
  const actor = Actor.createActor<IntegratedVaultActor>(idlFactory, {
    agent,
    canisterId: canister,
  });
  const client = new VaultClient({
    actor: adaptVaultActor(actor),
    identity,
    canister,
    local,
  });
  client.payerDatabases = async () => {
    const result = await actor.list_databases();
    if (!("Ok" in result)) throw Error("RequestFailed");
    return result.Ok.filter(
      (db) => "Owner" in db.role && "Active" in db.status,
    ).map((db) => ({ id: db.database_id, name: db.name }));
  };
  return client;
}
