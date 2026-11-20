// Where: extensions/vault-autofill/src/runtime-config.ts
// What: Build-time Vault canister, derivation origin, and extension ID constants.
// Why: Keep Kinic Vault extension strictly isolated from Kinic Wiki canisters and origins.

declare const __KINIC_VAULT_CANISTER_ID__: string | undefined;
declare const __KINIC_VAULT_IC_HOST__: string | undefined;
declare const __KINIC_VAULT_DERIVATION_ORIGIN__: string | undefined;
declare const __KINIC_VAULT_IDENTITY_PROVIDER__: string | undefined;
declare const __KINIC_VAULT_WEB_ORIGIN__: string | undefined;
declare const __KINIC_VAULT_LOCAL__: boolean | undefined;

export const PRODUCTION_VAULT_CANISTER_ID = "mcx4q-2qaaa-aaaao-qqn3a-cai";
export const PRODUCTION_VAULT_IC_HOST = "https://icp0.io";
export const PRODUCTION_VAULT_DERIVATION_ORIGIN =
  "https://mcx4q-2qaaa-aaaao-qqn3a-cai.icp0.io";
export const PRODUCTION_II_PROVIDER_URL = "https://id.ai";
export const PRODUCTION_VAULT_WEB_ORIGIN = "https://vault.kinic.xyz";
export const EXPECTED_EXTENSION_ID = "dlbffglcocnllllhjaapackocgkaegak";
export const EXPECTED_EXTENSION_ORIGIN = `chrome-extension://${EXPECTED_EXTENSION_ID}`;

// Wiki identifiers that must never be targeted by the Vault extension.
const FORBIDDEN_WIKI_CANISTER_IDS = new Set([
  "6emaw-iyaaa-aaaay-aacka-cai",
  "3ryrw-kyaaa-aaaaf-qgxpq-cai"
]);
const FORBIDDEN_WIKI_HOSTS = new Set([
  "wiki.kinic.xyz",
  "kinic-wiki-browser-staging.hude.workers.dev"
]);

export type VaultRuntimeConfig = {
  canisterId: string;
  icHost: string;
  derivationOrigin: string;
  identityProvider: string;
  vaultWebOrigin: string;
  local: boolean;
};

export const RUNTIME_CONFIG: VaultRuntimeConfig = {
  canisterId:
    typeof __KINIC_VAULT_CANISTER_ID__ === "string" && __KINIC_VAULT_CANISTER_ID__
      ? __KINIC_VAULT_CANISTER_ID__
      : PRODUCTION_VAULT_CANISTER_ID,
  icHost:
    typeof __KINIC_VAULT_IC_HOST__ === "string" && __KINIC_VAULT_IC_HOST__
      ? __KINIC_VAULT_IC_HOST__
      : PRODUCTION_VAULT_IC_HOST,
  derivationOrigin:
    typeof __KINIC_VAULT_DERIVATION_ORIGIN__ === "string" &&
    __KINIC_VAULT_DERIVATION_ORIGIN__
      ? __KINIC_VAULT_DERIVATION_ORIGIN__
      : PRODUCTION_VAULT_DERIVATION_ORIGIN,
  identityProvider:
    typeof __KINIC_VAULT_IDENTITY_PROVIDER__ === "string" &&
    __KINIC_VAULT_IDENTITY_PROVIDER__
      ? __KINIC_VAULT_IDENTITY_PROVIDER__
      : PRODUCTION_II_PROVIDER_URL,
  vaultWebOrigin:
    typeof __KINIC_VAULT_WEB_ORIGIN__ === "string" && __KINIC_VAULT_WEB_ORIGIN__
      ? __KINIC_VAULT_WEB_ORIGIN__
      : PRODUCTION_VAULT_WEB_ORIGIN,
  local: typeof __KINIC_VAULT_LOCAL__ === "boolean" ? __KINIC_VAULT_LOCAL__ : false
};

export function validateVaultRuntimeConfig(config: VaultRuntimeConfig): VaultRuntimeConfig {
  const canisterId = config.canisterId.trim();
  if (!canisterId || FORBIDDEN_WIKI_CANISTER_IDS.has(canisterId)) {
    throw new Error("Invalid Vault canister ID.");
  }

  let derivation: URL;
  let webOrigin: URL;
  let provider: URL;
  let host: URL;
  try {
    derivation = new URL(config.derivationOrigin);
    webOrigin = new URL(config.vaultWebOrigin);
    provider = new URL(config.identityProvider);
    host = new URL(config.icHost);
  } catch {
    throw new Error("Invalid Vault endpoint URL.");
  }

  if (
    FORBIDDEN_WIKI_HOSTS.has(derivation.hostname) ||
    FORBIDDEN_WIKI_HOSTS.has(webOrigin.hostname) ||
    derivation.hostname.includes("6emaw-iyaaa-aaaay-aacka-cai")
  ) {
    throw new Error("Vault extension must not reuse Kinic Wiki origins.");
  }

  if (!config.local) {
    if (
      derivation.protocol !== "https:" ||
      webOrigin.protocol !== "https:" ||
      provider.protocol !== "https:" ||
      host.protocol !== "https:"
    ) {
      throw new Error("Production Vault configuration requires HTTPS origins.");
    }
    const expectedHost = `${canisterId}.icp0.io`;
    if (derivation.hostname !== expectedHost) {
      throw new Error("Vault derivationOrigin must match the configured Vault canister.");
    }
  } else {
    const isLoopback = (hostname: string) =>
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".localhost");
    if (!isLoopback(host.hostname) || !isLoopback(derivation.hostname)) {
      throw new Error("Local Vault configuration must use loopback hosts.");
    }
  }

  return config;
}
