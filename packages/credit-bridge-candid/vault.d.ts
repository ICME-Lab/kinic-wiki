import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export type BridgeError = { 'Storage' : null } |
  { 'InvalidInput' : null } |
  { 'Disabled' : null } |
  { 'NotFound' : null } |
  { 'Unauthorized' : null } |
  { 'Capacity' : null } |
  { 'Unavailable' : null } |
  { 'Expired' : null } |
  { 'Conflict' : null };
export interface BridgeRevocation {
  'through_generation' : bigint,
  'vault_owner' : Principal,
}
export interface CreditOffer {
  'wiki_owner' : Principal,
  'link_generation' : bigint,
  'operation' : Uint8Array | number[],
  'amount_cycles' : bigint,
  'vault_owner' : Principal,
  'expires_at_ns' : bigint,
}
export interface CreditReceipt {
  'status' : CreditStatus,
  'offer' : CreditOffer,
}
export type CreditStatus = { 'Prepared' : null } |
  { 'Accepted' : null } |
  { 'NotAccepted' : null };
export interface LinkChallenge {
  'challenge' : Uint8Array | number[],
  'generation' : bigint,
  'vault_owner' : Principal,
  'expires_at_ns' : bigint,
}
export interface LinkStatus {
  'wiki_owner' : Principal,
  'active' : boolean,
  'generation' : bigint,
  'vault_owner' : Principal,
}
export type Result_2 = { 'Ok' : LinkChallenge } |
  { 'Err' : BridgeError };
export type Result_26 = { 'Ok' : CreditReceipt } |
  { 'Err' : BridgeError };
export type Result_29 = { 'Ok' : BridgeRevocation } |
  { 'Err' : BridgeError };
export type Result_31 = { 'Ok' : [] | [LinkStatus] } |
  { 'Err' : BridgeError };
export interface _SERVICE {
  'begin_wiki_link' : ActorMethod<[Uint8Array | number[]], Result_2>,
  'prepare_wiki_credit' : ActorMethod<[Uint8Array | number[]], Result_26>,
  'revoke_wiki_link' : ActorMethod<[], Result_29>,
  'wiki_link_status' : ActorMethod<[], Result_31>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
