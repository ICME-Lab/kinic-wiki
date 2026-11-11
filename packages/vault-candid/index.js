export const idlFactory = ({ IDL }) => {
  const Envelope = IDL.Record({
    'ciphertext' : IDL.Vec(IDL.Nat8),
    'version' : IDL.Nat8,
    'nonce' : IDL.Vec(IDL.Nat8),
  });
  const VaultState = IDL.Variant({
    'Active' : IDL.Null,
    'Restoring' : IDL.Null,
    'Pending' : IDL.Null,
  });
  const Header = IDL.Record({
    'id' : IDL.Vec(IDL.Nat8),
    'normal' : IDL.Opt(Envelope),
    'epoch' : IDL.Nat64,
    'backup_sequence' : IDL.Opt(IDL.Nat64),
    'state' : VaultState,
    'key_name' : IDL.Text,
    'recovery' : IDL.Opt(Envelope),
    'sequence' : IDL.Nat64,
    'backup_at' : IDL.Opt(IDL.Nat64),
  });
  const Error = IDL.Variant({
    'Storage' : IDL.Null,
    'InvalidInput' : IDL.Null,
    'Busy' : IDL.Null,
    'InvalidProof' : IDL.Null,
    'KeyService' : IDL.Null,
    'NotFound' : IDL.Null,
    'ExportInProgress' : IDL.Null,
    'Unauthorized' : IDL.Null,
    'Expired' : IDL.Null,
    'QuotaExceeded' : IDL.Null,
    'Conflict' : IDL.Null,
  });
  const Result = IDL.Variant({ 'Ok' : Header, 'Err' : Error });
  const Result_1 = IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : Error });
  const Activate = IDL.Record({
    'normal' : Envelope,
    'attempt' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'vault' : IDL.Vec(IDL.Nat8),
    'registration' : IDL.Opt(IDL.Text),
    'assertion' : IDL.Opt(IDL.Text),
    'operation' : IDL.Vec(IDL.Nat8),
    'recovery' : Envelope,
  });
  const Export = IDL.Record({
    'id' : IDL.Vec(IDL.Nat8),
    'expires' : IDL.Nat64,
    'vault' : IDL.Vec(IDL.Nat8),
    'plain_bytes' : IDL.Nat64,
    'state' : IDL.Text,
    'chunk_count' : IDL.Nat64,
    'sequence' : IDL.Nat64,
    'record_count' : IDL.Nat64,
    'header' : Header,
  });
  const Result_2 = IDL.Variant({ 'Ok' : Export, 'Err' : Error });
  const BeginRestore = IDL.Record({
    'count' : IDL.Nat64,
    'root' : IDL.Vec(IDL.Nat8),
    'operation' : IDL.Vec(IDL.Nat8),
    'reserved_bytes' : IDL.Nat64,
    'header' : Header,
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
  const Result_3 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : Error });
  const BeginRevision = IDL.Record({
    'object' : IDL.Vec(IDL.Nat8),
    'vault' : IDL.Vec(IDL.Nat8),
    'chunk_hashes' : IDL.Vec(IDL.Vec(IDL.Nat8)),
    'operation' : IDL.Vec(IDL.Nat8),
    'manifest' : IDL.Vec(IDL.Nat8),
    'plain_size' : IDL.Nat64,
    'expected_revision' : IDL.Nat64,
  });
  const Upload = IDL.Record({
    'id' : IDL.Vec(IDL.Nat8),
    'expires' : IDL.Nat64,
    'revision' : IDL.Nat64,
  });
  const Result_4 = IDL.Variant({ 'Ok' : Upload, 'Err' : Error });
  const Purpose = IDL.Variant({
    'Unlock' : IDL.Null,
    'Activate' : IDL.Null,
    'AddCredential' : IDL.Null,
    'RemoveCredential' : IDL.Null,
  });
  const BeginUnlock = IDL.Record({
    'attempt' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'vault' : IDL.Vec(IDL.Nat8),
    'transport' : IDL.Vec(IDL.Nat8),
    'epoch' : IDL.Nat64,
    'target' : IDL.Vec(IDL.Nat8),
    'purpose' : Purpose,
  });
  const Challenge = IDL.Record({
    'expires' : IDL.Nat64,
    'registration' : IDL.Bool,
    'credential_ids' : IDL.Vec(IDL.Vec(IDL.Nat8)),
    'bytes' : IDL.Vec(IDL.Nat8),
  });
  const Result_5 = IDL.Variant({ 'Ok' : Challenge, 'Err' : Error });
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
  const Result_6 = IDL.Variant({ 'Ok' : Payment, 'Err' : Error });
  const RestoreProgress = IDL.Record({
    'count' : IDL.Nat64,
    'root' : IDL.Vec(IDL.Nat8),
    'sequence' : IDL.Nat64,
  });
  const Result_7 = IDL.Variant({ 'Ok' : RestoreProgress, 'Err' : Error });
  const Result_8 = IDL.Variant({ 'Ok' : Revision, 'Err' : Error });
  const Derive = IDL.Record({
    'attempt' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'vault' : IDL.Vec(IDL.Nat8),
    'transport' : IDL.Vec(IDL.Nat8),
    'epoch' : IDL.Nat64,
    'assertion' : IDL.Opt(IDL.Text),
  });
  const KeyReply = IDL.Record({
    'encrypted_key' : IDL.Vec(IDL.Nat8),
    'public_key' : IDL.Vec(IDL.Nat8),
  });
  const Result_9 = IDL.Variant({ 'Ok' : KeyReply, 'Err' : Error });
  const ExportPage = IDL.Record({
    'next' : IDL.Opt(IDL.Nat64),
    'entries' : IDL.Vec(Revision),
  });
  const Result_10 = IDL.Variant({ 'Ok' : ExportPage, 'Err' : Error });
  const Result_11 = IDL.Variant({ 'Ok' : IDL.Opt(Export), 'Err' : Error });
  const Result_12 = IDL.Variant({ 'Ok' : IDL.Vec(IDL.Nat8), 'Err' : Error });
  const VaultConfig = IDL.Record({
    'minimum_cycles' : IDL.Nat64,
    'origin' : IDL.Text,
    'key_name' : IDL.Text,
    'rp_id' : IDL.Text,
  });
  const Result_13 = IDL.Variant({ 'Ok' : IDL.Opt(VaultConfig), 'Err' : Error });
  const Quota = IDL.Record({
    'reserved' : IDL.Nat64,
    'limit' : IDL.Nat64,
    'current' : IDL.Nat64,
    'charged' : IDL.Nat64,
  });
  const Result_14 = IDL.Variant({ 'Ok' : Quota, 'Err' : Error });
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
  const CredentialInfo = IDL.Record({ 'id' : IDL.Vec(IDL.Nat8) });
  const Result_15 = IDL.Variant({
    'Ok' : IDL.Vec(CredentialInfo),
    'Err' : Error,
  });
  const ObjectPage = IDL.Record({
    'next' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'entries' : IDL.Vec(Revision),
  });
  const Result_16 = IDL.Variant({ 'Ok' : ObjectPage, 'Err' : Error });
  const Result_17 = IDL.Variant({ 'Ok' : IDL.Vec(Payment), 'Err' : Error });
  const UnfinishedVault = IDL.Record({
    'expires' : IDL.Nat64,
    'cleaning' : IDL.Bool,
    'attempt' : IDL.Vec(IDL.Nat8),
    'vault' : IDL.Vec(IDL.Nat8),
    'state' : VaultState,
  });
  const Result_18 = IDL.Variant({
    'Ok' : IDL.Vec(UnfinishedVault),
    'Err' : Error,
  });
  const Result_19 = IDL.Variant({ 'Ok' : IDL.Vec(Header), 'Err' : Error });
  const ManageCredential = IDL.Record({
    'remove' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'vault' : IDL.Vec(IDL.Nat8),
    'registration' : IDL.Opt(IDL.Text),
    'assertion' : IDL.Text,
  });
  const Result_20 = IDL.Variant({ 'Ok' : IDL.Opt(Payment), 'Err' : Error });
  const Reserve = IDL.Record({
    'vault' : IDL.Vec(IDL.Nat8),
    'operation' : IDL.Vec(IDL.Nat8),
  });
  return IDL.Service({
    'abort_export' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result], []),
    'account_balance' : IDL.Func([], [Result_1], ['query']),
    'activate_vault' : IDL.Func([Activate], [Result], []),
    'begin_export' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_2],
        [],
      ),
    'begin_restore' : IDL.Func([BeginRestore], [Result], []),
    'begin_restore_revision' : IDL.Func(
        [IDL.Vec(IDL.Nat8), Revision, IDL.Opt(IDL.Vec(IDL.Nat8))],
        [Result_3],
        [],
      ),
    'begin_revision' : IDL.Func([BeginRevision], [Result_4], []),
    'begin_unlock' : IDL.Func([BeginUnlock], [Result_5], []),
    'cancel_pending_key_derivation' : IDL.Func([], [Result_3], []),
    'cancel_quote' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_6], []),
    'cancel_vault_setup' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_3],
        [],
      ),
    'collect_garbage' : IDL.Func([], [Result_1], []),
    'commit_restore' : IDL.Func([Activate], [Result], []),
    'commit_restore_revision' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Opt(IDL.Vec(IDL.Nat8))],
        [Result_7],
        [],
      ),
    'commit_revision' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_8], []),
    'delete_object' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Vec(IDL.Nat8)],
        [Result_8],
        [],
      ),
    'derive_vault_key' : IDL.Func([Derive], [Result_9], []),
    'export_index' : IDL.Func([IDL.Vec(IDL.Nat8), IDL.Nat64], [Result_10], []),
    'finish_export' : IDL.Func([IDL.Vec(IDL.Nat8), IDL.Bool], [Result], []),
    'get_active_export' : IDL.Func([], [Result_11], []),
    'get_active_export_for_vault' : IDL.Func(
        [IDL.Vec(IDL.Nat8)],
        [Result_11],
        [],
      ),
    'get_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Nat32],
        [Result_12],
        [],
      ),
    'get_config' : IDL.Func([], [Result_13], []),
    'get_export_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Nat32],
        [Result_12],
        [],
      ),
    'get_manifest' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_8],
        [],
      ),
    'get_quota' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_14], []),
    'get_vault_header' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result], []),
    'http_request' : IDL.Func([HttpRequest], [HttpResponse], ['query']),
    'list_credentials' : IDL.Func([], [Result_15], []),
    'list_history' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_10],
        [],
      ),
    'list_objects' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_16],
        [],
      ),
    'list_payments' : IDL.Func([], [Result_17], ['query']),
    'list_unfinished_vaults' : IDL.Func([], [Result_18], []),
    'list_vaults' : IDL.Func([], [Result_19], []),
    'manage_unlock_credential' : IDL.Func([ManageCredential], [Result_3], []),
    'pay_purchase' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_6], []),
    'payment_status' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_20], ['query']),
    'prepare_unlock_credential' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Text],
        [Result_12],
        [],
      ),
    'purge_object' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_3],
        [],
      ),
    'put_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Nat32, IDL.Vec(IDL.Nat8)],
        [Result_3],
        [],
      ),
    'put_restore_chunk' : IDL.Func(
        [
          IDL.Vec(IDL.Nat8),
          IDL.Nat32,
          IDL.Vec(IDL.Nat8),
          IDL.Opt(IDL.Vec(IDL.Nat8)),
        ],
        [Result_3],
        [],
      ),
    'quote_purchase' : IDL.Func([PurchaseRequest], [Result_6], []),
    'reserve_vault' : IDL.Func([Reserve], [Result], []),
    'set_config' : IDL.Func([IDL.Opt(VaultConfig)], [Result_3], []),
    'set_funding_config' : IDL.Func([IDL.Opt(FundingConfig)], [Result_3], []),
  });
};
export const init = ({ IDL }) => { return []; };
