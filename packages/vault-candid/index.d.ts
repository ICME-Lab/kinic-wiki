import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export type AccessRole = { 'Viewer' : null } |
  { 'Editor' : null } |
  { 'Owner' : null };
export interface AccountInitialization {
  'balance' : bigint,
  'grant_cycles' : bigint,
}
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
  {
    'RenameVault' : {
      'vault' : Uint8Array | number[],
      'name' : string,
      'expected_sequence' : bigint,
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
  { 'SaveInline' : SaveInline } |
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
export interface BridgeConfig {
  'daily_limit_cycles' : bigint,
  'peer' : Principal,
  'physical_reserve_cycles' : bigint,
  'enabled' : boolean,
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
export interface CommittedUpload {
  'object' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'revision' : bigint,
  'sequence' : bigint,
}
export interface CreateVault { 'operation' : Uint8Array | number[] }
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
  /**
   * Owner-visible display metadata, deliberately separate from the key context.
   */
  'name' : [] | [string],
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
export interface Icrc10SupportedStandard { 'url' : string, 'name' : string }
export interface Icrc21ConsentInfo {
  'metadata' : Icrc21ConsentMessageMetadata,
  'consent_message' : Icrc21ConsentMessage,
}
export type Icrc21ConsentMessage = { 'GenericDisplayMessage' : string };
export interface Icrc21ConsentMessageMetadata {
  'utc_offset_minutes' : [] | [number],
  'language' : string,
}
export interface Icrc21ConsentMessageRequest {
  'arg' : Uint8Array | number[],
  'method' : string,
  'user_preferences' : Icrc21ConsentMessageSpec,
}
export type Icrc21ConsentMessageResponse = { 'Ok' : Icrc21ConsentInfo } |
  { 'Err' : Icrc21Error };
export interface Icrc21ConsentMessageSpec {
  'metadata' : Icrc21ConsentMessageMetadata,
  'device_spec' : [] | [Icrc21DeviceSpec],
}
export type Icrc21DeviceSpec = { 'GenericDisplay' : null } |
  { 'FieldsDisplay' : null };
export type Icrc21Error = { 'GenericError' : Icrc21GenericError } |
  { 'InsufficientPayment' : Icrc21ErrorInfo } |
  { 'UnsupportedCanisterCall' : Icrc21ErrorInfo } |
  { 'ConsentMessageUnavailable' : Icrc21ErrorInfo };
export interface Icrc21ErrorInfo { 'description' : string }
export interface Icrc21GenericError {
  'description' : string,
  'error_code' : bigint,
}
export interface KeyReply {
  'encrypted_key' : Uint8Array | number[],
  'public_key' : Uint8Array | number[],
  'input' : Uint8Array | number[],
}
export interface KeyRetrievalCost {
  'fee' : bigint,
  'owner_fee' : bigint,
  'first_key_free' : boolean,
}
export interface LinkChallenge {
  'challenge' : Uint8Array | number[],
  'generation' : bigint,
  'vault_owner' : Principal,
  'expires_at_ns' : bigint,
}
export interface LinkProof {
  'wiki_owner' : Principal,
  'challenge' : LinkChallenge,
}
export interface LinkStatus {
  'wiki_owner' : Principal,
  'active' : boolean,
  'generation' : bigint,
  'vault_owner' : Principal,
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
  /**
   * True only while the durable operation is known not to have dispatched a debit.
   */
  'preparing' : boolean,
  'attempt' : bigint,
  'request' : PurchaseRequest,
  'memo' : Uint8Array | number[],
  'generation' : bigint,
  'uncertain' : boolean,
  'sent_at' : bigint,
  'wallet' : Principal,
  'created_at_time' : bigint,
  'config' : FundingConfig,
  'reconciliation' : [] | [ReconciliationState],
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
export interface ReconciliationProgress {
  'end' : bigint,
  'next' : bigint,
  'can_continue' : boolean,
  'scanned' : bigint,
  'payment' : Payment,
}
export interface ReconciliationState {
  'end' : bigint,
  'next' : bigint,
  'lease' : bigint,
  'start' : bigint,
  'lease_until' : bigint,
  'spender' : Principal,
  'lease_generation' : bigint,
}
export type RefillResult = { 'Ok' : bigint } |
  { 'Err' : string };
export type RefillResult_1 = { 'Ok' : null } |
  { 'Err' : string };
export type Result = { 'Ok' : bigint } |
  { 'Err' : Error };
export type Result_1 = { 'Ok' : null } |
  { 'Err' : BridgeError };
export type Result_10 = { 'Ok' : Revision } |
  { 'Err' : Error };
export type Result_11 = { 'Ok' : Quota } |
  { 'Err' : Error };
export type Result_12 = { 'Ok' : SpendingStatus } |
  { 'Err' : Error };
export type Result_13 = { 'Ok' : UploadStatus } |
  { 'Err' : Error };
export type Result_14 = { 'Ok' : VaultAccess } |
  { 'Err' : Error };
export type Result_15 = { 'Ok' : GlobalCapacity } |
  { 'Err' : Error };
export type Result_16 = { 'Ok' : AccountInitialization } |
  { 'Err' : Error };
export type Result_17 = { 'Ok' : VaultAccessPage } |
  { 'Err' : Error };
export type Result_18 = { 'Ok' : RevisionPage } |
  { 'Err' : Error };
export type Result_19 = { 'Ok' : ObjectPage } |
  { 'Err' : Error };
export type Result_2 = { 'Ok' : LinkChallenge } |
  { 'Err' : BridgeError };
export type Result_20 = { 'Ok' : Array<Payment> } |
  { 'Err' : Error };
export type Result_21 = { 'Ok' : PendingUploads } |
  { 'Err' : Error };
export type Result_22 = { 'Ok' : Array<VaultMember> } |
  { 'Err' : Error };
export type Result_23 = { 'Ok' : Array<Header> } |
  { 'Err' : Error };
export type Result_24 = { 'Ok' : MutationResult } |
  { 'Err' : Error };
export type Result_25 = { 'Ok' : [] | [Payment] } |
  { 'Err' : Error };
export type Result_26 = { 'Ok' : CreditReceipt } |
  { 'Err' : BridgeError };
export type Result_27 = { 'Ok' : ReconciliationProgress } |
  { 'Err' : Error };
export type Result_28 = { 'Ok' : null } |
  { 'Err' : Error };
export type Result_29 = { 'Ok' : BridgeRevocation } |
  { 'Err' : BridgeError };
export type Result_3 = { 'Ok' : Payment } |
  { 'Err' : Error };
export type Result_30 = { 'Ok' : KeyRetrievalCost } |
  { 'Err' : Error };
export type Result_31 = { 'Ok' : [] | [LinkStatus] } |
  { 'Err' : BridgeError };
export type Result_4 = { 'Ok' : LinkProof } |
  { 'Err' : BridgeError };
export type Result_5 = { 'Ok' : Header } |
  { 'Err' : Error };
export type Result_6 = { 'Ok' : KeyReply } |
  { 'Err' : Error };
export type Result_7 = { 'Ok' : Uint8Array | number[] } |
  { 'Err' : Error };
export type Result_8 = { 'Ok' : [] | [VaultConfig] } |
  { 'Err' : Error };
export type Result_9 = { 'Ok' : [] | [FundingConfig] } |
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
/**
 * One bounded, atomic revision using the unlocked immutable key context.
 */
export interface SaveInline {
  'request' : BeginRevision,
  'bytes' : Uint8Array | number[],
  'context_hash' : Uint8Array | number[],
}
/**
 * Advisory admission for new paid work. Request-specific costs and limits still apply.
 */
export type SpendingStatus = { 'AccountCreditLow' : null } |
  { 'Available' : null } |
  { 'ServiceReserveLow' : null } |
  { 'Unconfigured' : null };
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
export interface VaultAccess {
  'owner' : Principal,
  'role' : AccessRole,
  'header' : Header,
}
export interface VaultAccessPage {
  'next' : [] | [Uint8Array | number[]],
  'entries' : Array<VaultAccess>,
}
export interface VaultConfig { 'minimum_cycles' : bigint, 'key_name' : string }
export interface VaultMember { 'principal' : Principal, 'role' : AccessRole }
export type VaultState = { 'Deleting' : null } |
  { 'Active' : null } |
  { 'Pending' : null };
export interface _SERVICE {
  'account_balance' : ActorMethod<[], Result>,
  'acknowledge_wiki_credit' : ActorMethod<[CreditOffer], Result_1>,
  'acknowledge_wiki_link' : ActorMethod<[LinkProof], Result_1>,
  'begin_wiki_link' : ActorMethod<[Uint8Array | number[]], Result_2>,
  'cancel_quote' : ActorMethod<[Uint8Array | number[]], Result_3>,
  'consume_wiki_link' : ActorMethod<
    [Uint8Array | number[], Principal],
    Result_4
  >,
  'create_vault' : ActorMethod<[CreateVault], Result_5>,
  'cycles_balance_for_wiki' : ActorMethod<[], RefillResult>,
  'derive_vault_key' : ActorMethod<[DeriveKey], Result_6>,
  'get_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_7
  >,
  'get_config' : ActorMethod<[], Result_8>,
  'get_funding_config' : ActorMethod<[], Result_9>,
  'get_manifest' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_10
  >,
  'get_quota' : ActorMethod<[Uint8Array | number[]], Result_11>,
  'get_spending_status' : ActorMethod<[], Result_12>,
  'get_upload_status' : ActorMethod<[Uint8Array | number[]], Result_13>,
  'get_vault_access' : ActorMethod<[Uint8Array | number[]], Result_14>,
  'get_vault_header' : ActorMethod<[Uint8Array | number[]], Result_5>,
  'global_capacity' : ActorMethod<[], Result_15>,
  'http_request' : ActorMethod<[HttpRequest], HttpResponse>,
  'icrc10_supported_standards' : ActorMethod<
    [],
    Array<Icrc10SupportedStandard>
  >,
  'icrc21_canister_call_consent_message' : ActorMethod<
    [Icrc21ConsentMessageRequest],
    Icrc21ConsentMessageResponse
  >,
  'initialize_vault_account' : ActorMethod<[], Result_16>,
  'inspect_wiki_link' : ActorMethod<[Uint8Array | number[]], Result_2>,
  'list_accessible_vaults' : ActorMethod<[Uint8Array | number[]], Result_17>,
  'list_history' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_18
  >,
  'list_objects' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_19
  >,
  'list_payments' : ActorMethod<[], Result_20>,
  'list_pending_uploads' : ActorMethod<[Uint8Array | number[]], Result_21>,
  'list_vault_members' : ActorMethod<[Uint8Array | number[]], Result_22>,
  'list_vaults' : ActorMethod<[], Result_23>,
  'mutate' : ActorMethod<[Mutation], Result_24>,
  'pay_purchase' : ActorMethod<[Uint8Array | number[]], Result_3>,
  'payment_status' : ActorMethod<[Uint8Array | number[]], Result_25>,
  'prepare_wiki_credit' : ActorMethod<[Uint8Array | number[]], Result_26>,
  'quote_purchase' : ActorMethod<[PurchaseRequest], Result_3>,
  'receive_wiki_credit' : ActorMethod<[CreditOffer], Result_26>,
  'reconcile_purchase' : ActorMethod<[Uint8Array | number[]], Result_27>,
  'remove_vault_member' : ActorMethod<
    [Uint8Array | number[], Principal],
    Result_28
  >,
  'revoke_wiki_link' : ActorMethod<[], Result_29>,
  'set_config' : ActorMethod<[[] | [VaultConfig]], Result_28>,
  'set_cycles_refill_source' : ActorMethod<[[] | [Principal]], RefillResult_1>,
  'set_funding_config' : ActorMethod<[[] | [FundingConfig]], Result_28>,
  'set_vault_member' : ActorMethod<
    [Uint8Array | number[], Principal, AccessRole],
    Result_28
  >,
  'set_wiki_bridge_config' : ActorMethod<[BridgeConfig], Result_1>,
  'shared_derive_vault_key' : ActorMethod<[DeriveKey], Result_6>,
  'shared_get_chunk' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint, number],
    Result_7
  >,
  'shared_get_manifest' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_10
  >,
  'shared_get_quota' : ActorMethod<[Uint8Array | number[]], Result_11>,
  'shared_get_upload_status' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_13
  >,
  'shared_list_history' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[], bigint],
    Result_18
  >,
  'shared_list_objects' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_19
  >,
  'shared_list_pending_uploads' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    Result_21
  >,
  'shared_mutate' : ActorMethod<[Uint8Array | number[], Mutation], Result_24>,
  'vault_key_cost' : ActorMethod<[[] | [string]], Result_30>,
  'wiki_bridge_config' : ActorMethod<[], [] | [BridgeConfig]>,
  'wiki_credit_status' : ActorMethod<[CreditOffer], Result_26>,
  'wiki_link_status' : ActorMethod<[], Result_31>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
