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
export interface CommittedUpload {
  'object' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'revision' : bigint,
  'sequence' : bigint,
}
/**
 * A new-empty job has no archive, imported record, or unregistered candidate authority.
 */
export type CreateEmptyPhase = { 'Admitted' : null } |
  { 'Active' : null } |
  { 'EnvelopesStaged' : null } |
  { 'KitConfirmed' : null } |
  { 'Cancelling' : null } |
  { 'Cancelled' : null } |
  { 'Allocated' : null };
export interface CreateEmptyStatus {
  'job' : Uint8Array | number[],
  'creator' : RestoreExistingCandidate,
  'normal' : [] | [Envelope],
  'cleanup_cursor' : bigint,
  'envelope_digest' : Uint8Array | number[],
  'generation' : [] | [Generation],
  'allocation_token' : [] | [bigint],
  'kit_ack' : [] | [Uint8Array | number[]],
  'target' : PendingCreation,
  'recovery_verifier' : Uint8Array | number[],
  'recovery' : [] | [Envelope],
  'phase' : CreateEmptyPhase,
  'key_digest' : Uint8Array | number[],
  'authorizer_instance' : Generation,
}
export interface CredentialInfo { 'id' : Uint8Array | number[] }
export interface CredentialRevocation {
  'credential' : Uint8Array | number[],
  'version' : bigint,
}
export type CredentialScope = { 'Global' : null } |
  { 'Instances' : Array<Instance> };
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
export type GrantPurpose = {
    'RestoreCleanup' : {
      'job' : Uint8Array | number[],
      'target' : PendingCreation,
    }
  } |
  { 'Restore' : { 'job' : Uint8Array | number[] } } |
  {
    'CancelCreation' : {
      'job' : Uint8Array | number[],
      'target' : PendingCreation,
    }
  } |
  { 'Credentials' : null } |
  {
    'RestoreTarget' : {
      'job' : Uint8Array | number[],
      'generation' : Generation,
    }
  } |
  { 'Normal' : null } |
  { 'Cleanup' : { 'job' : Uint8Array | number[] } } |
  {
    'Incident' : {
      'job' : Uint8Array | number[],
      'vector_digest' : Uint8Array | number[],
    }
  } |
  {
    'CreateEmpty' : {
      'job' : Uint8Array | number[],
      'target' : PendingCreation,
      'authorizer_instance' : Generation,
    }
  } |
  {
    'IncidentCutover' : {
      'job' : Uint8Array | number[],
      'digest' : Uint8Array | number[],
    }
  } |
  { 'Create' : null } |
  {
    'RestorePrepare' : {
      'job' : Uint8Array | number[],
      'target' : PendingCreation,
    }
  } |
  { 'IncidentPrepare' : IncidentPreparation };
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
  'published_slot' : [] | [number],
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
export interface IncidentBackupAck {
  'archive_length' : bigint,
  'archive_hash' : Uint8Array | number[],
  'descriptor_digest' : Uint8Array | number[],
  'recovery_verifier' : Uint8Array | number[],
  'sequence' : bigint,
  'commitment' : Uint8Array | number[],
}
export interface IncidentContext {
  'credentials' : Array<IncidentCredential>,
  'namespace' : Uint8Array | number[],
}
/**
 * Constant-size ordered coverage; the frozen source owns membership.
 */
