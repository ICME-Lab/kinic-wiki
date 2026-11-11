import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export interface Activate {
  'normal' : Envelope,
  'attempt' : [] | [Uint8Array | number[]],
  'vault' : Uint8Array | number[],
  'registration' : [] | [string],
  'assertion' : [] | [string],
  'operation' : Uint8Array | number[],
  'recovery' : Envelope,
}
export interface BeginRestore {
  'count' : bigint,
  'root' : Uint8Array | number[],
  'operation' : Uint8Array | number[],
  'reserved_bytes' : bigint,
  'header' : Header,
}
export interface BeginRevision {
  'object' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'chunk_hashes' : Array<Uint8Array | number[]>,
  'operation' : Uint8Array | number[],
  'manifest' : Uint8Array | number[],
  'plain_size' : bigint,
  'expected_revision' : bigint,
}
export interface BeginUnlock {
  'attempt' : [] | [Uint8Array | number[]],
  'vault' : Uint8Array | number[],
  'transport' : Uint8Array | number[],
  'epoch' : bigint,
  'target' : Uint8Array | number[],
  'purpose' : Purpose,
}
export interface Challenge {
  'expires' : bigint,
  'registration' : boolean,
  'credential_ids' : Array<Uint8Array | number[]>,
  'bytes' : Uint8Array | number[],
}
export interface CredentialInfo { 'id' : Uint8Array | number[] }
export interface Derive {
  'attempt' : [] | [Uint8Array | number[]],
  'vault' : Uint8Array | number[],
  'transport' : Uint8Array | number[],
  'epoch' : bigint,
  'assertion' : [] | [string],
}
export interface Envelope {
  'ciphertext' : Uint8Array | number[],
  'version' : number,
  'nonce' : Uint8Array | number[],
}
export type Error = { 'Storage' : null } |
  { 'InvalidInput' : null } |
  { 'Busy' : null } |
  { 'InvalidProof' : null } |
  { 'KeyService' : null } |
  { 'NotFound' : null } |
  { 'ExportInProgress' : null } |
  { 'Unauthorized' : null } |
  { 'Expired' : null } |
  { 'QuotaExceeded' : null } |
  { 'Conflict' : null };
export interface Export {
  'id' : Uint8Array | number[],
  'expires' : bigint,
  'vault' : Uint8Array | number[],
  'plain_bytes' : bigint,
  'state' : string,
  'chunk_count' : bigint,
  'sequence' : bigint,
  'record_count' : bigint,
  'header' : Header,
}
export interface ExportPage {
  'next' : [] | [bigint],
  'entries' : Array<Revision>,
}
export interface FundingConfig {
  'recipient' : Principal,
  'cycles_per_kinic' : bigint,
  'ledger' : Principal,
}
export interface Header {
  'id' : Uint8Array | number[],
  'normal' : [] | [Envelope],
  'epoch' : bigint,
  'backup_sequence' : [] | [bigint],
  'state' : VaultState,
  'key_name' : string,
  'recovery' : [] | [Envelope],
  'sequence' : bigint,
  'backup_at' : [] | [bigint],
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
}
export interface ManageCredential {
  'remove' : [] | [Uint8Array | number[]],
  'vault' : Uint8Array | number[],
  'registration' : [] | [string],
  'assertion' : string,
}
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
export interface PurchaseRequest {
  'beneficiary' : Principal,
  'amount_e8s' : bigint,
  'operation' : Uint8Array | number[],
  'min_credits' : bigint,
  'created_at_time' : bigint,
}
export type Purpose = { 'Unlock' : null } |
  { 'Activate' : null } |
  { 'AddCredential' : null } |
  { 'RemoveCredential' : null };
export interface Quota {
  'reserved' : bigint,
  'limit' : bigint,
  'current' : bigint,
  'charged' : bigint,
}
export interface Reserve {
  'vault' : Uint8Array | number[],
  'operation' : Uint8Array | number[],
}
export interface RestoreProgress {
  'count' : bigint,
  'root' : Uint8Array | number[],
  'sequence' : bigint,
}
export type Result = { 'Ok' : Header } |
  { 'Err' : Error };
export type Result_1 = { 'Ok' : bigint } |
  { 'Err' : Error };
export type Result_10 = { 'Ok' : ExportPage } |
  { 'Err' : Error };
export type Result_11 = { 'Ok' : [] | [Export] } |
  { 'Err' : Error };
export type Result_12 = { 'Ok' : Uint8Array | number[] } |
  { 'Err' : Error };
export type Result_13 = { 'Ok' : [] | [VaultConfig] } |
  { 'Err' : Error };
export type Result_14 = { 'Ok' : Quota } |
  { 'Err' : Error };
export type Result_15 = { 'Ok' : Array<CredentialInfo> } |
  { 'Err' : Error };
export type Result_16 = { 'Ok' : ObjectPage } |
  { 'Err' : Error };
export type Result_17 = { 'Ok' : Array<Payment> } |
  { 'Err' : Error };
export type Result_18 = { 'Ok' : Array<UnfinishedVault> } |
  { 'Err' : Error };
export type Result_19 = { 'Ok' : Array<Header> } |
  { 'Err' : Error };
export type Result_2 = { 'Ok' : Export } |
  { 'Err' : Error };
export type Result_20 = { 'Ok' : [] | [Payment] } |
  { 'Err' : Error };
