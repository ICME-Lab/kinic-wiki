const HOURS_PER_DAY = BigInt(24);
const NANOSECONDS_PER_HOUR = BigInt(3_600_000_000_000);
const DELEGATION_DAYS = 30;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_LOCAL_WIKI_IC_HOST = "http://127.0.0.1:8011";
const CANISTER_ID_PATTERN = /^[a-z0-9-]+$/;

export const DELEGATION_TTL_NS = BigInt(DELEGATION_DAYS) * HOURS_PER_DAY * NANOSECONDS_PER_HOUR;
export const MAINNET_II_PROVIDER_URL = "https://id.ai";
export const DERIVATION_ORIGIN = "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io";
export const AUTH_CLIENT_CREATE_OPTIONS = {
  idleOptions: {
    idleTimeout: DELEGATION_DAYS * MILLISECONDS_PER_DAY,
    disableDefaultIdleCallback: true
  }
};

type LocationLike = {
  hostname: string;
  origin: string;
};

function currentLocation(): LocationLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.location;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
}

function localHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !isLocalHostname(url.hostname)) {
    return null;
  }
  return url;
}

function localIiE2eEnabled(): boolean {
  return publicEnv("VITE_ENABLE_LOCAL_II_E2E") === "1";
}

export function identityProviderUrl(): string {
  const providerUrl = publicEnv("VITE_II_PROVIDER_URL");
  if (localIiE2eEnabled() && providerUrl) {
    return providerUrl;
  }
  return MAINNET_II_PROVIDER_URL;
}

export function derivationOriginUrl(locationLike: LocationLike | null = currentLocation()): string {
  if (!localIiE2eEnabled()) {
    return DERIVATION_ORIGIN;
  }
  if (!locationLike || !isLocalHostname(locationLike.hostname)) {
    return DERIVATION_ORIGIN;
  }
  const canisterId = publicEnv("VITE_KINIC_WIKI_CANISTER_ID") ?? "";
  if (!CANISTER_ID_PATTERN.test(canisterId)) {
    return DERIVATION_ORIGIN;
  }
  const wikiHost = publicEnv("VITE_WIKI_IC_HOST") || DEFAULT_LOCAL_WIKI_IC_HOST;
  const wikiUrl = localHttpUrl(wikiHost);
  if (!wikiUrl) {
    return DERIVATION_ORIGIN;
  }
  return `http://${canisterId}.localhost:${wikiUrl.port || "80"}`;
}

function publicEnv(name: keyof ImportMetaEnv): string | undefined {
  const viteValue = import.meta.env?.[name];
  if (viteValue !== undefined) return viteValue;
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

export function authLoginOptions() {
  return {
    identityProvider: identityProviderUrl(),
    derivationOrigin: derivationOriginUrl(),
    maxTimeToLive: DELEGATION_TTL_NS
  };
}
