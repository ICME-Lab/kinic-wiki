const HOURS_PER_DAY = BigInt(24);
const NANOSECONDS_PER_HOUR = BigInt(3_600_000_000_000);
const DELEGATION_DAYS = 29;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const DELEGATION_TTL_NS = BigInt(DELEGATION_DAYS) * HOURS_PER_DAY * NANOSECONDS_PER_HOUR;
export const MAINNET_II_PROVIDER_URL = "https://id.ai";
export const DERIVATION_ORIGIN = "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io";
export const AUTH_CLIENT_CREATE_OPTIONS = {
  idleOptions: {
    idleTimeout: DELEGATION_DAYS * MILLISECONDS_PER_DAY,
    disableDefaultIdleCallback: true
  }
};

export function identityProviderUrl(): string {
  return MAINNET_II_PROVIDER_URL;
}

export function authLoginOptions() {
  return {
    identityProvider: identityProviderUrl(),
    derivationOrigin: DERIVATION_ORIGIN,
    maxTimeToLive: DELEGATION_TTL_NS
  };
}
