import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VAULT_AUTH_SESSION_TTL_NS,
  buildVaultAuthOptions
} from "../src/auth-client.ts";
import {
  EXPECTED_EXTENSION_ID,
  EXPECTED_EXTENSION_ORIGIN,
  PRODUCTION_II_PROVIDER_URL,
  PRODUCTION_VAULT_CANISTER_ID,
  PRODUCTION_VAULT_DERIVATION_ORIGIN,
  PRODUCTION_VAULT_IC_HOST,
  PRODUCTION_VAULT_WEB_ORIGIN,
  RUNTIME_CONFIG,
  validateVaultRuntimeConfig
} from "../src/runtime-config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function deriveChromeExtensionIdFromBase64Key(base64Spki: string): string {
  const der = Buffer.from(base64Spki, "base64");
  const digest = createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + ((digest[i] >> 4) & 0x0f));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

describe("Vault extension manifest, fixed ID, and auth config", () => {
  it("derives the pinned Vault Chrome extension ID from manifest.json key", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "manifest.json"), "utf8")
    );
    expect(manifest.manifest_version).toBe(3);
    expect(typeof manifest.key).toBe("string");
    const derivedId = deriveChromeExtensionIdFromBase64Key(manifest.key);
    expect(derivedId).toBe(EXPECTED_EXTENSION_ID);
    expect(`chrome-extension://${derivedId}`).toBe(EXPECTED_EXTENSION_ORIGIN);

    // Ensure strict isolation from Wiki Clipper and Wiki canister.
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("6emaw-iyaaa-aaaay-aacka-cai");
    expect(serialized).not.toContain("jcfniiflikojmbfnaoamlbbddlikchaj");
    expect(manifest.host_permissions).not.toContain("https://wiki.kinic.xyz/*");
    expect(manifest.host_permissions).toContain(
      `https://${PRODUCTION_VAULT_CANISTER_ID}.icp0.io/*`
    );
    expect(manifest.content_scripts[0].all_frames).toBe(false);
    expect(manifest.content_scripts[0].exclude_matches).toContain("https://id.ai/*");
    expect(manifest.content_scripts[0].exclude_matches).toContain(
      "https://vault.kinic.xyz/*"
    );
    expect(manifest.content_scripts[0].exclude_matches).toContain(
      "https://wiki.kinic.xyz/*"
    );
  });

  it("matches the Vault canister's allowed Chrome extension origin", () => {
    const httpRs = readFileSync(
      resolve(root, "../../crates/vault_canister/src/http.rs"),
      "utf8"
    );
    expect(httpRs).toContain(EXPECTED_EXTENSION_ORIGIN);
  });

  it("builds Internet Identity AuthClient options with the shared Vault derivation origin", () => {
    const opts = buildVaultAuthOptions(RUNTIME_CONFIG);
    expect(opts.loginOptions.identityProvider).toBe(PRODUCTION_II_PROVIDER_URL);
    expect(opts.loginOptions.derivationOrigin).toBe(
      PRODUCTION_VAULT_DERIVATION_ORIGIN
    );
    expect(opts.loginOptions.maxTimeToLive).toBe(VAULT_AUTH_SESSION_TTL_NS);
    // Must stay at or below II's 30-day maximum.
    expect(opts.loginOptions.maxTimeToLive).toBeLessThanOrEqual(
      30n * 24n * 3600n * 1_000_000_000n
    );
  });

  it("rejects Wiki canisters, Wiki origins, and mismatched derivation origins", () => {
    expect(() =>
      validateVaultRuntimeConfig({
        canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
        icHost: PRODUCTION_VAULT_IC_HOST,
        derivationOrigin: "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io",
        identityProvider: PRODUCTION_II_PROVIDER_URL,
        vaultWebOrigin: PRODUCTION_VAULT_WEB_ORIGIN,
        local: false
      })
    ).toThrow(/canister/i);

    expect(() =>
      validateVaultRuntimeConfig({
        canisterId: PRODUCTION_VAULT_CANISTER_ID,
        icHost: PRODUCTION_VAULT_IC_HOST,
        derivationOrigin: PRODUCTION_VAULT_DERIVATION_ORIGIN,
        identityProvider: PRODUCTION_II_PROVIDER_URL,
        vaultWebOrigin: "https://wiki.kinic.xyz",
        local: false
      })
    ).toThrow(/Wiki/i);

    expect(() =>
      validateVaultRuntimeConfig({
        canisterId: PRODUCTION_VAULT_CANISTER_ID,
        icHost: PRODUCTION_VAULT_IC_HOST,
        derivationOrigin: "https://other-canister.icp0.io",
        identityProvider: PRODUCTION_II_PROVIDER_URL,
        vaultWebOrigin: PRODUCTION_VAULT_WEB_ORIGIN,
        local: false
      })
    ).toThrow(/derivationOrigin/i);

    expect(() =>
      validateVaultRuntimeConfig({
        canisterId: PRODUCTION_VAULT_CANISTER_ID,
        icHost: "http://icp0.io",
        derivationOrigin: PRODUCTION_VAULT_DERIVATION_ORIGIN,
        identityProvider: PRODUCTION_II_PROVIDER_URL,
        vaultWebOrigin: PRODUCTION_VAULT_WEB_ORIGIN,
        local: false
      })
    ).toThrow(/HTTPS/i);
  });
});
