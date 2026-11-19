export const idlFactory = ({ IDL }) => {
  const Error = IDL.Variant({
    'Storage' : IDL.Null,
    'InvalidInput' : IDL.Null,
    'Busy' : IDL.Null,
    'KeyService' : IDL.Null,
    'NotFound' : IDL.Null,
    'Unauthorized' : IDL.Null,
    'Expired' : IDL.Null,
    'QuotaExceeded' : IDL.Null,
    'Conflict' : IDL.Null,
  });
  const Result = IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : Error });
  const CreditOffer = IDL.Record({
    'wiki_owner' : IDL.Principal,
    'link_generation' : IDL.Nat64,
    'operation' : IDL.Vec(IDL.Nat8),
    'amount_cycles' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
    'expires_at_ns' : IDL.Nat64,
  });
  const BridgeError = IDL.Variant({
    'Storage' : IDL.Null,
    'InvalidInput' : IDL.Null,
    'Disabled' : IDL.Null,
    'NotFound' : IDL.Null,
    'Unauthorized' : IDL.Null,
    'Capacity' : IDL.Null,
    'Unavailable' : IDL.Null,
    'Expired' : IDL.Null,
    'Conflict' : IDL.Null,
  });
  const Result_1 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : BridgeError });
  const LinkChallenge = IDL.Record({
    'challenge' : IDL.Vec(IDL.Nat8),
    'generation' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
    'expires_at_ns' : IDL.Nat64,
  });
  const LinkProof = IDL.Record({
    'wiki_owner' : IDL.Principal,
    'challenge' : LinkChallenge,
  });
  const Result_2 = IDL.Variant({ 'Ok' : LinkChallenge, 'Err' : BridgeError });
  const Status = IDL.Variant({
    'Quoted' : IDL.Null,
    'InsufficientAllowance' : IDL.Null,
    'Paid' : IDL.Nat64,
    'BadFee' : IDL.Nat64,
    'Rejected' : IDL.Null,
    'InFlight' : IDL.Null,
    'Unknown' : IDL.Null,
    'Expired' : IDL.Null,
    'InsufficientFunds' : IDL.Null,
  });
  const PurchaseRequest = IDL.Record({
    'beneficiary' : IDL.Principal,
    'amount_e8s' : IDL.Nat64,
    'operation' : IDL.Vec(IDL.Nat8),
    'min_credits' : IDL.Nat64,
    'created_at_time' : IDL.Nat64,
  });
  const FundingConfig = IDL.Record({
    'recipient' : IDL.Principal,
    'cycles_per_kinic' : IDL.Nat64,
    'ledger' : IDL.Principal,
  });
  const ReconciliationState = IDL.Record({
    'end' : IDL.Nat64,
    'next' : IDL.Nat64,
    'lease' : IDL.Nat64,
    'start' : IDL.Nat64,
    'lease_until' : IDL.Nat64,
    'spender' : IDL.Principal,
    'lease_generation' : IDL.Int64,
  });
  const Payment = IDL.Record({
    'fee' : IDL.Nat64,
    'status' : Status,
    'credits' : IDL.Nat64,
    'preparing' : IDL.Bool,
    'attempt' : IDL.Nat64,
    'request' : PurchaseRequest,
    'memo' : IDL.Vec(IDL.Nat8),
    'generation' : IDL.Int64,
    'uncertain' : IDL.Bool,
    'sent_at' : IDL.Nat64,
    'wallet' : IDL.Principal,
    'created_at_time' : IDL.Nat64,
    'config' : FundingConfig,
    'reconciliation' : IDL.Opt(ReconciliationState),
  });
  const Result_3 = IDL.Variant({ 'Ok' : Payment, 'Err' : Error });
  const Result_4 = IDL.Variant({ 'Ok' : LinkProof, 'Err' : BridgeError });
  const CreateVault = IDL.Record({ 'operation' : IDL.Vec(IDL.Nat8) });
  const VaultState = IDL.Variant({
    'Deleting' : IDL.Null,
    'Active' : IDL.Null,
    'Pending' : IDL.Null,
  });
  const Header = IDL.Record({
    'id' : IDL.Vec(IDL.Nat8),
    'public_key' : IDL.Vec(IDL.Nat8),
    'name' : IDL.Opt(IDL.Text),
    'state' : VaultState,
    'nonce' : IDL.Vec(IDL.Nat8),
    'key_name' : IDL.Text,
    'sequence' : IDL.Nat64,
  });
  const Result_5 = IDL.Variant({ 'Ok' : Header, 'Err' : Error });
  const DeriveKey = IDL.Record({
    'vault' : IDL.Vec(IDL.Nat8),
    'transport' : IDL.Vec(IDL.Nat8),
    'operation' : IDL.Vec(IDL.Nat8),
  });
  const KeyReply = IDL.Record({
    'encrypted_key' : IDL.Vec(IDL.Nat8),
    'public_key' : IDL.Vec(IDL.Nat8),
    'input' : IDL.Vec(IDL.Nat8),
  });
  const Result_6 = IDL.Variant({ 'Ok' : KeyReply, 'Err' : Error });
  const Result_7 = IDL.Variant({ 'Ok' : IDL.Vec(IDL.Nat8), 'Err' : Error });
  const VaultConfig = IDL.Record({
    'minimum_cycles' : IDL.Nat64,
    'key_name' : IDL.Text,
  });
  const Result_8 = IDL.Variant({ 'Ok' : IDL.Opt(VaultConfig), 'Err' : Error });
  const Result_9 = IDL.Variant({
    'Ok' : IDL.Opt(FundingConfig),
    'Err' : Error,
  });
  const Revision = IDL.Record({
    'deleted' : IDL.Bool,
    'object' : IDL.Vec(IDL.Nat8),
    'vault' : IDL.Vec(IDL.Nat8),
    'chunk_hashes' : IDL.Vec(IDL.Vec(IDL.Nat8)),
    'revision' : IDL.Nat64,
    'manifest' : IDL.Vec(IDL.Nat8),
    'plain_size' : IDL.Nat64,
    'sequence' : IDL.Nat64,
  });
  const Result_10 = IDL.Variant({ 'Ok' : Revision, 'Err' : Error });
  const Quota = IDL.Record({
    'reserved' : IDL.Nat64,
    'limit' : IDL.Nat64,
    'current' : IDL.Nat64,
    'charged' : IDL.Nat64,
  });
  const Result_11 = IDL.Variant({ 'Ok' : Quota, 'Err' : Error });
  const SpendingStatus = IDL.Variant({
    'AccountCreditLow' : IDL.Null,
    'Available' : IDL.Null,
    'ServiceReserveLow' : IDL.Null,
    'Unconfigured' : IDL.Null,
  });
  const Result_12 = IDL.Variant({ 'Ok' : SpendingStatus, 'Err' : Error });
  const CommittedUpload = IDL.Record({
    'object' : IDL.Vec(IDL.Nat8),
    'vault' : IDL.Vec(IDL.Nat8),
    'revision' : IDL.Nat64,
    'sequence' : IDL.Nat64,
  });
  const BeginRevision = IDL.Record({
    'object' : IDL.Vec(IDL.Nat8),
    'vault' : IDL.Vec(IDL.Nat8),
    'chunk_hashes' : IDL.Vec(IDL.Vec(IDL.Nat8)),
    'operation' : IDL.Vec(IDL.Nat8),
    'manifest' : IDL.Vec(IDL.Nat8),
    'plain_size' : IDL.Nat64,
    'expected_revision' : IDL.Nat64,
  });
  const PendingUpload = IDL.Record({
    'expires' : IDL.Nat64,
    'request' : BeginRevision,
    'cancel_job' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'received' : IDL.Vec(IDL.Nat32),
  });
  const UploadStatus = IDL.Variant({
    'Committed' : CommittedUpload,
    'Absent' : IDL.Null,
    'Cancelled' : IDL.Null,
    'Expired' : IDL.Null,
    'Pending' : PendingUpload,
  });
  const Result_13 = IDL.Variant({ 'Ok' : UploadStatus, 'Err' : Error });
  const AccessRole = IDL.Variant({
    'Viewer' : IDL.Null,
    'Editor' : IDL.Null,
    'Owner' : IDL.Null,
  });
  const VaultAccess = IDL.Record({
    'owner' : IDL.Principal,
    'role' : AccessRole,
    'header' : Header,
  });
  const Result_14 = IDL.Variant({ 'Ok' : VaultAccess, 'Err' : Error });
  const GlobalCapacity = IDL.Record({
    'used' : IDL.Nat64,
    'overcommitted' : IDL.Bool,
    'limit' : IDL.Nat64,
    'overage' : IDL.Nat64,
    'accounting_reserved' : IDL.Nat64,
  });
  const Result_15 = IDL.Variant({ 'Ok' : GlobalCapacity, 'Err' : Error });
  const HttpRequest = IDL.Record({
    'url' : IDL.Text,
    'method' : IDL.Text,
    'body' : IDL.Vec(IDL.Nat8),
    'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    'certificate_version' : IDL.Opt(IDL.Nat16),
  });
  const HttpResponse = IDL.Record({
    'body' : IDL.Vec(IDL.Nat8),
    'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    'upgrade' : IDL.Opt(IDL.Bool),
    'status_code' : IDL.Nat16,
  });
  const Icrc10SupportedStandard = IDL.Record({
    'url' : IDL.Text,
    'name' : IDL.Text,
  });
  const Icrc21ConsentMessageMetadata = IDL.Record({
    'utc_offset_minutes' : IDL.Opt(IDL.Int16),
    'language' : IDL.Text,
  });
  const Icrc21DeviceSpec = IDL.Variant({
    'GenericDisplay' : IDL.Null,
    'FieldsDisplay' : IDL.Null,
  });
  const Icrc21ConsentMessageSpec = IDL.Record({
    'metadata' : Icrc21ConsentMessageMetadata,
    'device_spec' : IDL.Opt(Icrc21DeviceSpec),
  });
  const Icrc21ConsentMessageRequest = IDL.Record({
    'arg' : IDL.Vec(IDL.Nat8),
    'method' : IDL.Text,
    'user_preferences' : Icrc21ConsentMessageSpec,
  });
  const Icrc21ConsentMessage = IDL.Variant({
    'GenericDisplayMessage' : IDL.Text,
  });
  const Icrc21ConsentInfo = IDL.Record({
    'metadata' : Icrc21ConsentMessageMetadata,
    'consent_message' : Icrc21ConsentMessage,
  });
  const Icrc21GenericError = IDL.Record({
    'description' : IDL.Text,
    'error_code' : IDL.Nat,
  });
  const Icrc21ErrorInfo = IDL.Record({ 'description' : IDL.Text });
  const Icrc21Error = IDL.Variant({
    'GenericError' : Icrc21GenericError,
    'InsufficientPayment' : Icrc21ErrorInfo,
    'UnsupportedCanisterCall' : Icrc21ErrorInfo,
    'ConsentMessageUnavailable' : Icrc21ErrorInfo,
  });
  const Icrc21ConsentMessageResponse = IDL.Variant({
    'Ok' : Icrc21ConsentInfo,
    'Err' : Icrc21Error,
  });
  const AccountInitialization = IDL.Record({
    'balance' : IDL.Nat64,
    'grant_cycles' : IDL.Nat64,
  });
  const Result_16 = IDL.Variant({
    'Ok' : AccountInitialization,
    'Err' : Error,
  });
  const VaultAccessPage = IDL.Record({
    'next' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'entries' : IDL.Vec(VaultAccess),
  });
  const Result_17 = IDL.Variant({ 'Ok' : VaultAccessPage, 'Err' : Error });
  const RevisionPage = IDL.Record({
    'next' : IDL.Opt(IDL.Nat64),
    'entries' : IDL.Vec(Revision),
  });
  const Result_18 = IDL.Variant({ 'Ok' : RevisionPage, 'Err' : Error });
  const ObjectPage = IDL.Record({
    'next' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'entries' : IDL.Vec(Revision),
  });
  const Result_19 = IDL.Variant({ 'Ok' : ObjectPage, 'Err' : Error });
  const Result_20 = IDL.Variant({ 'Ok' : IDL.Vec(Payment), 'Err' : Error });
  const PendingUploadSummary = IDL.Record({
    'expires' : IDL.Nat64,
    'vault' : IDL.Vec(IDL.Nat8),
    'upload' : IDL.Vec(IDL.Nat8),
    'cancel_job' : IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const PendingUploads = IDL.Record({
    'next' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'entries' : IDL.Vec(PendingUploadSummary),
  });
  const Result_21 = IDL.Variant({ 'Ok' : PendingUploads, 'Err' : Error });
  const VaultMember = IDL.Record({
    'principal' : IDL.Principal,
    'role' : AccessRole,
  });
  const Result_22 = IDL.Variant({ 'Ok' : IDL.Vec(VaultMember), 'Err' : Error });
  const Result_23 = IDL.Variant({ 'Ok' : IDL.Vec(Header), 'Err' : Error });
  const SaveInline = IDL.Record({
    'request' : BeginRevision,
    'bytes' : IDL.Vec(IDL.Nat8),
    'context_hash' : IDL.Vec(IDL.Nat8),
  });
  const Action = IDL.Variant({
    'CancelUpload' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
      'upload' : IDL.Vec(IDL.Nat8),
    }),
    'PutChunk' : IDL.Record({
      'upload' : IDL.Vec(IDL.Nat8),
      'bytes' : IDL.Vec(IDL.Nat8),
      'index' : IDL.Nat32,
    }),
    'CommitRevision' : IDL.Record({ 'upload' : IDL.Vec(IDL.Nat8) }),
    'DeleteObject' : IDL.Record({
      'object' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
      'expected_revision' : IDL.Nat64,
    }),
    'RenameVault' : IDL.Record({
      'vault' : IDL.Vec(IDL.Nat8),
      'name' : IDL.Text,
      'expected_sequence' : IDL.Nat64,
    }),
    'DeleteVault' : IDL.Record({ 'vault' : IDL.Vec(IDL.Nat8) }),
    'Collect' : IDL.Null,
    'PurgeObject' : IDL.Record({
      'object' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
      'expected_revision' : IDL.Nat64,
    }),
    'SaveInline' : SaveInline,
    'BeginRevision' : BeginRevision,
  });
  const Mutation = IDL.Record({
    'action' : Action,
    'operation' : IDL.Vec(IDL.Nat8),
  });
  const Upload = IDL.Record({
    'id' : IDL.Vec(IDL.Nat8),
    'expires' : IDL.Nat64,
    'revision' : IDL.Nat64,
  });
  const MutationResult = IDL.Variant({
    'Collected' : IDL.Nat64,
    'Done' : IDL.Null,
    'Progress' : IDL.Bool,
    'Revision' : Revision,
    'Upload' : Upload,
  });
  const Result_24 = IDL.Variant({ 'Ok' : MutationResult, 'Err' : Error });
  const Result_25 = IDL.Variant({ 'Ok' : IDL.Opt(Payment), 'Err' : Error });
  const CreditStatus = IDL.Variant({
    'Prepared' : IDL.Null,
    'Accepted' : IDL.Null,
    'NotAccepted' : IDL.Null,
  });
  const CreditReceipt = IDL.Record({
    'status' : CreditStatus,
    'offer' : CreditOffer,
  });
  const Result_26 = IDL.Variant({ 'Ok' : CreditReceipt, 'Err' : BridgeError });
  const ReconciliationProgress = IDL.Record({
    'end' : IDL.Nat,
    'next' : IDL.Nat,
    'can_continue' : IDL.Bool,
    'scanned' : IDL.Nat64,
    'payment' : Payment,
  });
  const Result_27 = IDL.Variant({
    'Ok' : ReconciliationProgress,
    'Err' : Error,
  });
  const Result_28 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : Error });
  const BridgeRevocation = IDL.Record({
    'through_generation' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
  });
  const Result_29 = IDL.Variant({
    'Ok' : BridgeRevocation,
    'Err' : BridgeError,
  });
  const BridgeConfig = IDL.Record({
    'daily_limit_cycles' : IDL.Nat64,
    'peer' : IDL.Principal,
    'physical_reserve_cycles' : IDL.Nat64,
    'enabled' : IDL.Bool,
  });
  const KeyRetrievalCost = IDL.Record({
    'fee' : IDL.Nat64,
    'owner_fee' : IDL.Nat64,
    'first_key_free' : IDL.Bool,
  });
  const Result_30 = IDL.Variant({ 'Ok' : KeyRetrievalCost, 'Err' : Error });
  const LinkStatus = IDL.Record({
    'wiki_owner' : IDL.Principal,
    'active' : IDL.Bool,
    'generation' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
  });
  const Result_31 = IDL.Variant({
    'Ok' : IDL.Opt(LinkStatus),
    'Err' : BridgeError,
  });
  return IDL.Service({
    'account_balance' : IDL.Func([], [Result], ['query']),
    'acknowledge_wiki_credit' : IDL.Func([CreditOffer], [Result_1], []),
    'acknowledge_wiki_link' : IDL.Func([LinkProof], [Result_1], []),
    'begin_wiki_link' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_2], []),
    'cancel_quote' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_3], []),
    'consume_wiki_link' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Principal],
        [Result_4],
        [],
      ),
    'create_vault' : IDL.Func([CreateVault], [Result_5], []),
    'derive_vault_key' : IDL.Func([DeriveKey], [Result_6], []),
    'get_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Nat32],
        [Result_7],
        [],
      ),
    'get_config' : IDL.Func([], [Result_8], []),
    'get_funding_config' : IDL.Func([], [Result_9], ['query']),
    'get_manifest' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_10],
        [],
      ),
    'get_quota' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_11], []),
    'get_spending_status' : IDL.Func([], [Result_12], []),
    'get_upload_status' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_13], []),
    'get_vault_access' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_14], []),
    'get_vault_header' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_5], []),
    'global_capacity' : IDL.Func([], [Result_15], ['query']),
    'http_request' : IDL.Func([HttpRequest], [HttpResponse], ['query']),
    'icrc10_supported_standards' : IDL.Func(
        [],
        [IDL.Vec(Icrc10SupportedStandard)],
        ['query'],
      ),
    'icrc21_canister_call_consent_message' : IDL.Func(
        [Icrc21ConsentMessageRequest],
        [Icrc21ConsentMessageResponse],
        [],
      ),
    'initialize_vault_account' : IDL.Func([], [Result_16], []),
    'inspect_wiki_link' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_2], []),
    'list_accessible_vaults' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_17], []),
    'list_history' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_18],
        [],
      ),
    'list_objects' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_19],
        [],
      ),
    'list_payments' : IDL.Func([], [Result_20], ['query']),
    'list_pending_uploads' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_21], []),
    'list_vault_members' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_22], []),
    'list_vaults' : IDL.Func([], [Result_23], []),
    'mutate' : IDL.Func([Mutation], [Result_24], []),
    'pay_purchase' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_3], []),
    'payment_status' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_25], ['query']),
    'prepare_wiki_credit' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_26], []),
    'quote_purchase' : IDL.Func([PurchaseRequest], [Result_3], []),
    'receive_wiki_credit' : IDL.Func([CreditOffer], [Result_26], []),
    'reconcile_purchase' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_27], []),
    'remove_vault_member' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Principal],
        [Result_28],
        [],
      ),
    'revoke_wiki_link' : IDL.Func([], [Result_29], []),
    'set_config' : IDL.Func([IDL.Opt(VaultConfig)], [Result_28], []),
    'set_funding_config' : IDL.Func([IDL.Opt(FundingConfig)], [Result_28], []),
    'set_vault_member' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Principal, AccessRole],
        [Result_28],
        [],
      ),
    'set_wiki_bridge_config' : IDL.Func([BridgeConfig], [Result_1], []),
    'shared_derive_vault_key' : IDL.Func([DeriveKey], [Result_6], []),
    'shared_get_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Nat32],
        [Result_7],
        [],
      ),
    'shared_get_manifest' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_10],
        [],
      ),
    'shared_get_quota' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_11], []),
    'shared_get_upload_status' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_13],
        [],
      ),
    'shared_list_history' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_18],
        [],
      ),
    'shared_list_objects' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_19],
        [],
      ),
    'shared_list_pending_uploads' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_21],
        [],
      ),
    'shared_mutate' : IDL.Func([IDL.Vec(IDL.Nat8), Mutation], [Result_24], []),
    'vault_key_cost' : IDL.Func([IDL.Opt(IDL.Text)], [Result_30], ['query']),
    'wiki_bridge_config' : IDL.Func([], [IDL.Opt(BridgeConfig)], ['query']),
    'wiki_credit_status' : IDL.Func([CreditOffer], [Result_26], []),
    'wiki_link_status' : IDL.Func([], [Result_31], []),
  });
};
export const init = ({ IDL }) => { return []; };
