// Where: wikibrowser IC host helpers.
// What: classifies local replica hosts shared by wallet and UI code.
// Why: local wallet behavior must not accidentally target mainnet gateways.

export const LOCAL_OISY_UNAVAILABLE_MESSAGE = "OISY hosted signer is unavailable for local replica";

export function isLocalIcHost(host: string): boolean {
  try {
    const { hostname } = new URL(host);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function configuredIcHost(): string {
  return process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
}
