import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export type Action = {
    'CancelUpload' : {
      'job' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'upload' : Uint8Array | number[],
    }
  } |
  {
    'PutChunk' : {
      'upload' : Uint8Array | number[],
      'bytes' : Uint8Array | number[],
      'index' : number,
    }
  } |
  { 'CommitRevision' : { 'upload' : Uint8Array | number[] } } |
  {
    'DeleteObject' : {
      'object' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'expected_revision' : bigint,
    }
  } |
  { 'DeleteVault' : { 'vault' : Uint8Array | number[] } } |
  { 'Collect' : null } |
  {
    'PurgeObject' : {
      'object' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'expected_revision' : bigint,
    }
  } |
  { 'BeginRevision' : BeginRevision };
export interface BeginRevision {
  'object' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'chunk_hashes' : Array<Uint8Array | number[]>,
  'operation' : Uint8Array | number[],
  'manifest' : Uint8Array | number[],
  'plain_size' : bigint,
  'expected_revision' : bigint,
}
export interface CommittedUpload {
  'object' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'revision' : bigint,
  'sequence' : bigint,
}
export interface CreateVault {
  'vault' : Uint8Array | number[],
  'operation' : Uint8Array | number[],
}
export interface DeriveKey {
  'vault' : Uint8Array | number[],
  'transport' : Uint8Array | number[],
  'operation' : Uint8Array | number[],
}
export type Error = { 'Storage' : null } |
  { 'InvalidInput' : null } |
  { 'Busy' : null } |
  { 'KeyService' : null } |
  { 'NotFound' : null } |
  { 'Unauthorized' : null } |
  { 'Expired' : null } |
  { 'QuotaExceeded' : null } |
  { 'Conflict' : null };
export interface FundingConfig {
  'recipient' : Principal,
  'cycles_per_kinic' : bigint,
  'ledger' : Principal,
}
export interface GlobalCapacity {
  'used' : bigint,
  'overcommitted' : boolean,
  'limit' : bigint,
  'overage' : bigint,
  'accounting_reserved' : bigint,
}
export interface Header {
  'id' : Uint8Array | number[],
  'public_key' : Uint8Array | number[],
  'state' : VaultState,
  'nonce' : Uint8Array | number[],
  'key_name' : string,
  'sequence' : bigint,
}
export interface HttpRequest {
  'url' : string,
  'method' : string,
  'body' : Uint8Array | number[],
  'headers' : Array<[string, string]>,
  'certificate_version' : [] | [number],
}
export interface HttpResponse {
  'body' : Uint8Array | number[],
  'headers' : Array<[string, string]>,
  'upgrade' : [] | [boolean],
  'status_code' : number,
}
export interface KeyReply {
  'encrypted_key' : Uint8Array | number[],
  'public_key' : Uint8Array | number[],
  'input' : Uint8Array | number[],
}
export interface Mutation {
  'action' : Action,
  'operation' : Uint8Array | number[],
}
export type MutationResult = { 'Collected' : bigint } |
  { 'Done' : null } |
  { 'Progress' : boolean } |
  { 'Revision' : Revision } |
  { 'Upload' : Upload };
export interface ObjectPage {
  'next' : [] | [Uint8Array | number[]],
  'entries' : Array<Revision>,
}
export interface Payment {
  'fee' : bigint,
  'status' : Status,
  'credits' : bigint,
  'attempt' : bigint,
  'request' : PurchaseRequest,
  'memo' : Uint8Array | number[],
  'generation' : bigint,
  'uncertain' : boolean,
  'sent_at' : bigint,
  'wallet' : Principal,
  'created_at_time' : bigint,
  'config' : FundingConfig,
}
export interface PendingUpload {
  'expires' : bigint,
  'request' : BeginRevision,
  'cancel_job' : [] | [Uint8Array | number[]],
  'received' : Uint32Array | number[],
}
/**
 * Bounded owner-only metadata; no document name or plaintext.
 */
export interface PendingUploadSummary {
  'expires' : bigint,
  'vault' : Uint8Array | number[],
  'upload' : Uint8Array | number[],
  'cancel_job' : [] | [Uint8Array | number[]],
}
export interface PendingUploads {
  'next' : [] | [Uint8Array | number[]],
  'entries' : Array<PendingUploadSummary>,
}
export interface PurchaseRequest {
  'beneficiary' : Principal,
  'amount_e8s' : bigint,
  'operation' : Uint8Array | number[],
  'min_credits' : bigint,
  'created_at_time' : bigint,
}
export interface Quota {
  'reserved' : bigint,
  'limit' : bigint,
  'current' : bigint,
  'charged' : bigint,
}
export type Result = { 'Ok' : bigint } |
  { 'Err' : Error };
