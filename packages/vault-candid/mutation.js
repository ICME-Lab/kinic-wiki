export const idlFactory = ({ IDL }) => {
  const Envelope = IDL.Record({
    'ciphertext' : IDL.Vec(IDL.Nat8),
    'version' : IDL.Nat8,
    'nonce' : IDL.Vec(IDL.Nat8),
  });
  const IncidentRole = IDL.Variant({
    'Source' : IDL.Null,
    'Target' : IDL.Null,
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
  const IncidentDerive = IDL.Record({
    'job' : IDL.Vec(IDL.Nat8),
    'attempt' : IDL.Vec(IDL.Nat8),
    'role' : IncidentRole,
    'transport' : IDL.Vec(IDL.Nat8),
    'generation' : Generation,
  });
  const Instance = IDL.Record({
    'vault' : IDL.Vec(IDL.Nat8),
    'nonce' : IDL.Vec(IDL.Nat8),
  });
  const CredentialScope = IDL.Variant({
    'Global' : IDL.Null,
    'Instances' : IDL.Vec(Instance),
  });
  const CleanupAction = IDL.Variant({
    'AbortExport' : IDL.Record({ 'export' : IDL.Vec(IDL.Nat8) }),
    'Purge' : IDL.Null,
    'CancelIncident' : IDL.Record({
      'vector_digest' : IDL.Vec(IDL.Nat8),
      'incident' : IDL.Vec(IDL.Nat8),
    }),
    'Expired' : IDL.Null,
    'CancelSetup' : IDL.Record({ 'attempt' : IDL.Vec(IDL.Nat8) }),
  });
  const Derive = IDL.Record({
    'attempt' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'vault' : IDL.Vec(IDL.Nat8),
    'transport' : IDL.Vec(IDL.Nat8),
    'epoch' : IDL.Nat64,
    'assertion' : IDL.Opt(IDL.Text),
  });
  const Reserve = IDL.Record({
    'vault' : IDL.Vec(IDL.Nat8),
    'operation' : IDL.Vec(IDL.Nat8),
  });
  const Activate = IDL.Record({
    'normal' : Envelope,
    'attempt' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'vault' : IDL.Vec(IDL.Nat8),
    'registration' : IDL.Opt(IDL.Text),
    'assertion' : IDL.Opt(IDL.Text),
    'operation' : IDL.Vec(IDL.Nat8),
    'recovery' : Envelope,
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
  const MutationOperation = IDL.Variant({
    'PutChunk' : IDL.Record({
      'vault' : IDL.Vec(IDL.Nat8),
      'data' : IDL.Vec(IDL.Nat8),
      'upload' : IDL.Vec(IDL.Nat8),
      'index' : IDL.Nat32,
    }),
    'IncidentStage' : IDL.Record({
      'normal' : Envelope,
      'attempt' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
      'recovery_verifier' : IDL.Vec(IDL.Nat8),
      'recovery' : Envelope,
    }),
    'IncidentStart' : IDL.Null,
    'IncidentDerive' : IncidentDerive,
    'BeginRegistration' : IDL.Record({
      'vault' : IDL.Vec(IDL.Nat8),
      'scope' : CredentialScope,
    }),
    'CommitRevision' : IDL.Record({
      'vault' : IDL.Vec(IDL.Nat8),
      'upload' : IDL.Vec(IDL.Nat8),
    }),
    'KeyResult' : IDL.Record({ 'handle' : IDL.Vec(IDL.Nat8) }),
    'DeleteObject' : IDL.Record({
      'object' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
      'operation' : IDL.Vec(IDL.Nat8),
      'expected_revision' : IDL.Nat64,
    }),
    'RegisterCredential' : IDL.Record({
      'vault' : IDL.Vec(IDL.Nat8),
      'registration' : IDL.Text,
      'scope' : CredentialScope,
    }),
    'IncidentCancel' : IDL.Null,
    'Cleanup' : IDL.Record({
      'job' : IDL.Vec(IDL.Nat8),
      'action' : CleanupAction,
      'cursor' : IDL.Nat64,
    }),
    'IncidentReset' : IDL.Record({
      'attempt' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
      'next_attempt' : IDL.Vec(IDL.Nat8),
    }),
    'Derive' : Derive,
    'Create' : Reserve,
    'IncidentConfirmKit' : IDL.Record({
      'attempt' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
      'envelope_digest' : IDL.Vec(IDL.Nat8),
    }),
    'Activate' : IDL.Record({
      'request' : Activate,
      'recovery_verifier' : IDL.Vec(IDL.Nat8),
    }),
    'PurgeObject' : IDL.Record({
      'object' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
    }),
    'IncidentAllocate' : IDL.Record({
      'attempt' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
    }),
    'BeginRevision' : BeginRevision,
    'RemoveCredential' : IDL.Record({ 'credential' : IDL.Vec(IDL.Nat8) }),
    'CancelSetup' : IDL.Record({
      'attempt' : IDL.Vec(IDL.Nat8),
      'vault' : IDL.Vec(IDL.Nat8),
    }),
  });
  const Mutation = IDL.Record({
    'counter' : IDL.Nat64,
    'owner' : IDL.Principal,
    'version' : IDL.Nat8,
    'grant' : IDL.Vec(IDL.Nat8),
    'canister' : IDL.Principal,
    'operation' : MutationOperation,
  });
  return IDL.Service({ 'encode' : IDL.Func([Mutation], [], []) });
};
export const init = ({ IDL }) => { return []; };
