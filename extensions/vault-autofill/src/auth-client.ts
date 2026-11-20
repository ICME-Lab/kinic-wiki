// Where: extensions/vault-autofill/src/auth-client.ts
// What: Dedicated Internet Identity AuthClient wrapper for the Kinic Vault extension.
// Why: Run AuthClient only in DOM-capable extension contexts (popup/offscreen), never the service worker,
//      and derive the exact same Vault principal as https://vault.kinic.xyz and iOS Vault.
import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import { RUNTIME_CONFIG, validateVaultRuntimeConfig } from "./runtime-config.ts";

// 7-day delegation TTL (well below II's 30-day maximum). Unlocked vault keys still
// auto-lock separately according to the user's idle timeout setting (default 30 min).
const VAULT_DELEGATION_DAYS = 7n;
const NANOSECONDS_PER_DAY = 24n * 60n * 60n * 1_000_000_000n;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const VAULT_AUTH_SESSION_TTL_NS = VAULT_DELEGATION_DAYS * NANOSECONDS_PER_DAY;
export const VAULT_AUTH_SESSION_TTL_MS = Number(VAULT_DELEGATION_DAYS) * MILLISECONDS_PER_DAY;

export function buildVaultAuthOptions(config = RUNTIME_CONFIG) {
  const validated = validateVaultRuntimeConfig(config);
  return {
    createOptions: {
      idleOptions: {
        idleTimeout: VAULT_AUTH_SESSION_TTL_MS,
        disableDefaultIdleCallback: true
      }
    },
    loginOptions: {
      identityProvider: validated.identityProvider,
      derivationOrigin: validated.derivationOrigin,
      maxTimeToLive: VAULT_AUTH_SESSION_TTL_NS,
      windowOpenerFeatures:
        "toolbar=0,location=0,menubar=0,width=500,height=640,left=120,top=100"
    }
  };
}

export type AuthSnapshot = {
  isAuthenticated: boolean;
  identity: Identity | null;
  principal: string | null;
};

let clientPromise: Promise<AuthClient> | null = null;

export function getAuthClient(): Promise<AuthClient> {
  if (!clientPromise) {
    const { createOptions } = buildVaultAuthOptions();
    clientPromise = AuthClient.create(createOptions);
  }
  return clientPromise;
}

export function resetAuthClient(): void {
  clientPromise = null;
}

export async function authSnapshot(): Promise<AuthSnapshot> {
  const client = await getAuthClient();
  const authenticated = await client.isAuthenticated();
  if (!authenticated) {
    return { isAuthenticated: false, identity: null, principal: null };
  }
  const identity = client.getIdentity();
  const principal = identity.getPrincipal();
  if (principal.isAnonymous()) {
    return { isAuthenticated: false, identity: null, principal: null };
  }
  return {
    isAuthenticated: true,
    identity,
    principal: principal.toText()
  };
}

export async function loginWithInternetIdentity(): Promise<AuthSnapshot> {
  const client = await getAuthClient();
  const { loginOptions } = buildVaultAuthOptions();
  await new Promise<void>((resolve, reject) => {
    client.login({
      ...loginOptions,
      onSuccess: () => resolve(),
      onError: (error) =>
        reject(new Error(error ? String(error) : "Internet Identity sign-in failed."))
    });
  });
  const snapshot = await authSnapshot();
  if (!snapshot.isAuthenticated || !snapshot.principal) {
    throw new Error("Internet Identity returned an anonymous principal.");
  }
  return snapshot;
}

export async function logoutInternetIdentity(): Promise<AuthSnapshot> {
  const client = await getAuthClient();
  await client.logout();
  resetAuthClient();
  return { isAuthenticated: false, identity: null, principal: null };
}
