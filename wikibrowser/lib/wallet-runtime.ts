// Where: wikibrowser wallet runtime policy.
// What: centralizes IC host and wallet runtime decisions.
// Why: wallet calls need one host source across UI and approval flows.

export type WalletRuntime = {
  icHost: string;
  localReplica: boolean;
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
    localReplica
  };
}
