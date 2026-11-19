import { HttpAgent } from "@icp-sdk/core/agent";
import type { VaultClient } from "@kinic/vault-client";
import { createVaultBridgeActor } from "@kinic/credit-bridge-candid";
import { configuredBridgeOrigins } from "@kinic/credit-bridge-candid/browser";
import { loadConfig } from "./config";
export function creditOrigins() {
  return configuredBridgeOrigins(import.meta.env);
}
export async function vaultCreditActor(client: VaultClient) {
  const config = await loadConfig();
  if (config.canister !== client.canister) throw Error("Session changed");
  const agent = HttpAgent.createSync({
    host: config.host,
    identity: client.identity,
  });
  if (config.local) await agent.fetchRootKey();
  return createVaultBridgeActor(agent, config.canister);
}