export type Result_3 = { 'Ok' : null } |
  { 'Err' : Error };
export type Result_4 = { 'Ok' : Upload } |
  { 'Err' : Error };
export type Result_5 = { 'Ok' : Challenge } |
  { 'Err' : Error };
export type Result_6 = { 'Ok' : Payment } |
  { 'Err' : Error };
export type Result_7 = { 'Ok' : RestoreProgress } |
  { 'Err' : Error };
export type Result_8 = { 'Ok' : Revision } |
  { 'Err' : Error };
export type Result_9 = { 'Ok' : KeyReply } |
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
export type Status = { 'Quoted' : null } |
  { 'InsufficientAllowance' : null } |
  { 'Paid' : bigint } |
  { 'BadFee' : bigint } |
  { 'Rejected' : null } |
  { 'InFlight' : null } |
  { 'Unknown' : null } |
  { 'Expired' : null } |
  { 'InsufficientFunds' : null };
export interface UnfinishedVault {
  'expires' : bigint,
  'cleaning' : boolean,
  'attempt' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'state' : VaultState,
}
export interface Upload {
  'id' : Uint8Array | number[],
  'expires' : bigint,
  'revision' : bigint,
}
/**
 * Exact WebAuthn deployment configuration, independent from II derivation origin.
 */
export interface VaultConfig {
  'minimum_cycles' : bigint,
  'origin' : string,
  'key_name' : string,
  'rp_id' : string,
}
export type VaultState = { 'Active' : null } |
  { 'Restoring' : null } |
  { 'Pending' : null };
export interface _SERVICE {
  'abort_export' : ActorMethod<[Uint8Array | number[]], Result>,
  'account_balance' : ActorMethod<[], Result_1>,
  'activate_vault' : ActorMethod<[Activate], Result>,
  'begin_export' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_2
  >,
  'begin_restore' : ActorMethod<[BeginRestore], Result>,
  'begin_restore_revision' : ActorMethod<
    [Uint8Array | number[], Revision, [] | [Uint8Array | number[]]],
    Result_3
  >,
  'begin_revision' : ActorMethod<[BeginRevision], Result_4>,
  'begin_unlock' : ActorMethod<[BeginUnlock], Result_5>,
  'cancel_pending_key_derivation' : ActorMethod<[], Result_3>,
  'cancel_quote' : ActorMethod<[Uint8Array | number[]], Result_6>,
  'cancel_vault_setup' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_3
  >,
  'collect_garbage' : ActorMethod<[], Result_1>,
  'commit_restore' : ActorMethod<[Activate], Result>,
  'commit_restore_revision' : ActorMethod<
    [Uint8Array | number[], bigint, [] | [Uint8Array | number[]]],
    Result_7
  >,
  'commit_revision' : ActorMethod<[Uint8Array | number[]], Result_8>,
  'delete_object' : ActorMethod<
    [
      Uint8Array | number[],
      Uint8Array | number[],
      bigint,
      Uint8Array | number[],
    ],
    Result_8
  >,
  'derive_vault_key' : ActorMethod<[Derive], Result_9>,
  'export_index' : ActorMethod<[Uint8Array | number[], bigint], Result_10>,
  'finish_export' : ActorMethod<[Uint8Array | number[], boolean], Result>,
  'get_active_export' : ActorMethod<[], Result_11>,
  'get_active_export_for_vault' : ActorMethod<
    [Uint8Array | number[]],
    Result_11
  >,
  'get_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_12
  >,
  'get_config' : ActorMethod<[], Result_13>,
  'get_export_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_12
  >,
  'get_manifest' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_8
  >,
  'get_quota' : ActorMethod<[Uint8Array | number[]], Result_14>,
  'get_vault_header' : ActorMethod<[Uint8Array | number[]], Result>,
  'http_request' : ActorMethod<[HttpRequest], HttpResponse>,
  'list_credentials' : ActorMethod<[], Result_15>,
  'list_history' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_10
  >,
  'list_objects' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_16
  >,
  'list_payments' : ActorMethod<[], Result_17>,
  'list_unfinished_vaults' : ActorMethod<[], Result_18>,
  'list_vaults' : ActorMethod<[], Result_19>,
  'manage_unlock_credential' : ActorMethod<[ManageCredential], Result_3>,
  'pay_purchase' : ActorMethod<[Uint8Array | number[]], Result_6>,
  'payment_status' : ActorMethod<[Uint8Array | number[]], Result_20>,
  'prepare_unlock_credential' : ActorMethod<
    [Uint8Array | number[], string],
    Result_12
  >,
  'purge_object' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_3
  >,
  'put_chunk' : ActorMethod<
    [Uint8Array | number[], number, Uint8Array | number[]],
    Result_3
  >,
  'put_restore_chunk' : ActorMethod<
    [
      Uint8Array | number[],
      number,
      Uint8Array | number[],
      [] | [Uint8Array | number[]],
    ],
    Result_3
  >,
  'quote_purchase' : ActorMethod<[PurchaseRequest], Result_6>,
  'reserve_vault' : ActorMethod<[Reserve], Result>,
  'set_config' : ActorMethod<[[] | [VaultConfig]], Result_3>,
  'set_funding_config' : ActorMethod<[[] | [FundingConfig]], Result_3>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
