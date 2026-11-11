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
    'PutChunk' : {
      'vault' : Uint8Array | number[],
      'data' : Uint8Array | number[],
      'upload' : Uint8Array | number[],
      'index' : number,
    }
  } |
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
  {
    'IncidentReset' : {
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
      'next_attempt' : Uint8Array | number[],
    }
  } |
  {
    'IncidentConfirmBackup' : {
      'ack' : IncidentBackupAck,
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
    }
  } |
  { 'IncidentCutover' : { 'digest' : Uint8Array | number[] } } |
  { 'Derive' : Derive } |
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
  {
    'IncidentAllocate' : {
      'attempt' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
    }
  } |
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
export interface _SERVICE { 'encode' : ActorMethod<[Mutation], undefined> }
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
