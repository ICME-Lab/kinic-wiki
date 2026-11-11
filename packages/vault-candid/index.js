export const idlFactory = ({ IDL }) => {
  const Envelope = IDL.Record({
    'ciphertext' : IDL.Vec(IDL.Nat8),
    'version' : IDL.Nat8,
    'nonce' : IDL.Vec(IDL.Nat8),
  });
  const Generation = IDL.Record({
    'vault' : IDL.Vec(IDL.Nat8),
    'owner' : IDL.Principal,
    'epoch' : IDL.Nat64,
    'version' : IDL.Nat8,
    'canister' : IDL.Principal,
    'nonce' : IDL.Vec(IDL.Nat8),
    'key_name' : IDL.Text,
  });
  const VaultState = IDL.Variant({
    'Active' : IDL.Null,
    'Restoring' : IDL.Null,
    'Purging' : IDL.Null,
    'Pending' : IDL.Null,
    'IncidentRequired' : IDL.Null,
  });
  const Header = IDL.Record({
    'id' : IDL.Vec(IDL.Nat8),
    'normal' : IDL.Opt(Envelope),
    'generation' : IDL.Opt(Generation),
    'epoch' : IDL.Nat64,
    'backup_sequence' : IDL.Opt(IDL.Nat64),
    'state' : VaultState,
    'recovery_verifier' : IDL.Vec(IDL.Nat8),
    'key_name' : IDL.Text,
    'recovery' : IDL.Opt(Envelope),
    'published_slot' : IDL.Opt(IDL.Nat8),
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
    'RateLimited' : IDL.Record({ 'retry_after' : IDL.Nat64 }),
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
  const PendingCreation = IDL.Record({
    'attempt' : IDL.Vec(IDL.Nat8),
    'vault' : IDL.Vec(IDL.Nat8),
    'namespace' : IDL.Vec(IDL.Nat8),
  });
  const CredentialRevocation = IDL.Record({
    'credential' : IDL.Vec(IDL.Nat8),
    'version' : IDL.Nat64,
  });
  const IncidentPreparation = IDL.Record({
    'job' : IDL.Vec(IDL.Nat8),
    'targets' : IDL.Vec(PendingCreation),
    'sources' : IDL.Vec(Generation),
    'namespace' : IDL.Vec(IDL.Nat8),
    'compromised' : IDL.Vec(CredentialRevocation),
  });
  const GrantPurpose = IDL.Variant({
    'RestoreCleanup' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'target' : PendingCreation,
    }),
    'Restore' : IDL.Record({ 'job' : IDL.Vec(IDL.Nat8) }),
    'CancelCreation' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'target' : PendingCreation,
    }),
    'Credentials' : IDL.Null,
    'RestoreTarget' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'generation' : Generation,
    }),
    'Normal' : IDL.Null,
    'Cleanup' : IDL.Record({ 'job' : IDL.Vec(IDL.Nat8) }),
    'Incident' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'vector_digest' : IDL.Vec(IDL.Nat8),
    }),
    'CreateEmpty' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'target' : PendingCreation,
      'authorizer_instance' : Generation,
    }),
    'IncidentCutover' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'digest' : IDL.Vec(IDL.Nat8),
    }),
    'Create' : IDL.Null,
    'RestorePrepare' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'target' : PendingCreation,
    }),
    'IncidentPrepare' : IncidentPreparation,
  });
  const GrantRequest = IDL.Record({
    'credential' : IDL.Vec(IDL.Nat8),
    'public_key' : IDL.Vec(IDL.Nat8),
    'generations' : IDL.Vec(Generation),
    'operation' : IDL.Vec(IDL.Nat8),
    'purpose' : GrantPurpose,
  });
  const Challenge = IDL.Record({
    'expires' : IDL.Nat64,
    'registration' : IDL.Bool,
    'credential_ids' : IDL.Vec(IDL.Vec(IDL.Nat8)),
    'bytes' : IDL.Vec(IDL.Nat8),
  });
  const Result_2 = IDL.Variant({ 'Ok' : Challenge, 'Err' : Error });
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
  const Result_3 = IDL.Variant({ 'Ok' : Export, 'Err' : Error });
  const BeginRestore = IDL.Record({
    'count' : IDL.Nat64,
    'root' : IDL.Vec(IDL.Nat8),
    'operation' : IDL.Vec(IDL.Nat8),
    'reserved_bytes' : IDL.Nat64,
    'header' : Header,
  });
  const RestoreCandidateMode = IDL.Variant({
    'New' : IDL.Null,
    'ExistingInstances' : IDL.Vec(IDL.Nat8),
  });
  const RestoreAdmissionRequest = IDL.Record({
    'job' : IDL.Vec(IDL.Nat8),
    'source_generation' : IDL.Opt(Generation),
    'source_epoch' : IDL.Nat64,
    'records' : IDL.Nat64,
    'archive_length' : IDL.Nat64,
    'archive_digest' : IDL.Vec(IDL.Nat8),
    'candidate_mode' : IDL.Opt(RestoreCandidateMode),
    'target' : PendingCreation,
    'source_commitment' : IDL.Vec(IDL.Nat8),
    'reserved_bytes' : IDL.Nat64,
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
  const Result_4 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : Error });
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
  const Result_5 = IDL.Variant({ 'Ok' : Upload, 'Err' : Error });
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
  const Reserve = IDL.Record({
    'vault' : IDL.Vec(IDL.Nat8),
    'operation' : IDL.Vec(IDL.Nat8),
  });
  const Bootstrap = IDL.Record({
    'public_key' : IDL.Vec(IDL.Nat8),
    'reserve' : Reserve,
  });
  const BootstrapReply = IDL.Record({
    'challenge' : Challenge,
    'header' : Header,
  });
  const Result_6 = IDL.Variant({ 'Ok' : BootstrapReply, 'Err' : Error });
  const CleanupProgress = IDL.Record({
    'job' : IDL.Vec(IDL.Nat8),
    'cursor' : IDL.Nat64,
    'complete' : IDL.Bool,
  });
  const Result_7 = IDL.Variant({ 'Ok' : CleanupProgress, 'Err' : Error });
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
  const Result_8 = IDL.Variant({ 'Ok' : Payment, 'Err' : Error });
  const Result_9 = IDL.Variant({
    'Ok' : IDL.Opt(CleanupProgress),
    'Err' : Error,
  });
  const RestoreProgress = IDL.Record({
    'count' : IDL.Nat64,
    'root' : IDL.Vec(IDL.Nat8),
    'sequence' : IDL.Nat64,
  });
  const Result_10 = IDL.Variant({ 'Ok' : RestoreProgress, 'Err' : Error });
  const Result_11 = IDL.Variant({ 'Ok' : Revision, 'Err' : Error });
  const RestoreExistingCandidate = IDL.Record({
    'credential' : IDL.Vec(IDL.Nat8),
    'version' : IDL.Nat64,
    'scope_digest' : IDL.Vec(IDL.Nat8),
  });
  const CreateEmptyPhase = IDL.Variant({
    'Admitted' : IDL.Null,
    'Active' : IDL.Null,
    'EnvelopesStaged' : IDL.Null,
    'KitConfirmed' : IDL.Null,
    'Cancelling' : IDL.Null,
    'Cancelled' : IDL.Null,
    'Allocated' : IDL.Null,
  });
  const CreateEmptyStatus = IDL.Record({
    'job' : IDL.Vec(IDL.Nat8),
    'creator' : RestoreExistingCandidate,
    'normal' : IDL.Opt(Envelope),
    'cleanup_cursor' : IDL.Nat64,
    'envelope_digest' : IDL.Vec(IDL.Nat8),
    'generation' : IDL.Opt(Generation),
    'allocation_token' : IDL.Opt(IDL.Nat64),
    'kit_ack' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'target' : PendingCreation,
    'recovery_verifier' : IDL.Vec(IDL.Nat8),
    'recovery' : IDL.Opt(Envelope),
    'phase' : CreateEmptyPhase,
    'key_digest' : IDL.Vec(IDL.Nat8),
    'authorizer_instance' : Generation,
  });
  const Result_12 = IDL.Variant({
    'Ok' : IDL.Opt(CreateEmptyStatus),
    'Err' : Error,
  });
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
  const Result_13 = IDL.Variant({ 'Ok' : KeyReply, 'Err' : Error });
  const ExportPage = IDL.Record({
    'next' : IDL.Opt(IDL.Nat64),
    'entries' : IDL.Vec(Revision),
  });
  const Result_14 = IDL.Variant({ 'Ok' : ExportPage, 'Err' : Error });
  const GrantInfo = IDL.Record({
    'id' : IDL.Vec(IDL.Nat8),
    'expires' : IDL.Nat64,
    'next_counter' : IDL.Nat64,
    'generations' : IDL.Vec(Generation),
    'purpose' : GrantPurpose,
  });
  const Result_15 = IDL.Variant({ 'Ok' : GrantInfo, 'Err' : Error });
  const Result_16 = IDL.Variant({ 'Ok' : IDL.Opt(Export), 'Err' : Error });
  const Result_17 = IDL.Variant({ 'Ok' : IDL.Vec(IDL.Nat8), 'Err' : Error });
  const VaultConfig = IDL.Record({
    'minimum_cycles' : IDL.Nat64,
    'origin' : IDL.Text,
    'key_name' : IDL.Text,
    'rp_id' : IDL.Text,
  });
  const Result_18 = IDL.Variant({ 'Ok' : IDL.Opt(VaultConfig), 'Err' : Error });
  const Quota = IDL.Record({
    'reserved' : IDL.Nat64,
    'limit' : IDL.Nat64,
    'current' : IDL.Nat64,
    'charged' : IDL.Nat64,
  });
  const Result_19 = IDL.Variant({ 'Ok' : Quota, 'Err' : Error });
  const GlobalCapacity = IDL.Record({
    'used' : IDL.Nat64,
    'overcommitted' : IDL.Bool,
    'limit' : IDL.Nat64,
    'overage' : IDL.Nat64,
    'accounting_reserved' : IDL.Nat64,
    'legacy_excess' : IDL.Nat64,
  });
  const Result_20 = IDL.Variant({ 'Ok' : GlobalCapacity, 'Err' : Error });
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
  const Instance = IDL.Record({
    'vault' : IDL.Vec(IDL.Nat8),
    'nonce' : IDL.Vec(IDL.Nat8),
  });
  const CredentialScope = IDL.Variant({
    'Global' : IDL.Null,
    'Instances' : IDL.Vec(Instance),
  });
  const IncidentCredential = IDL.Record({
    'credential' : IDL.Vec(IDL.Nat8),
    'scope' : CredentialScope,
    'version' : IDL.Nat64,
  });
  const IncidentContext = IDL.Record({
    'credentials' : IDL.Vec(IncidentCredential),
    'namespace' : IDL.Vec(IDL.Nat8),
  });
  const Result_21 = IDL.Variant({
    'Ok' : IDL.Opt(IncidentContext),
    'Err' : Error,
  });
  const IncidentRead = IDL.Record({
    'job' : IDL.Vec(IDL.Nat8),
    'attempt' : IDL.Vec(IDL.Nat8),
    'vault' : IDL.Vec(IDL.Nat8),
    'descriptor_digest' : IDL.Vec(IDL.Nat8),
    'export' : IDL.Vec(IDL.Nat8),
  });
  const StagedExport = IDL.Record({
    'descriptor_digest' : IDL.Vec(IDL.Nat8),
    'export' : Export,
    'commitment' : IDL.Vec(IDL.Nat8),
  });
  const Result_22 = IDL.Variant({ 'Ok' : StagedExport, 'Err' : Error });
  const IncidentBackupAck = IDL.Record({
    'archive_length' : IDL.Nat64,
    'archive_hash' : IDL.Vec(IDL.Nat8),
    'descriptor_digest' : IDL.Vec(IDL.Nat8),
    'recovery_verifier' : IDL.Vec(IDL.Nat8),
    'sequence' : IDL.Nat64,
    'commitment' : IDL.Vec(IDL.Nat8),
  });
  const RestoreChildLink = IDL.Record({
    'job' : IDL.Vec(IDL.Nat8),
    'attempt' : IDL.Vec(IDL.Nat8),
    'archive_digest' : IDL.Vec(IDL.Nat8),
    'target' : Generation,
  });
  const PreparationPhase = IDL.Variant({
    'BackupVerified' : IDL.Null,
    'PendingNonce' : IDL.Null,
    'Resetting' : IDL.Null,
    'EnvelopesStaged' : IDL.Null,
    'Wrapping' : IDL.Null,
    'Purged' : IDL.Null,
    'KitConfirmed' : IDL.Null,
    'Purging' : IDL.Null,
    'Cancelling' : IDL.Null,
    'Cancelled' : IDL.Null,
    'Allocated' : IDL.Null,
  });
  const IncidentCoverage = IDL.Record({
    'records' : IDL.Nat64,
    'cursor' : IDL.Nat64,
    'last_batch' : IDL.Vec(IDL.Nat8),
    'plain_bytes' : IDL.Nat64,
    'complete' : IDL.Bool,
    'source_root' : IDL.Vec(IDL.Nat8),
    'chunks' : IDL.Nat64,
    'target_root' : IDL.Vec(IDL.Nat8),
  });
  const IncidentTarget = IDL.Record({
    'staged_export' : IDL.Opt(StagedExport),
    'normal' : IDL.Opt(Envelope),
    'attempt' : IDL.Vec(IDL.Nat8),
    'source' : Header,
    'envelope_digest' : IDL.Vec(IDL.Nat8),
    'snapshot_sequence' : IDL.Nat64,
    'kit_ack' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'target' : IDL.Opt(Generation),
    'backup_ack' : IDL.Opt(IncidentBackupAck),
    'restore_child' : IDL.Opt(RestoreChildLink),
    'recovery_verifier' : IDL.Vec(IDL.Nat8),
    'recovery' : IDL.Opt(Envelope),
    'reset_attempt' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'phase' : PreparationPhase,
    'coverage' : IDL.Opt(IncidentCoverage),
    'next_epoch' : IDL.Nat64,
    'snapshot_time' : IDL.Nat64,
  });
  const IncidentStatus = IDL.Record({
    'job' : IDL.Vec(IDL.Nat8),
    'cancel_digest' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'vector_digest' : IDL.Vec(IDL.Nat8),
    'completed_digest' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'complete' : IDL.Bool,
    'targets' : IDL.Vec(IncidentTarget),
    'semantic_config' : IDL.Vec(IDL.Nat8),
    'namespace' : IDL.Vec(IDL.Nat8),
    'compromised' : IDL.Vec(CredentialRevocation),
  });
  const Result_23 = IDL.Variant({
    'Ok' : IDL.Opt(IncidentStatus),
    'Err' : Error,
  });
  const CredentialInfo = IDL.Record({ 'id' : IDL.Vec(IDL.Nat8) });
  const Result_24 = IDL.Variant({
    'Ok' : IDL.Vec(CredentialInfo),
    'Err' : Error,
  });
  const ObjectPage = IDL.Record({
    'next' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'entries' : IDL.Vec(Revision),
  });
  const Result_25 = IDL.Variant({ 'Ok' : ObjectPage, 'Err' : Error });
  const Result_26 = IDL.Variant({ 'Ok' : IDL.Vec(Payment), 'Err' : Error });
  const UnfinishedVault = IDL.Record({
    'expires' : IDL.Nat64,
    'cleaning' : IDL.Bool,
    'attempt' : IDL.Vec(IDL.Nat8),
    'vault' : IDL.Vec(IDL.Nat8),
    'state' : VaultState,
    'namespace' : IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const Result_27 = IDL.Variant({
    'Ok' : IDL.Vec(UnfinishedVault),
    'Err' : Error,
  });
  const Result_28 = IDL.Variant({ 'Ok' : IDL.Vec(Header), 'Err' : Error });
  const ManageCredential = IDL.Record({
    'remove' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'vault' : IDL.Vec(IDL.Nat8),
    'registration' : IDL.Opt(IDL.Text),
    'assertion' : IDL.Text,
  });
  const MutationResult = IDL.Variant({
    'Key' : KeyReply,
    'Header' : Header,
    'Unit' : IDL.Null,
    'Cleanup' : CleanupProgress,
    'InactiveCleanup' : IDL.Record({ 'complete' : IDL.Bool }),
    'Revision' : Revision,
    'Upload' : Upload,
    'Challenge' : Challenge,
    'Handle' : IDL.Vec(IDL.Nat8),
  });
  const Result_29 = IDL.Variant({ 'Ok' : MutationResult, 'Err' : Error });
  const Result_30 = IDL.Variant({ 'Ok' : IDL.Opt(Payment), 'Err' : Error });
  const RestorePreflight = IDL.Record({
    'records' : IDL.Nat64,
    'peak_pending_bytes' : IDL.Nat64,
    'source_saved' : IDL.Bool,
    'current_plain_bytes' : IDL.Nat64,
    'archive_length' : IDL.Nat64,
    'archive_digest' : IDL.Vec(IDL.Nat8),
    'plain_bytes' : IDL.Nat64,
    'objects' : IDL.Nat64,
    'source_fully_verified' : IDL.Bool,
    'target_commitment' : IDL.Vec(IDL.Nat8),
    'source_commitment' : IDL.Vec(IDL.Nat8),
    'revision_bytes' : IDL.Nat64,
    'chunks' : IDL.Nat64,
    'sequence' : IDL.Nat64,
  });
  const RestorePhase = IDL.Variant({
    'BackupVerified' : IDL.Null,
    'Importing' : IDL.Null,
    'Discarding' : IDL.Null,
    'Active' : IDL.Null,
    'EnvelopesStaged' : IDL.Null,
    'KitConfirmed' : IDL.Null,
    'Cancelling' : IDL.Null,
    'Cancelled' : IDL.Null,
    'Allocated' : IDL.Null,
  });
  const RestorePipeline = IDL.Record({
    'discard_started' : IDL.Bool,
    'normal' : IDL.Opt(Envelope),
    'cleanup_cursor' : IDL.Nat64,
    'envelope_digest' : IDL.Vec(IDL.Nat8),
    'kit_ack' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'preflight' : IDL.Opt(RestorePreflight),
    'target' : Generation,
    'backup_ack' : IDL.Opt(IncidentBackupAck),
    'old_removed' : IDL.Bool,
    'recovery_verifier' : IDL.Vec(IDL.Nat8),
    'recovery' : IDL.Opt(Envelope),
    'phase' : RestorePhase,
  });
  const RestoreAdmissionPhase = IDL.Variant({
    'Registration' : IDL.Null,
    'Admitted' : IDL.Null,
    'Possession' : IDL.Null,
    'CurrentProof' : IDL.Null,
  });
  const RestoreAdmissionStatus = IDL.Record({
    'challenge' : Challenge,
    'request' : RestoreAdmissionRequest,
    'pipeline' : IDL.Opt(RestorePipeline),
    'recovery_message' : IDL.Vec(IDL.Nat8),
    'allocation_token' : IDL.Opt(IDL.Nat64),
    'existing_candidate' : IDL.Opt(RestoreExistingCandidate),
    'issued' : IDL.Nat64,
    'cancel_complete' : IDL.Bool,
    'current_verifier' : IDL.Vec(IDL.Nat8),
    'current_live' : IDL.Opt(Generation),
    'semantic_config' : IDL.Vec(IDL.Nat8),
    'phase' : RestoreAdmissionPhase,
    'candidate' : IDL.Opt(IDL.Text),
    'proof_fence' : IDL.Vec(IDL.Nat8),
    'candidate_digest' : IDL.Vec(IDL.Nat8),
    'cancel_requested' : IDL.Bool,
    'next_epoch' : IDL.Nat64,
    'parent_job' : IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const Result_31 = IDL.Variant({
    'Ok' : RestoreAdmissionStatus,
    'Err' : Error,
  });
  const Result_32 = IDL.Variant({
    'Ok' : IDL.Opt(RestoreAdmissionStatus),
    'Err' : Error,
  });
  return IDL.Service({
    'abort_export' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result], []),
    'account_balance' : IDL.Func([], [Result_1], ['query']),
    'activate_vault' : IDL.Func([Activate], [Result], []),
    'begin_cleanup' : IDL.Func([GrantRequest], [Result_2], []),
    'begin_export' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_3],
        [],
      ),
    'begin_grant' : IDL.Func([GrantRequest], [Result_2], []),
    'begin_restore' : IDL.Func([BeginRestore], [Result], []),
    'begin_restore_admission' : IDL.Func(
        [RestoreAdmissionRequest],
        [Result_2],
        [],
      ),
    'begin_restore_grant' : IDL.Func([GrantRequest], [Result_2], []),
    'begin_restore_revision' : IDL.Func(
        [IDL.Vec(IDL.Nat8), Revision, IDL.Opt(IDL.Vec(IDL.Nat8))],
        [Result_4],
        [],
      ),
    'begin_revision' : IDL.Func([BeginRevision], [Result_5], []),
    'begin_unlock' : IDL.Func([BeginUnlock], [Result_2], []),
    'bootstrap' : IDL.Func([Bootstrap], [Result_6], []),
    'cancel_create_empty' : IDL.Func(
        [IDL.Vec(IDL.Nat8), PendingCreation, IDL.Opt(Generation), IDL.Nat64],
        [Result_7],
        [],
      ),
    'cancel_pending_key_derivation' : IDL.Func([], [Result_4], []),
    'cancel_quote' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_8], []),
    'cancel_vault_setup' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_4],
        [],
      ),
    'cleanup_status' : IDL.Func([], [Result_9], []),
    'collect_garbage' : IDL.Func([], [Result_1], []),
    'commit_restore' : IDL.Func([Activate], [Result], []),
    'commit_restore_revision' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Opt(IDL.Vec(IDL.Nat8))],
        [Result_10],
        [],
      ),
    'commit_revision' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_11], []),
    'create_empty_status' : IDL.Func([], [Result_12], ['query']),
    'delete_object' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Vec(IDL.Nat8)],
        [Result_11],
        [],
      ),
    'derive_vault_key' : IDL.Func([Derive], [Result_13], []),
    'export_index' : IDL.Func([IDL.Vec(IDL.Nat8), IDL.Nat64], [Result_14], []),
    'finish_cleanup' : IDL.Func([IDL.Vec(IDL.Nat8), IDL.Text], [Result_15], []),
    'finish_export' : IDL.Func([IDL.Vec(IDL.Nat8), IDL.Bool], [Result], []),
    'finish_grant' : IDL.Func([IDL.Vec(IDL.Nat8), IDL.Text], [Result_15], []),
    'finish_restore_grant' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Text, IDL.Bool],
        [Result_15],
        [],
      ),
    'get_active_export' : IDL.Func([], [Result_16], []),
    'get_active_export_for_vault' : IDL.Func(
        [IDL.Vec(IDL.Nat8)],
        [Result_16],
        [],
      ),
    'get_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Nat32],
        [Result_17],
        [],
      ),
    'get_config' : IDL.Func([], [Result_18], []),
    'get_export_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Nat32],
        [Result_17],
        [],
      ),
    'get_manifest' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_11],
        [],
      ),
    'get_quota' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_19], []),
    'get_vault_header' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result], []),
    'global_capacity' : IDL.Func([], [Result_20], ['query']),
    'http_request' : IDL.Func([HttpRequest], [HttpResponse], ['query']),
    'incident_context' : IDL.Func([], [Result_21], ['query']),
    'incident_cutover_digest' : IDL.Func([], [Result_17], ['query']),
    'incident_source_index' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_14],
        ['query'],
      ),
    'incident_staged_chunk' : IDL.Func(
        [IncidentRead, IDL.Vec(IDL.Nat8), IDL.Nat64, IDL.Nat32],
        [Result_17],
        ['query'],
      ),
    'incident_staged_export' : IDL.Func([IncidentRead], [Result_22], ['query']),
    'incident_staged_index' : IDL.Func(
        [IncidentRead, IDL.Nat64],
        [Result_14],
        ['query'],
      ),
    'incident_status' : IDL.Func([], [Result_23], ['query']),
    'initialize_restore_namespace' : IDL.Func(
        [IDL.Vec(IDL.Nat8)],
        [Result_17],
        [],
      ),
    'list_credentials' : IDL.Func([], [Result_24], []),
    'list_history' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8), IDL.Nat64],
        [Result_14],
        [],
      ),
    'list_objects' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_25],
        [],
      ),
    'list_payments' : IDL.Func([], [Result_26], ['query']),
    'list_unfinished_vaults' : IDL.Func([], [Result_27], []),
    'list_vaults' : IDL.Func([], [Result_28], []),
    'manage_unlock_credential' : IDL.Func([ManageCredential], [Result_4], []),
    'mutate' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_29],
        [],
      ),
    'pay_purchase' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_8], []),
    'payment_status' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_30], ['query']),
    'prepare_unlock_credential' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Text],
        [Result_17],
        [],
      ),
    'prove_restore_candidate' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Text],
        [Result_31],
        [],
      ),
    'prove_restore_current' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_31],
        [],
      ),
    'purge_object' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [Result_4],
        [],
      ),
    'put_chunk' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Nat32, IDL.Vec(IDL.Nat8)],
        [Result_4],
        [],
      ),
    'put_restore_chunk' : IDL.Func(
        [
          IDL.Vec(IDL.Nat8),
          IDL.Nat32,
          IDL.Vec(IDL.Nat8),
          IDL.Opt(IDL.Vec(IDL.Nat8)),
        ],
        [Result_4],
        [],
      ),
    'quote_purchase' : IDL.Func([PurchaseRequest], [Result_8], []),
    'register_bootstrap' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Text],
        [Result_15],
        [],
      ),
    'register_restore_candidate' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Text],
        [Result_2],
        [],
      ),
    'reserve_vault' : IDL.Func([Reserve], [Result], []),
    'restore_admission_status' : IDL.Func([], [Result_32], ['query']),
    'restore_target_chunk' : IDL.Func(
        [
          IDL.Vec(IDL.Nat8),
          Generation,
          IDL.Vec(IDL.Nat8),
          IDL.Nat64,
          IDL.Nat32,
        ],
        [Result_17],
        ['query'],
      ),
    'restore_target_descriptor' : IDL.Func(
        [IDL.Vec(IDL.Nat8), Generation],
        [Result_22],
        ['query'],
      ),
    'restore_target_index' : IDL.Func(
        [IDL.Vec(IDL.Nat8), Generation, IDL.Nat64],
        [Result_14],
        ['query'],
      ),
    'restore_target_progress' : IDL.Func(
        [IDL.Vec(IDL.Nat8), Generation],
        [Result_10],
        ['query'],
      ),
    'resume_restore_admission' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_2], []),
    'set_config' : IDL.Func([IDL.Opt(VaultConfig)], [Result_4], []),
    'set_funding_config' : IDL.Func([IDL.Opt(FundingConfig)], [Result_4], []),
  });
};
export const init = ({ IDL }) => { return []; };
