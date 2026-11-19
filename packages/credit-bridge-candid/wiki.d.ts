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
export interface CreditOffer {
  'wiki_owner' : Principal,
  'link_generation' : bigint,
  'operation' : Uint8Array | number[],
  'amount_cycles' : bigint,
  'vault_owner' : Principal,
  'expires_at_ns' : bigint,
}
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
export type Result_1 = { 'Ok' : LinkStatus } |
  { 'Err' : BridgeError };
export type Result_21 = { 'Ok' : [] | [VaultTransfer] } |
  { 'Err' : BridgeError };
export type Result_49 = { 'Ok' : LinkChallenge } |
  { 'Err' : BridgeError };
export type Result_5 = { 'Ok' : [] | [LinkStatus] } |
  { 'Err' : BridgeError };
export type Result_59 = { 'Ok' : null } |
  { 'Err' : BridgeError };
export type Result_6 = { 'Ok' : VaultTransfer } |
  { 'Err' : BridgeError };
export type TransferAmount = { 'All' : null } |
  { 'Exact' : bigint };
export type TransferApproval = { 'Exact' : bigint } |
  { 'AllAvailable' : null };
export type TransferPhase = { 'Quoted' : null } |
  { 'Refunded' : null } |
  { 'Paid' : null } |
  { 'Offered' : null } |
  { 'Unknown' : null };
export interface VaultTransfer {
  'requested' : TransferAmount,
  'offer' : CreditOffer,
  'receiver_cleanup_pending' : boolean,
  'balance_at_quote' : bigint,
  'database_id' : string,
  'phase' : TransferPhase,
  'collected_execution_fee_cycles' : bigint,
  'estimated_execution_fee_cycles' : bigint,
}
export interface _SERVICE {
  'approve_vault_link' : ActorMethod<[Uint8Array | number[]], Result_1>,
  'cancel_vault_transfer' : ActorMethod<[Uint8Array | number[]], Result_6>,
  'execute_vault_transfer' : ActorMethod<
    [Uint8Array | number[], TransferApproval],
    Result_6
  >,
  'get_pending_vault_transfer' : ActorMethod<[[] | [string]], Result_21>,
  'get_vault_link' : ActorMethod<[], Result_5>,
  'get_vault_transfer' : ActorMethod<[Uint8Array | number[]], Result_6>,
  'preview_vault_link' : ActorMethod<[Uint8Array | number[]], Result_49>,
  'quote_vault_transfer' : ActorMethod<
    [string, TransferAmount, Uint8Array | number[]],
    Result_6
  >,
  'reconcile_vault_transfer' : ActorMethod<[Uint8Array | number[]], Result_6>,
  'revoke_vault_link' : ActorMethod<[], Result_59>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
