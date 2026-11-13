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
  const Payment = IDL.Record({
    'fee' : IDL.Nat64,
    'status' : Status,
    'credits' : IDL.Nat64,
    'attempt' : IDL.Nat64,
    'request' : PurchaseRequest,
    'memo' : IDL.Vec(IDL.Nat8),
    'generation' : IDL.Int64,
    'uncertain' : IDL.Bool,
    'sent_at' : IDL.Nat64,
    'wallet' : IDL.Principal,
    'created_at_time' : IDL.Nat64,
    'config' : FundingConfig,
  });
  const Result_1 = IDL.Variant({ 'Ok' : Payment, 'Err' : Error });
  const CreateVault = IDL.Record({
    'vault' : IDL.Vec(IDL.Nat8),
    'operation' : IDL.Vec(IDL.Nat8),
  });
  const VaultState = IDL.Variant({
    'Deleting' : IDL.Null,
    'Active' : IDL.Null,
    'Deleted' : IDL.Null,
    'Pending' : IDL.Null,
  });
  const Header = IDL.Record({
    'id' : IDL.Vec(IDL.Nat8),
    'public_key' : IDL.Vec(IDL.Nat8),
    'state' : VaultState,
    'nonce' : IDL.Vec(IDL.Nat8),
    'key_name' : IDL.Text,
    'sequence' : IDL.Nat64,
  });
  const Result_2 = IDL.Variant({ 'Ok' : Header, 'Err' : Error });
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
  const Result_3 = IDL.Variant({ 'Ok' : KeyReply, 'Err' : Error });
  const Result_4 = IDL.Variant({ 'Ok' : IDL.Vec(IDL.Nat8), 'Err' : Error });
  const VaultConfig = IDL.Record({
    'minimum_cycles' : IDL.Nat64,
    'key_name' : IDL.Text,
  });
  const Result_5 = IDL.Variant({ 'Ok' : IDL.Opt(VaultConfig), 'Err' : Error });
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
  const Result_6 = IDL.Variant({ 'Ok' : Revision, 'Err' : Error });
  const Quota = IDL.Record({
    'reserved' : IDL.Nat64,
    'limit' : IDL.Nat64,
    'current' : IDL.Nat64,
    'charged' : IDL.Nat64,
  });
  const Result_7 = IDL.Variant({ 'Ok' : Quota, 'Err' : Error });
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
  const Result_8 = IDL.Variant({ 'Ok' : UploadStatus, 'Err' : Error });
  const GlobalCapacity = IDL.Record({
    'used' : IDL.Nat64,
    'overcommitted' : IDL.Bool,
    'limit' : IDL.Nat64,
    'overage' : IDL.Nat64,
    'accounting_reserved' : IDL.Nat64,
  });
  const Result_9 = IDL.Variant({ 'Ok' : GlobalCapacity, 'Err' : Error });
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
  const RevisionPage = IDL.Record({
    'next' : IDL.Opt(IDL.Nat64),
    'entries' : IDL.Vec(Revision),
  });
  const Result_10 = IDL.Variant({ 'Ok' : RevisionPage, 'Err' : Error });
  const ObjectPage = IDL.Record({
    'next' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'entries' : IDL.Vec(Revision),
  });
  const Result_11 = IDL.Variant({ 'Ok' : ObjectPage, 'Err' : Error });
  const Result_12 = IDL.Variant({ 'Ok' : IDL.Vec(Payment), 'Err' : Error });
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
  const Result_13 = IDL.Variant({ 'Ok' : PendingUploads, 'Err' : Error });
  const Result_14 = IDL.Variant({ 'Ok' : IDL.Vec(Header), 'Err' : Error });
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
    'DeleteVault' : IDL.Record({ 'vault' : IDL.Vec(IDL.Nat8) }),
    'Collect' : IDL.Null,
    'PurgeObject' : IDL.Record({
      'object' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
      'expected_revision' : IDL.Nat64,
    }),
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
  const Result_15 = IDL.Variant({ 'Ok' : MutationResult, 'Err' : Error });
  const Result_16 = IDL.Variant({ 'Ok' : IDL.Opt(Payment), 'Err' : Error });
  const Result_17 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : Error });
  return IDL.Service({
    'account_balance' : IDL.Func([], [Result], ['query']),
    'cancel_quote' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_1], []),
    'create_vault' : IDL.Func([CreateVault], [Result_2], []),
    'derive_vault_key' : IDL.Func([DeriveKey], [Result_3], []),
    'get_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Nat32],
        [Result_4],
        [],
      ),
    'get_config' : IDL.Func([], [Result_5], []),
    'get_manifest' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_6],
        [],
      ),
    'get_quota' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_7], []),
    'get_upload_status' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_8], []),
    'get_vault_header' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_2], []),
    'global_capacity' : IDL.Func([], [Result_9], ['query']),
    'http_request' : IDL.Func([HttpRequest], [HttpResponse], ['query']),
    'list_history' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_10],
        [],
      ),
    'list_objects' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_11],
        [],
      ),
    'list_payments' : IDL.Func([], [Result_12], ['query']),
    'list_pending_uploads' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_13], []),
    'list_vaults' : IDL.Func([], [Result_14], []),
    'mutate' : IDL.Func([Mutation], [Result_15], []),
    'pay_purchase' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_1], []),
    'payment_status' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_16], ['query']),
    'quote_purchase' : IDL.Func([PurchaseRequest], [Result_1], []),
    'set_config' : IDL.Func([IDL.Opt(VaultConfig)], [Result_17], []),
    'set_funding_config' : IDL.Func([IDL.Opt(FundingConfig)], [Result_17], []),
  });
};
export const init = ({ IDL }) => { return []; };
