// Generated from dedicated vault.did.
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
export interface Bootstrap {
  'public_key' : Uint8Array | number[],
  'reserve' : Reserve,
}
export interface BootstrapReply { 'challenge' : Challenge, 'header' : Header }
export interface Challenge {
  'expires' : bigint,
  'registration' : boolean,
  'credential_ids' : Array<Uint8Array | number[]>,
  'bytes' : Uint8Array | number[],
}
export interface CleanupProgress {
  'job' : Uint8Array | number[],
  'cursor' : bigint,
  'complete' : boolean,
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
  { 'RateLimited' : { 'retry_after' : bigint } } |
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
export interface Generation {
  'vault' : Uint8Array | number[],
  'owner' : Principal,
  'epoch' : bigint,
  'version' : number,
  'canister' : Principal,
  'nonce' : Uint8Array | number[],
  'key_name' : string,
}
/**
 * Shared logical capacity; accounting is reserved globally, never billed per owner.
 */
export interface GlobalCapacity {
  'used' : bigint,
  'overcommitted' : boolean,
  'limit' : bigint,
  'overage' : bigint,
  'accounting_reserved' : bigint,
  'legacy_excess' : bigint,
}
export interface GrantInfo {
  'id' : Uint8Array | number[],
  'expires' : bigint,
  'next_counter' : bigint,
  'generations' : Array<Generation>,
  'purpose' : GrantPurpose,
}
export type GrantPurpose = { 'Restore' : { 'job' : Uint8Array | number[] } } |
  {
    'CancelCreation' : {
      'job' : Uint8Array | number[],
      'target' : PendingCreation,
    }
  } |
  { 'Credentials' : null } |
  { 'Normal' : null } |
  { 'Cleanup' : { 'job' : Uint8Array | number[] } } |
  { 'Incident' : { 'job' : Uint8Array | number[] } } |
  { 'Create' : null };
export interface GrantRequest {
  'credential' : Uint8Array | number[],
  'public_key' : Uint8Array | number[],
  'generations' : Array<Generation>,
  'operation' : Uint8Array | number[],
  'purpose' : GrantPurpose,
}
export interface Header {
  'id' : Uint8Array | number[],
  'normal' : [] | [Envelope],
  'generation' : [] | [Generation],
  'epoch' : bigint,
  'backup_sequence' : [] | [bigint],
  'state' : VaultState,
  'recovery_verifier' : Uint8Array | number[],
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
export type MutationResult = { 'Key' : KeyReply } |
  { 'Header' : Header } |
  { 'Unit' : null } |
  { 'Cleanup' : CleanupProgress } |
  { 'Revision' : Revision } |
  { 'Upload' : Upload } |
  { 'Challenge' : Challenge } |
  { 'Handle' : Uint8Array | number[] };
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
/**
 * Public namespace identity and immutable creation attempt; never a generation or secret.
 */
export interface PendingCreation {
  'attempt' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'namespace' : Uint8Array | number[],
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
export type Result_10 = { 'Ok' : Revision } |
  { 'Err' : Error };
export type Result_11 = { 'Ok' : KeyReply } |
  { 'Err' : Error };
export type Result_12 = { 'Ok' : ExportPage } |
  { 'Err' : Error };
export type Result_13 = { 'Ok' : GrantInfo } |
  { 'Err' : Error };
export type Result_14 = { 'Ok' : [] | [Export] } |
  { 'Err' : Error };
export type Result_15 = { 'Ok' : Uint8Array | number[] } |
  { 'Err' : Error };
export type Result_16 = { 'Ok' : [] | [VaultConfig] } |
  { 'Err' : Error };
export type Result_17 = { 'Ok' : Quota } |
  { 'Err' : Error };
export type Result_18 = { 'Ok' : GlobalCapacity } |
  { 'Err' : Error };
export type Result_19 = { 'Ok' : Array<CredentialInfo> } |
  { 'Err' : Error };
export type Result_2 = { 'Ok' : Challenge } |
  { 'Err' : Error };
export type Result_20 = { 'Ok' : ObjectPage } |
  { 'Err' : Error };
export type Result_21 = { 'Ok' : Array<Payment> } |
  { 'Err' : Error };
export type Result_22 = { 'Ok' : Array<UnfinishedVault> } |
  { 'Err' : Error };
export type Result_23 = { 'Ok' : Array<Header> } |
  { 'Err' : Error };
export type Result_24 = { 'Ok' : MutationResult } |
  { 'Err' : Error };
export type Result_25 = { 'Ok' : [] | [Payment] } |
  { 'Err' : Error };
export type Result_3 = { 'Ok' : Export } |
  { 'Err' : Error };
export type Result_4 = { 'Ok' : null } |
  { 'Err' : Error };
export type Result_5 = { 'Ok' : Upload } |
  { 'Err' : Error };
export type Result_6 = { 'Ok' : BootstrapReply } |
  { 'Err' : Error };
export type Result_7 = { 'Ok' : Payment } |
  { 'Err' : Error };
export type Result_8 = { 'Ok' : [] | [CleanupProgress] } |
  { 'Err' : Error };
export type Result_9 = { 'Ok' : RestoreProgress } |
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
  'namespace' : [] | [Uint8Array | number[]],
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
  { 'Purging' : null } |
  { 'Pending' : null };
export interface _SERVICE {
  'abort_export' : ActorMethod<[Uint8Array | number[]], Result>,
  'account_balance' : ActorMethod<[], Result_1>,
  'activate_vault' : ActorMethod<[Activate], Result>,
  'begin_cleanup' : ActorMethod<[GrantRequest], Result_2>,
  'begin_export' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_3
  >,
  'begin_grant' : ActorMethod<[GrantRequest], Result_2>,
  'begin_restore' : ActorMethod<[BeginRestore], Result>,
  'begin_restore_revision' : ActorMethod<
    [Uint8Array | number[], Revision, [] | [Uint8Array | number[]]],
    Result_4
  >,
  'begin_revision' : ActorMethod<[BeginRevision], Result_5>,
  'begin_unlock' : ActorMethod<[BeginUnlock], Result_2>,
  'bootstrap' : ActorMethod<[Bootstrap], Result_6>,
  'cancel_pending_key_derivation' : ActorMethod<[], Result_4>,
  'cancel_quote' : ActorMethod<[Uint8Array | number[]], Result_7>,
  'cancel_vault_setup' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_4
  >,
  'cleanup_status' : ActorMethod<[], Result_8>,
  'collect_garbage' : ActorMethod<[], Result_1>,
  'commit_restore' : ActorMethod<[Activate], Result>,
  'commit_restore_revision' : ActorMethod<
    [Uint8Array | number[], bigint, [] | [Uint8Array | number[]]],
    Result_9
  >,
  'commit_revision' : ActorMethod<[Uint8Array | number[]], Result_10>,
  'delete_object' : ActorMethod<
    [
      Uint8Array | number[],
      Uint8Array | number[],
      bigint,
      Uint8Array | number[],
    ],
    Result_10
  >,
  'derive_vault_key' : ActorMethod<[Derive], Result_11>,
  'export_index' : ActorMethod<[Uint8Array | number[], bigint], Result_12>,
  'finish_cleanup' : ActorMethod<[Uint8Array | number[], string], Result_13>,
  'finish_export' : ActorMethod<[Uint8Array | number[], boolean], Result>,
  'finish_grant' : ActorMethod<[Uint8Array | number[], string], Result_13>,
  'get_active_export' : ActorMethod<[], Result_14>,
  'get_active_export_for_vault' : ActorMethod<
    [Uint8Array | number[]],
    Result_14
  >,
  'get_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_15
  >,
  'get_config' : ActorMethod<[], Result_16>,
  'get_export_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_15
  >,
  'get_manifest' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_10
  >,
  'get_quota' : ActorMethod<[Uint8Array | number[]], Result_17>,
  'get_vault_header' : ActorMethod<[Uint8Array | number[]], Result>,
  /**
   * Aggregate capacity is public metadata; it never allocates an owner or account.
   */
  'global_capacity' : ActorMethod<[], Result_18>,
  'http_request' : ActorMethod<[HttpRequest], HttpResponse>,
  'list_credentials' : ActorMethod<[], Result_19>,
  'list_history' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_12
  >,
  'list_objects' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_20
  >,
  'list_payments' : ActorMethod<[], Result_21>,
  'list_unfinished_vaults' : ActorMethod<[], Result_22>,
  'list_vaults' : ActorMethod<[], Result_23>,
  'manage_unlock_credential' : ActorMethod<[ManageCredential], Result_4>,
  'mutate' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_24
  >,
  'pay_purchase' : ActorMethod<[Uint8Array | number[]], Result_7>,
  'payment_status' : ActorMethod<[Uint8Array | number[]], Result_25>,
  'prepare_unlock_credential' : ActorMethod<
    [Uint8Array | number[], string],
    Result_15
  >,
  'purge_object' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_4
  >,
  'put_chunk' : ActorMethod<
    [Uint8Array | number[], number, Uint8Array | number[]],
    Result_4
  >,
  'put_restore_chunk' : ActorMethod<
    [
      Uint8Array | number[],
      number,
      Uint8Array | number[],
      [] | [Uint8Array | number[]],
    ],
    Result_4
  >,
  'quote_purchase' : ActorMethod<[PurchaseRequest], Result_7>,
  'register_bootstrap' : ActorMethod<
    [Uint8Array | number[], string],
    Result_13
  >,
  'reserve_vault' : ActorMethod<[Reserve], Result>,
  'set_config' : ActorMethod<[[] | [VaultConfig]], Result_4>,
  'set_funding_config' : ActorMethod<[[] | [FundingConfig]], Result_4>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];

export type VaultActor = _SERVICE;
