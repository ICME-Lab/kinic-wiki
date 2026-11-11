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
    'Cleanup' : {
      'job' : Uint8Array | number[],
      'action' : CleanupAction,
      'cursor' : bigint,
    }
  } |
  { 'Derive' : Derive } |
  { 'Create' : Reserve } |
  {
    'Activate' : {
      'request' : Activate,
      'recovery_verifier' : Uint8Array | number[],
    }
  } |
  {
    'PurgeObject' : {
      'object' : Uint8Array | number[],
      'vault' : Uint8Array | number[],
    }
  } |
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