export interface IncidentCoverage {
  'records' : bigint,
  'cursor' : bigint,
  'last_batch' : Uint8Array | number[],
  'plain_bytes' : bigint,
  'complete' : boolean,
  'source_root' : Uint8Array | number[],
  'chunks' : bigint,
  'target_root' : Uint8Array | number[],
}
export interface IncidentCredential {
  'credential' : Uint8Array | number[],
  'scope' : CredentialScope,
  'version' : bigint,
}
export interface IncidentPreparation {
  'job' : Uint8Array | number[],
  'targets' : Array<PendingCreation>,
  'sources' : Array<Generation>,
  'namespace' : Uint8Array | number[],
  'compromised' : Array<CredentialRevocation>,
}
export interface IncidentRead {
  'job' : Uint8Array | number[],
  'attempt' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'descriptor_digest' : Uint8Array | number[],
  'export' : Uint8Array | number[],
}
export interface IncidentStatus {
  'job' : Uint8Array | number[],
  'cancel_digest' : [] | [Uint8Array | number[]],
  'vector_digest' : Uint8Array | number[],
  'completed_digest' : [] | [Uint8Array | number[]],
  'complete' : boolean,
  'targets' : Array<IncidentTarget>,
  'semantic_config' : Uint8Array | number[],
  'namespace' : Uint8Array | number[],
  'compromised' : Array<CredentialRevocation>,
}
export interface IncidentTarget {
  'staged_export' : [] | [StagedExport],
  'normal' : [] | [Envelope],
  'attempt' : Uint8Array | number[],
  'source' : Header,
  'envelope_digest' : Uint8Array | number[],
  'snapshot_sequence' : bigint,
  'kit_ack' : [] | [Uint8Array | number[]],
  'target' : [] | [Generation],
  'backup_ack' : [] | [IncidentBackupAck],
  'restore_child' : [] | [RestoreChildLink],
  'recovery_verifier' : Uint8Array | number[],
  'recovery' : [] | [Envelope],
  'reset_attempt' : [] | [Uint8Array | number[]],
  'phase' : PreparationPhase,
  'coverage' : [] | [IncidentCoverage],
  'next_epoch' : bigint,
  'snapshot_time' : bigint,
}
export interface Instance {
  'vault' : Uint8Array | number[],
  'nonce' : Uint8Array | number[],
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
  { 'InactiveCleanup' : { 'complete' : boolean } } |
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
export type PreparationPhase = { 'BackupVerified' : null } |
  { 'PendingNonce' : null } |
  { 'Resetting' : null } |
  { 'EnvelopesStaged' : null } |
  { 'Wrapping' : null } |
  { 'Purged' : null } |
  { 'KitConfirmed' : null } |
  { 'Purging' : null } |
  { 'Cancelling' : null } |
  { 'Cancelled' : null } |
  { 'Allocated' : null };
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
export type RestoreAdmissionPhase = { 'Registration' : null } |
  { 'Admitted' : null } |
  { 'Possession' : null } |
  { 'CurrentProof' : null };
export interface RestoreAdmissionRequest {
  'job' : Uint8Array | number[],
  'source_generation' : [] | [Generation],
  'source_epoch' : bigint,
  'records' : bigint,
  'archive_length' : bigint,
  'archive_digest' : Uint8Array | number[],
  'candidate_mode' : [] | [RestoreCandidateMode],
  'target' : PendingCreation,
  'source_commitment' : Uint8Array | number[],
  'reserved_bytes' : bigint,
}
export interface RestoreAdmissionStatus {
  'challenge' : Challenge,
  'request' : RestoreAdmissionRequest,
  'pipeline' : [] | [RestorePipeline],
  /**
   * Exact bytes to sign, including the recovery proof domain and pre-nonce binding.
   */
  'recovery_message' : Uint8Array | number[],
  'allocation_token' : [] | [bigint],
  'existing_candidate' : [] | [RestoreExistingCandidate],
  'issued' : bigint,
  'cancel_complete' : boolean,
  'current_verifier' : Uint8Array | number[],
  'current_live' : [] | [Generation],
  'semantic_config' : Uint8Array | number[],
  'phase' : RestoreAdmissionPhase,
  /**
   * Public credential material only, bounded and checked before persistence.
   */
  'candidate' : [] | [string],
  'proof_fence' : Uint8Array | number[],
  'candidate_digest' : Uint8Array | number[],
  'cancel_requested' : boolean,
  'next_epoch' : bigint,
  'parent_job' : [] | [Uint8Array | number[]],
}
/**
 * None/New preserves the new physical candidate ceremony, including historical jobs.
 */
export type RestoreCandidateMode = { 'New' : null } |
  { 'ExistingInstances' : Uint8Array | number[] };
/**
 * Immutable replacement audit retained when the single active child slot is reused.
 */
export interface RestoreChildLink {
  'job' : Uint8Array | number[],
  'attempt' : Uint8Array | number[],
  'archive_digest' : Uint8Array | number[],
  'target' : Generation,
}
export interface RestoreExistingCandidate {
  'credential' : Uint8Array | number[],
  'version' : bigint,
  'scope_digest' : Uint8Array | number[],
}
export type RestorePhase = { 'BackupVerified' : null } |
  { 'Importing' : null } |
  { 'Discarding' : null } |
  { 'Active' : null } |
  { 'EnvelopesStaged' : null } |
  { 'KitConfirmed' : null } |
  { 'Cancelling' : null } |
  { 'Cancelled' : null } |
  { 'Allocated' : null };
export interface RestorePipeline {
  'discard_started' : boolean,
  'normal' : [] | [Envelope],
  'cleanup_cursor' : bigint,
  'envelope_digest' : Uint8Array | number[],
  'kit_ack' : [] | [Uint8Array | number[]],
  'preflight' : [] | [RestorePreflight],
  'target' : Generation,
  'backup_ack' : [] | [IncidentBackupAck],
  'old_removed' : boolean,
  'recovery_verifier' : Uint8Array | number[],
  'recovery' : [] | [Envelope],
  'phase' : RestorePhase,
}
/**
 * Locally validated archive metadata. This is a signed client assertion, not server AEAD validation.
 */
export interface RestorePreflight {
  'records' : bigint,
  'peak_pending_bytes' : bigint,
  'source_saved' : boolean,
  'current_plain_bytes' : bigint,
  'archive_length' : bigint,
  'archive_digest' : Uint8Array | number[],
  'plain_bytes' : bigint,
  'objects' : bigint,
  'source_fully_verified' : boolean,
  'target_commitment' : Uint8Array | number[],
  'source_commitment' : Uint8Array | number[],
  'revision_bytes' : bigint,
  'chunks' : bigint,
  'sequence' : bigint,
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
export type Result_10 = { 'Ok' : RestoreProgress } |
  { 'Err' : Error };
export type Result_11 = { 'Ok' : Revision } |
  { 'Err' : Error };
export type Result_12 = { 'Ok' : [] | [CreateEmptyStatus] } |
  { 'Err' : Error };
export type Result_13 = { 'Ok' : KeyReply } |
  { 'Err' : Error };
export type Result_14 = { 'Ok' : ExportPage } |
  { 'Err' : Error };
export type Result_15 = { 'Ok' : GrantInfo } |
  { 'Err' : Error };
export type Result_16 = { 'Ok' : [] | [Export] } |
  { 'Err' : Error };
export type Result_17 = { 'Ok' : Uint8Array | number[] } |
  { 'Err' : Error };
export type Result_18 = { 'Ok' : [] | [VaultConfig] } |
  { 'Err' : Error };
export type Result_19 = { 'Ok' : Quota } |
  { 'Err' : Error };
export type Result_2 = { 'Ok' : Challenge } |
  { 'Err' : Error };
export type Result_20 = { 'Ok' : UploadStatus } |
  { 'Err' : Error };
export type Result_21 = { 'Ok' : GlobalCapacity } |
  { 'Err' : Error };
export type Result_22 = { 'Ok' : [] | [IncidentContext] } |
  { 'Err' : Error };
export type Result_23 = { 'Ok' : StagedExport } |
  { 'Err' : Error };
export type Result_24 = { 'Ok' : [] | [IncidentStatus] } |
  { 'Err' : Error };
export type Result_25 = { 'Ok' : Array<CredentialInfo> } |
  { 'Err' : Error };
export type Result_26 = { 'Ok' : ObjectPage } |
  { 'Err' : Error };
export type Result_27 = { 'Ok' : Array<Payment> } |
  { 'Err' : Error };
export type Result_28 = { 'Ok' : PendingUploads } |
  { 'Err' : Error };
export type Result_29 = { 'Ok' : Array<UnfinishedVault> } |
  { 'Err' : Error };
export type Result_3 = { 'Ok' : Export } |
  { 'Err' : Error };
export type Result_30 = { 'Ok' : Array<Header> } |
  { 'Err' : Error };
export type Result_31 = { 'Ok' : MutationResult } |
  { 'Err' : Error };
export type Result_32 = { 'Ok' : [] | [Payment] } |
  { 'Err' : Error };
export type Result_33 = { 'Ok' : RestoreAdmissionStatus } |
  { 'Err' : Error };
export type Result_34 = { 'Ok' : [] | [RestoreAdmissionStatus] } |
  { 'Err' : Error };
export type Result_4 = { 'Ok' : null } |
  { 'Err' : Error };
export type Result_5 = { 'Ok' : Upload } |
  { 'Err' : Error };
export type Result_6 = { 'Ok' : BootstrapReply } |
  { 'Err' : Error };
export type Result_7 = { 'Ok' : CleanupProgress } |
  { 'Err' : Error };
export type Result_8 = { 'Ok' : Payment } |
  { 'Err' : Error };
export type Result_9 = { 'Ok' : [] | [CleanupProgress] } |
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
export interface StagedExport {
  'descriptor_digest' : Uint8Array | number[],
  'export' : Export,
  'commitment' : Uint8Array | number[],
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
export type UploadStatus = { 'Committed' : CommittedUpload } |
  { 'Absent' : null } |
  { 'Cancelled' : null } |
  { 'Expired' : null } |
  { 'Pending' : PendingUpload };
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
  { 'Pending' : null } |
  { 'IncidentRequired' : null };
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
  'begin_restore_admission' : ActorMethod<[RestoreAdmissionRequest], Result_2>,
  'begin_restore_grant' : ActorMethod<[GrantRequest], Result_2>,
  'begin_restore_revision' : ActorMethod<
    [Uint8Array | number[], Revision, [] | [Uint8Array | number[]]],
    Result_4
  >,
  'begin_revision' : ActorMethod<[BeginRevision], Result_5>,
  'begin_unlock' : ActorMethod<[BeginUnlock], Result_2>,
  'bootstrap' : ActorMethod<[Bootstrap], Result_6>,
  'cancel_create_empty' : ActorMethod<
    [Uint8Array | number[], PendingCreation, [] | [Generation], bigint],
    Result_7
  >,
  'cancel_pending_key_derivation' : ActorMethod<[], Result_4>,
  'cancel_quote' : ActorMethod<[Uint8Array | number[]], Result_8>,
  'cancel_vault_setup' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_4
  >,
  'cleanup_status' : ActorMethod<[], Result_9>,
  'collect_garbage' : ActorMethod<[], Result_1>,
  'commit_restore' : ActorMethod<[Activate], Result>,
  'commit_restore_revision' : ActorMethod<
    [Uint8Array | number[], bigint, [] | [Uint8Array | number[]]],
    Result_10
  >,
  'commit_revision' : ActorMethod<[Uint8Array | number[]], Result_11>,
  /**
   * Read-only status resolves activation whose old grant has intentionally been invalidated.
   */
  'create_empty_status' : ActorMethod<[], Result_12>,
  'delete_object' : ActorMethod<
    [
      Uint8Array | number[],
      Uint8Array | number[],
      bigint,
      Uint8Array | number[],
    ],
    Result_11
  >,
  'derive_vault_key' : ActorMethod<[Derive], Result_13>,
  'export_index' : ActorMethod<[Uint8Array | number[], bigint], Result_14>,
  'finish_cleanup' : ActorMethod<[Uint8Array | number[], string], Result_15>,
  'finish_export' : ActorMethod<[Uint8Array | number[], boolean], Result>,
  'finish_grant' : ActorMethod<[Uint8Array | number[], string], Result_15>,
  'finish_restore_grant' : ActorMethod<
    [Uint8Array | number[], string, boolean],
    Result_15
  >,
  'get_active_export' : ActorMethod<[], Result_16>,
  'get_active_export_for_vault' : ActorMethod<
    [Uint8Array | number[]],
    Result_16
  >,
  'get_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_17
  >,
  'get_config' : ActorMethod<[], Result_18>,
  'get_export_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_17
  >,
  'get_manifest' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_11
  >,
  'get_quota' : ActorMethod<[Uint8Array | number[]], Result_19>,
  'get_upload_status' : ActorMethod<[Uint8Array | number[]], Result_20>,
  'get_vault_header' : ActorMethod<[Uint8Array | number[]], Result>,
  /**
   * Aggregate capacity is public metadata; it never allocates an owner or account.
   */
  'global_capacity' : ActorMethod<[], Result_21>,
  'http_request' : ActorMethod<[HttpRequest], HttpResponse>,
  'incident_context' : ActorMethod<[], Result_22>,
  'incident_cutover_digest' : ActorMethod<[], Result_17>,
  'incident_source_index' : ActorMethod<
    [
      Uint8Array | number[],
      Uint8Array | number[],
      Uint8Array | number[],
      bigint,
    ],
    Result_14
  >,
  'incident_staged_chunk' : ActorMethod<
    [IncidentRead, Uint8Array | number[], bigint, number],
    Result_17
  >,
  'incident_staged_export' : ActorMethod<[IncidentRead], Result_23>,
  'incident_staged_index' : ActorMethod<[IncidentRead, bigint], Result_14>,
  /**
   * Owner-only encrypted status remains available when configuration is absent or incompatible.
   */
  'incident_status' : ActorMethod<[], Result_24>,
  'initialize_restore_namespace' : ActorMethod<
    [Uint8Array | number[]],
    Result_17
  >,
  'list_credentials' : ActorMethod<[], Result_25>,
  'list_history' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_14
  >,
  'list_objects' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_26
  >,
  'list_payments' : ActorMethod<[], Result_27>,
  'list_pending_uploads' : ActorMethod<[Uint8Array | number[]], Result_28>,
  'list_unfinished_vaults' : ActorMethod<[], Result_29>,
  'list_vaults' : ActorMethod<[], Result_30>,
  'manage_unlock_credential' : ActorMethod<[ManageCredential], Result_4>,
  'mutate' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_31
  >,
  'pay_purchase' : ActorMethod<[Uint8Array | number[]], Result_8>,
  'payment_status' : ActorMethod<[Uint8Array | number[]], Result_32>,
  'prepare_unlock_credential' : ActorMethod<
    [Uint8Array | number[], string],
    Result_17
  >,
  'prove_restore_candidate' : ActorMethod<
    [Uint8Array | number[], string],
    Result_33
  >,
  'prove_restore_current' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_33
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
  'quote_purchase' : ActorMethod<[PurchaseRequest], Result_8>,
  'register_bootstrap' : ActorMethod<
    [Uint8Array | number[], string],
    Result_15
  >,
  'register_restore_candidate' : ActorMethod<
    [Uint8Array | number[], string],
    Result_2
  >,
  'reserve_vault' : ActorMethod<[Reserve], Result>,
  'restore_admission_status' : ActorMethod<[], Result_34>,
  'restore_target_chunk' : ActorMethod<
    [Uint8Array | number[], Generation, Uint8Array | number[], bigint, number],
    Result_17
  >,
  'restore_target_descriptor' : ActorMethod<
    [Uint8Array | number[], Generation],
    Result_23
  >,
  'restore_target_index' : ActorMethod<
    [Uint8Array | number[], Generation, bigint],
    Result_14
  >,
  'restore_target_progress' : ActorMethod<
    [Uint8Array | number[], Generation],
    Result_10
  >,
  'resume_restore_admission' : ActorMethod<[Uint8Array | number[]], Result_2>,
  'set_config' : ActorMethod<[[] | [VaultConfig]], Result_4>,
  'set_funding_config' : ActorMethod<[[] | [FundingConfig]], Result_4>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];

export type VaultActor = _SERVICE;
