import type {ActorSubclass, Agent} from '@icp-sdk/core/agent';
import type {Principal} from '@icp-sdk/core/principal';
import type {_SERVICE as WikiBridgeActor} from './wiki.js';
import type {_SERVICE as VaultBridgeActor} from './vault.js';
export type * from './wiki.js';
export type {WikiBridgeActor,VaultBridgeActor};
export declare function createWikiBridgeActor(agent:Agent,canisterId:string|Principal):ActorSubclass<WikiBridgeActor>;
export declare function createVaultBridgeActor(agent:Agent,canisterId:string|Principal):ActorSubclass<VaultBridgeActor>;
