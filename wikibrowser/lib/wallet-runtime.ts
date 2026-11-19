// Where: wikibrowser wallet runtime policy.
// What: centralizes IC host and wallet runtime decisions.
// Why: wallet calls need one host source across UI and approval flows.
import { IDL } from "@icp-sdk/core/candid";
import { idlFactory } from "@kinic/vfs-candid";
import { createWalletSessionManager } from "@kinic/payments/wallet-session";
import type { FundingTransport } from "@kinic/payments/wallet-types";
import type { DatabaseCyclesPurchaseRequest, RawCyclesPurchaseResult, VfsActor } from "./vfs-client/raw-types";
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

export function createWikiWalletSession(temporary = false) {
  return createWalletSessionManager({
    ...(temporary ? { storage: null, legacyStorage: null } : {}),
    origin: typeof window === "undefined" ? "http://localhost" : window.location.origin,
    host: configuredIcHost(),
    signerUrl: import.meta.env.VITE_OISY_SIGNER_URL ?? "https://oisy.com/sign"
  });
}

export function wikiPaymentScopes(canisterId: string, ledger: string) {
  return [
    { canisterId, methods: ["purchase_database_cycles", "list_database_cycles_pending_purchases", "market_purchase_access"] },
    { canisterId: ledger, methods: ["icrc2_approve"] }
  ];
}

type WikiActor = VfsActor & { purchase_database_cycles(request: DatabaseCyclesPurchaseRequest): Promise<{ Ok: RawCyclesPurchaseResult } | { Err: string }> };

type FundingMethod = "purchase_database_cycles" | "list_database_cycles_pending_purchases" | "market_purchase_access";

export async function callWikiWithPayer<M extends FundingMethod>(
  transport: FundingTransport, canisterId: string, method: M,
  args: Parameters<WikiActor[M]>, isCurrent?: () => boolean
): Promise<Awaited<ReturnType<WikiActor[M]>>> {
  const signature = idlFactory({ IDL })._fields.find(([name]) => name === method)![1];
  const reply = await transport.call({
    canisterId, method, mode: method === "list_database_cycles_pending_purchases" ? "query" : "update",
    interfaceFactory: idlFactory, arg: IDL.encode(signature.argTypes, args), isCurrent
  });
  const [result] = IDL.decode(signature.retTypes, reply);
  return result as Awaited<ReturnType<WikiActor[M]>>;
}