export type Result_1 = { 'Ok' : Payment } |
  { 'Err' : Error };
export type Result_10 = { 'Ok' : RevisionPage } |
  { 'Err' : Error };
export type Result_11 = { 'Ok' : ObjectPage } |
  { 'Err' : Error };
export type Result_12 = { 'Ok' : Array<Payment> } |
  { 'Err' : Error };
export type Result_13 = { 'Ok' : PendingUploads } |
  { 'Err' : Error };
export type Result_14 = { 'Ok' : Array<Header> } |
  { 'Err' : Error };
export type Result_15 = { 'Ok' : MutationResult } |
  { 'Err' : Error };
export type Result_16 = { 'Ok' : [] | [Payment] } |
  { 'Err' : Error };
export type Result_17 = { 'Ok' : null } |
  { 'Err' : Error };
export type Result_2 = { 'Ok' : Header } |
  { 'Err' : Error };
export type Result_3 = { 'Ok' : KeyReply } |
  { 'Err' : Error };
export type Result_4 = { 'Ok' : Uint8Array | number[] } |
  { 'Err' : Error };
export type Result_5 = { 'Ok' : [] | [VaultConfig] } |
  { 'Err' : Error };
export type Result_6 = { 'Ok' : Revision } |
  { 'Err' : Error };
export type Result_7 = { 'Ok' : Quota } |
  { 'Err' : Error };
export type Result_8 = { 'Ok' : UploadStatus } |
  { 'Err' : Error };
export type Result_9 = { 'Ok' : GlobalCapacity } |
  { 'Err' : Error };
export interface Revision {
  'deleted' : boolean,
  'object' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'chunk_hashes' : Array<Uint8Array | number[]>,
  'revision' : bigint,
  'manifest' : Uint8Array | number[],
  'plain_size' : bigint,
  'sequence' : bigint,
}
export interface RevisionPage {
  'next' : [] | [bigint],
  'entries' : Array<Revision>,
}
export type Status = { 'Quoted' : null } |
  { 'InsufficientAllowance' : null } |
  { 'Paid' : bigint } |
  { 'BadFee' : bigint } |
  { 'Rejected' : null } |
  { 'InFlight' : null } |
  { 'Unknown' : null } |
  { 'Expired' : null } |
  { 'InsufficientFunds' : null };
export interface Upload {
  'id' : Uint8Array | number[],
  'expires' : bigint,
  'revision' : bigint,
}
export type UploadStatus = { 'Committed' : CommittedUpload } |
  { 'Absent' : null } |
  { 'Cancelled' : null } |
  { 'Expired' : null } |
  { 'Pending' : PendingUpload };
export interface VaultConfig { 'minimum_cycles' : bigint, 'key_name' : string }
export type VaultState = { 'Deleting' : null } |
  { 'Active' : null } |
  { 'Deleted' : null } |
  { 'Pending' : null };
export interface _SERVICE {
  'account_balance' : ActorMethod<[], Result>,
  'cancel_quote' : ActorMethod<[Uint8Array | number[]], Result_1>,
  'create_vault' : ActorMethod<[CreateVault], Result_2>,
  'derive_vault_key' : ActorMethod<[DeriveKey], Result_3>,
  'get_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_4
  >,
  'get_config' : ActorMethod<[], Result_5>,
  'get_manifest' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_6
  >,
  'get_quota' : ActorMethod<[Uint8Array | number[]], Result_7>,
  'get_upload_status' : ActorMethod<[Uint8Array | number[]], Result_8>,
  'get_vault_header' : ActorMethod<[Uint8Array | number[]], Result_2>,
  'global_capacity' : ActorMethod<[], Result_9>,
  'http_request' : ActorMethod<[HttpRequest], HttpResponse>,
  'list_history' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_10
  >,
  'list_objects' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_11
  >,
  'list_payments' : ActorMethod<[], Result_12>,
  'list_pending_uploads' : ActorMethod<[Uint8Array | number[]], Result_13>,
  'list_vaults' : ActorMethod<[], Result_14>,
  'mutate' : ActorMethod<[Mutation], Result_15>,
  'pay_purchase' : ActorMethod<[Uint8Array | number[]], Result_1>,
  'payment_status' : ActorMethod<[Uint8Array | number[]], Result_16>,
  'quote_purchase' : ActorMethod<[PurchaseRequest], Result_1>,
  'set_config' : ActorMethod<[[] | [VaultConfig]], Result_17>,
  'set_funding_config' : ActorMethod<[[] | [FundingConfig]], Result_17>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
