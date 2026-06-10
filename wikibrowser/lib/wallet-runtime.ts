// Where: wikibrowser wallet runtime policy.
// What: centralizes IC host and external wallet availability decisions.
// Why: local replica wallet behavior must be explicit and consistent across UI and wallet calls.

export const LOCAL_EXTERNAL_WALLET_UNAVAILABLE_MESSAGE = "External wallets are unavailable for local replica";

export type WalletRuntime = {
  icHost: string;
  localReplica: boolean;
  externalWalletsAvailable: boolean;
  externalWalletUnavailableReason: string | null;
};

export function configuredIcHost(): string {
  return process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
}

export function isLocalIcHost(host: string): boolean {
  try {
    const { hostname } = new URL(host);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function walletRuntime(): WalletRuntime {
  const icHost = configuredIcHost();
  const localReplica = isLocalIcHost(icHost);
  return {
    icHost,
    localReplica,
    externalWalletsAvailable: !localReplica,
    externalWalletUnavailableReason: localReplica ? LOCAL_EXTERNAL_WALLET_UNAVAILABLE_MESSAGE : null
  };
}
