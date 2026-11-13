import { Actor, HttpAgent, type Identity } from '@icp-sdk/core/agent';
import { idlFactory } from '@kinic/vault-candid';
import { VaultClient } from '@kinic/vault-client';
import type { VaultActor } from '@kinic/vault-client/contracts';
import { loadConfig } from '../config';
export async function createPrivateVaultClient(identity: Identity) {
  const config = await loadConfig();
  const agent = HttpAgent.createSync({
    host: config.host,
    identity
  });
  if (config.local) await agent.fetchRootKey();
  const actor = Actor.createActor<VaultActor>(idlFactory, {
    agent,
    canisterId: config.canister
  });
  return new VaultClient({
    actor,
    identity,
    canister: config.canister,
    local: config.local
  });
}
