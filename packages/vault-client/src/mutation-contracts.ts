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
export interface BeginRevision {
  'object' : Uint8Array | number[],
  'vault' : Uint8Array | number[],
  'chunk_hashes' : Array<Uint8Array | number[]>,
  'operation' : Uint8Array | number[],
  'manifest' : Uint8Array | number[],
  'plain_size' : bigint,
  'expected_revision' : bigint,
}
export type CleanupAction = {
    'AbortExport' : { 'export' : Uint8Array | number[] }
  } |
  { 'Purge' : null } |
  {
    'CancelIncident' : {
      'vector_digest' : Uint8Array | number[],
      'incident' : Uint8Array | number[],
    }
  } |
  { 'Expired' : null } |
  { 'CancelSetup' : { 'attempt' : Uint8Array | number[] } };
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
export interface Generation {
  'vault' : Uint8Array | number[],
  'owner' : Principal,
  'epoch' : bigint,
  'version' : number,
  'canister' : Principal,
  'nonce' : Uint8Array | number[],
  'key_name' : string,
}
export interface IncidentBackupAck {
  'archive_length' : bigint,
  'archive_hash' : Uint8Array | number[],
  'descriptor_digest' : Uint8Array | number[],
  'recovery_verifier' : Uint8Array | number[],
  'sequence' : bigint,
  'commitment' : Uint8Array | number[],
}
export interface IncidentDerive {
  'job' : Uint8Array | number[],
  'attempt' : Uint8Array | number[],
  'role' : IncidentRole,
  'transport' : Uint8Array | number[],
  'generation' : Generation,
}
export type IncidentRole = { 'Source' : null } |
  { 'Target' : null };
export interface IncidentWrapper {
  'wrapper' : Uint8Array | number[],
  'object' : Uint8Array | number[],
  'source_digest' : Uint8Array | number[],
  'revision' : bigint,
  'sequence' : bigint,
}
export interface Instance {
  'vault' : Uint8Array | number[],
  'nonce' : Uint8Array | number[],
}
export interface Mutation {
  'counter' : bigint,
  'owner' : Principal,
  'version' : number,
  'grant' : Uint8Array | number[],
  'canister' : Principal,
  'operation' : MutationOperation,
}
export type MutationOperation = {
    'RestoreCommitRecord' : { 'sequence' : bigint }
  } |
  {
    'PutChunk' : {
      'vault' : Uint8Array | number[],
      'data' : Uint8Array | number[],
      'upload' : Uint8Array | number[],
      'index' : number,
    }
  } |
  { 'RestoreActivate' : null } |
  {
    'IncidentStage' : {
      'normal' : Envelope,
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'recovery_verifier' : Uint8Array | number[],
      'recovery' : Envelope,
    }
  } |
  { 'IncidentStart' : null } |
  { 'IncidentDerive' : IncidentDerive } |
  {
    'BeginRegistration' : {
      'vault' : Uint8Array | number[],
      'scope' : CredentialScope,
    }
  } |
  {
    'CommitRevision' : {
      'vault' : Uint8Array | number[],
      'upload' : Uint8Array | number[],
    }
  } |
  { 'RestoreDiscard' : { 'cursor' : bigint, 'current' : Generation } } |
  { 'KeyResult' : { 'handle' : Uint8Array | number[] } } |
  {
    'DeleteObject' : {
      'object' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'operation' : Uint8Array | number[],
      'expected_revision' : bigint,
    }
  } |
  {
    'RegisterCredential' : {
      'vault' : Uint8Array | number[],
      'registration' : string,
      'scope' : CredentialScope,
    }
  } |
  { 'RestoreDerive' : IncidentDerive } |
  { 'RestoreChunk' : { 'data' : Uint8Array | number[], 'index' : number } } |
  { 'RestorePreflight' : RestorePreflight } |
  {
    'IncidentPrepareExport' : {
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'export' : Uint8Array | number[],
    }
  } |
  { 'IncidentCancel' : null } |
  {
    'Cleanup' : {
      'job' : Uint8Array | number[],
      'action' : CleanupAction,
      'cursor' : bigint,
    }
  } |
  { 'RestoreBeginImport' : null } |
  {
    'IncidentReset' : {
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'next_attempt' : Uint8Array | number[],
    }
  } |
  { 'RestoreCancel' : { 'cursor' : bigint } } |
  {
    'IncidentConfirmBackup' : {
      'ack' : IncidentBackupAck,
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
    }
  } |
  { 'IncidentCutover' : { 'digest' : Uint8Array | number[] } } |
  { 'Derive' : Derive } |
  {
    'RestoreStage' : {
      'normal' : Envelope,
      'recovery_verifier' : Uint8Array | number[],
      'recovery' : Envelope,
    }
  } |
  { 'Create' : Reserve } |
  {
    'IncidentConfirmKit' : {
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'envelope_digest' : Uint8Array | number[],
    }
  } |
  {
    'Activate' : {
      'request' : Activate,
      'recovery_verifier' : Uint8Array | number[],
    }
  } |
  {
    'IncidentWrap' : {
      'after' : bigint,
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'rows' : Array<IncidentWrapper>,
    }
  } |
  {
    'PurgeObject' : {
      'object' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
    }
  } |
  { 'RestoreAllocate' : null } |
  { 'RestoreRecord' : Revision } |
  { 'RestoreConfirmBackup' : IncidentBackupAck } |
  {
    'IncidentAllocate' : {
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
    }
  } |
  { 'RestoreConfirmKit' : { 'envelope_digest' : Uint8Array | number[] } } |
  { 'ClearInactive' : { 'vault' : Uint8Array | number[] } } |
  { 'BeginRevision' : BeginRevision } |
  { 'RemoveCredential' : { 'credential' : Uint8Array | number[] } } |
  {
    'CancelSetup' : {
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
    }
  };
export interface Reserve {
  'vault' : Uint8Array | number[],
  'operation' : Uint8Array | number[],
}
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
export interface _SERVICE { 'encode' : ActorMethod<[Mutation], undefined> }
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
