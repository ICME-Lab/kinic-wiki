// Transport only: each application supplies its own independently authenticated agent.
import {Actor} from '@icp-sdk/core/agent';
import {idlFactory as wikiIdl} from './wiki.js';
import {idlFactory as vaultIdl} from './vault.js';
export function createWikiBridgeActor(agent,canisterId){return Actor.createActor(wikiIdl,{agent,canisterId});}
export function createVaultBridgeActor(agent,canisterId){return Actor.createActor(vaultIdl,{agent,canisterId});}
