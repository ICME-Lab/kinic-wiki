// Where: shared/ii-auth/index.js
// What: Shared Internet Identity constants and browser-safe validation helpers.
// Why: Chrome extension auth and canister-hosted CLI login must derive the same principal.
export const MAINNET_II_PROVIDER_URL = "https://id.ai";
export const WIKI_CANISTER_DERIVATION_ORIGIN = "https://xis3j-paaaa-aaaai-axumq-cai.icp0.io";

const AUTH_SESSION_DAYS = 29;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const NANOSECONDS_PER_DAY = BigInt(24 * 60 * 60) * BigInt(1_000_000_000);
export const AUTH_SESSION_TTL_MS = AUTH_SESSION_DAYS * MILLISECONDS_PER_DAY;
export const AUTH_SESSION_TTL_NS = BigInt(AUTH_SESSION_DAYS) * NANOSECONDS_PER_DAY;

export const CLI_DELEGATION_TTL_MS = 8 * 60 * 60 * 1000;
export const CLI_DELEGATION_TTL_NS = BigInt(CLI_DELEGATION_TTL_MS) * 1_000_000n;

export function authClientCreateOptions(idleTimeoutMs = AUTH_SESSION_TTL_MS) {
  return {
    idleOptions: {
      idleTimeout: idleTimeoutMs,
      disableDefaultIdleCallback: true
    }
  };
}

export function identityProviderUrlForLocation(locationLike) {
  const hostname = locationLike?.hostname ?? "";
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) {
    return `http://id.ai.localhost:${locationLike?.port || "8000"}`;
  }
  return MAINNET_II_PROVIDER_URL;
}

export function derivationOriginForLocation(locationLike) {
  const hostname = locationLike?.hostname ?? "";
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) {
    return locationLike.origin;
  }
  return WIKI_CANISTER_DERIVATION_ORIGIN;
}

export function parseCliLoginHash(hash) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const publicKey = params.get("public_key") ?? "";
  const callback = params.get("callback") ?? "";
  if (!publicKey || !callback || !isLoopbackHttpCallback(callback)) {
    return null;
  }
  try {
    if (decodeBase64UrlToBytes(publicKey).length < 32) {
      return null;
    }
  } catch {
    return null;
  }
  return { publicKey, callback };
}

export function decodeBase64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error("public key is not base64url");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(paddingLength);
  if (typeof atob === "function") {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

export function isLoopbackHttpCallback(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.username || url.password) {
    return false;
  }
  return (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
}
