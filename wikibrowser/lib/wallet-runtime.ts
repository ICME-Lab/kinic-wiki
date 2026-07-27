// Where: wikibrowser wallet runtime policy.
// What: centralizes IC host and wallet runtime decisions.
// Why: wallet calls need one host source across UI and approval flows.
import { isLocalReplicaHost } from "@kinic/vfs-client-core";

export type WalletRuntime = {
  icHost: string;
  localReplica: boolean;
};

export function configuredIcHost(): string {
  return import.meta.env.VITE_WIKI_IC_HOST ?? "https://icp0.io";
}

export function isLocalIcHost(host: string): boolean {
  return isLocalReplicaHost(host);
}

export function walletRuntime(): WalletRuntime {
  const icHost = configuredIcHost();
  const localReplica = isLocalIcHost(icHost);
  return {
    icHost,
    localReplica
  };
}
