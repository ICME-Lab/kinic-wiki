import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export interface AutoTopupPolicy {
  /**
   * The most this policy may send per UTC day.
   */
  'daily_limit_cycles' : bigint,
  /**
   * A refill may run only while the Vault balance is below this.
   */
  'threshold_cycles' : bigint,
  /**
   * The owned Wiki database that pays for refills.
   */
  'database_id' : string,
  /**
   * Cycles sent per refill.
   */
  'amount_cycles' : bigint,
  /**
   * The database keeps at least this after a refill and its fee.
   */
  'min_database_cycles' : bigint,
}
export interface AutoTopupStatus {
  'sent_today_cycles' : bigint,
  'last_topup_at_ns' : [] | [bigint],
  'database_name' : string,
  'policy' : AutoTopupPolicy,
}
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
export type Result_27 = { 'Ok' : CreditReceipt } |
  { 'Err' : BridgeError };
export type Result_29 = { 'Ok' : [] | [CreditReceipt] } |
  { 'Err' : BridgeError };
export type Result_30 = { 'Ok' : BridgeRevocation } |
  { 'Err' : BridgeError };
export type Result_32 = { 'Ok' : [] | [AutoTopupStatus] } |
  { 'Err' : BridgeError };
export type Result_33 = { 'Ok' : [] | [LinkStatus] } |
  { 'Err' : BridgeError };
export interface _SERVICE {
  'begin_wiki_link' : ActorMethod<[Uint8Array | number[]], Result_2>,
  'prepare_wiki_credit' : ActorMethod<[Uint8Array | number[]], Result_27>,
  'request_wiki_auto_topup' : ActorMethod<[], Result_29>,
  'revoke_wiki_link' : ActorMethod<[], Result_30>,
  'wiki_auto_topup_status' : ActorMethod<[], Result_32>,
  'wiki_link_status' : ActorMethod<[], Result_33>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
