import { Actor, HttpAgent, type DerEncodedPublicKey, type Identity, type Signature } from "@icp-sdk/core/agent";
import {
  Delegation,
  DelegationChain,
  DelegationIdentity,
  Ed25519KeyIdentity,
  type JsonnableEd25519KeyIdentity
} from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";

export const INTERNET_IDENTITY_CANISTER_ID = "rdmx6-jaaaa-aaaaa-aaadq-cai";
export const INTERNET_IDENTITY_ORIGIN = "https://id.ai";
export const KINIC_DERIVATION_ORIGIN = "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io";
export const PER_APP_DELEGATION_TTL_NS = 5n * 60n * 1_000_000_000n;

type Variant = Record<string, null>;
type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];
type Result<T, E = string> = { Ok: T } | { Err: E };
type AccountDelegationError = { InternalCanisterError: string } | { Unauthorized: Principal } | { NoSuchDelegation: null };
type AccountInfo = {
  account_number: [] | [bigint];
  origin: string;
  last_used: [] | [bigint];
  name: [] | [string];
};
type PreparedDelegation = {
  user_key: Uint8Array;
  expiration: bigint;
  account_number: [] | [bigint];
};
type RawSignedDelegation = {
  delegation: {
    pubkey: Uint8Array;
    expiration: bigint;
    targets: [] | [Principal[]];
    permissions: [] | [string];
  };
  signature: Uint8Array;
};
type Registration = { expiration: bigint; permissions: Variant };

export type IiRegistrationErrorCode =
  | "invalid_delegation"
  | "registration_rejected"
  | "read_only_required"
  | "temporarily_unavailable";

export type IiRegistrationStage =
  | "delegation_restore"
  | "actor_create"
  | "registration_call"
  | "registration_result"
  | "permission_check";

export type InternetIdentityActor = {
  mcp_register_v2: (sessionKey: Uint8Array) => Promise<Result<Registration>>;
  mcp_get_accounts: (targetOrigin: string) => Promise<Result<AccountInfo[], AccountDelegationError>>;
  mcp_prepare_delegation: (
    targetOrigin: string,
    accountNumber: [] | [bigint],
    sessionKey: Uint8Array,
    maxTtl: [] | [bigint]
  ) => Promise<Result<PreparedDelegation, AccountDelegationError>>;
  mcp_get_delegation: (
    targetOrigin: string,
    accountNumber: [] | [bigint],
    sessionKey: Uint8Array,
    expiration: bigint
  ) => Promise<Result<RawSignedDelegation, AccountDelegationError>>;
};

export class IiSessionEndedError extends Error {
  constructor() {
    super("Internet Identity session ended");
  }
}

export class IiRegistrationError extends Error {
  constructor(
    readonly code: IiRegistrationErrorCode,
    readonly stage: IiRegistrationStage
  ) {
    super(code);
    this.name = "IiRegistrationError";
  }
}

export type IiKeyJson = JsonnableEd25519KeyIdentity;

export function generateIiKey(): Ed25519KeyIdentity {
  return Ed25519KeyIdentity.generate();
}

export function restoreIiKey(value: IiKeyJson): Ed25519KeyIdentity {
  return Ed25519KeyIdentity.fromParsedJson(value);
}

export function restoreRegistrationIdentity(
  registrationKey: Ed25519KeyIdentity,
  delegationJson: string
): DelegationIdentity {
  try {
    return DelegationIdentity.fromDelegation(registrationKey, DelegationChain.fromJSON(delegationJson));
  } catch {
    throw new IiRegistrationError("invalid_delegation", "delegation_restore");
  }
}

export async function redeemRegistration(
  registrationKey: Ed25519KeyIdentity,
  sessionKey: Ed25519KeyIdentity,
  delegationJson: string,
  actorOverride?: InternetIdentityActor
): Promise<{ grantExpiresAt: number; permissions: "queries" }> {
  let actor: InternetIdentityActor;
  if (actorOverride) {
    actor = actorOverride;
  } else {
    const identity = restoreRegistrationIdentity(registrationKey, delegationJson);
    try {
      actor = createIiActor(identity);
    } catch {
      throw new IiRegistrationError("temporarily_unavailable", "actor_create");
    }
  }
  let result: Result<Registration>;
  try {
    result = await actor.mcp_register_v2(new Uint8Array(sessionKey.getPublicKey().toDer()));
  } catch {
    throw new IiRegistrationError("temporarily_unavailable", "registration_call");
  }
  if ("Err" in result) {
    throw new IiRegistrationError("registration_rejected", "registration_result");
  }
  if (!("queries" in result.Ok.permissions)) {
    throw new IiRegistrationError("read_only_required", "permission_check");
  }
  return {
    grantExpiresAt: nanosecondsToMilliseconds(result.Ok.expiration),
    permissions: "queries"
  };
}

export async function mintKinicIdentity(
  sessionKey: Ed25519KeyIdentity,
  actorOverride?: InternetIdentityActor
): Promise<DelegationIdentity> {
  const actor = actorOverride ?? createIiActor(sessionKey);
  const accounts = await actor.mcp_get_accounts(KINIC_DERIVATION_ORIGIN);
  unwrapIiResult(accounts);

  const appKey = Ed25519KeyIdentity.generate();
  const appPublicKey = new Uint8Array(appKey.getPublicKey().toDer());
  const prepared = unwrapIiResult(
    await actor.mcp_prepare_delegation(KINIC_DERIVATION_ORIGIN, [], appPublicKey, [PER_APP_DELEGATION_TTL_NS])
  );
  const signed = await getPreparedDelegation(actor, prepared, appPublicKey);
  const permissions = signed.delegation.permissions[0];
  if (permissions !== "queries") {
    throw new Error("Internet Identity returned a non-read-only delegation");
  }
  const delegation = new Delegation(
    signed.delegation.pubkey,
    signed.delegation.expiration,
    signed.delegation.targets[0],
    permissions
  );
  const chain = DelegationChain.fromDelegations(
    [{ delegation, signature: signed.signature as Signature }],
    prepared.user_key as DerEncodedPublicKey
  );
  return DelegationIdentity.fromDelegation(appKey, chain);
}

function createIiActor(identity: Identity): InternetIdentityActor {
  const agent = HttpAgent.createSync({ host: "https://icp0.io", identity });
  return Actor.createActor<InternetIdentityActor>(iiIdlFactory, {
    agent,
    canisterId: Principal.fromText(INTERNET_IDENTITY_CANISTER_ID)
  });
}

async function getPreparedDelegation(
  actor: InternetIdentityActor,
  prepared: PreparedDelegation,
  appPublicKey: Uint8Array
): Promise<RawSignedDelegation> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await actor.mcp_get_delegation(
      KINIC_DERIVATION_ORIGIN,
      prepared.account_number,
      appPublicKey,
      prepared.expiration
    );
    if ("Ok" in result) {
      return result.Ok;
    }
    if ("Unauthorized" in result.Err) {
      throw new IiSessionEndedError();
    }
    if (!("NoSuchDelegation" in result.Err)) {
      throw new Error("Internet Identity delegation failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Internet Identity delegation was not ready");
}

function unwrapIiResult<T>(result: Result<T, AccountDelegationError>): T {
  if ("Ok" in result) {
    return result.Ok;
  }
  if ("Unauthorized" in result.Err) {
    throw new IiSessionEndedError();
  }
  throw new Error("Internet Identity delegation failed");
}

function nanosecondsToMilliseconds(value: bigint): number {
  const milliseconds = value / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Internet Identity expiration is out of range");
  }
  return Number(milliseconds);
}

const iiIdlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {
  const Permissions = idl.Variant({ queries: idl.Null, all: idl.Null });
  const Delegation = idl.Record({
    pubkey: idl.Vec(idl.Nat8),
    expiration: idl.Nat64,
    targets: idl.Opt(idl.Vec(idl.Principal)),
    permissions: idl.Opt(idl.Text)
  });
  const SignedDelegation = idl.Record({ delegation: Delegation, signature: idl.Vec(idl.Nat8) });
  const AccountInfo = idl.Record({
    account_number: idl.Opt(idl.Nat64),
    origin: idl.Text,
    last_used: idl.Opt(idl.Nat64),
    name: idl.Opt(idl.Text)
  });
  const AccountDelegationError = idl.Variant({
    InternalCanisterError: idl.Text,
    Unauthorized: idl.Principal,
    NoSuchDelegation: idl.Null
  });
  const McpPrepareDelegation = idl.Record({
    user_key: idl.Vec(idl.Nat8),
    expiration: idl.Nat64,
    account_number: idl.Opt(idl.Nat64)
  });
  const McpRegistrationV2 = idl.Record({ expiration: idl.Nat64, permissions: Permissions });
  return idl.Service({
    mcp_register_v2: idl.Func(
      [idl.Vec(idl.Nat8)],
      [idl.Variant({ Ok: McpRegistrationV2, Err: idl.Text })],
      []
    ),
    mcp_get_accounts: idl.Func(
      [idl.Text],
      [idl.Variant({ Ok: idl.Vec(AccountInfo), Err: AccountDelegationError })],
      ["query"]
    ),
    mcp_prepare_delegation: idl.Func(
      [idl.Text, idl.Opt(idl.Nat64), idl.Vec(idl.Nat8), idl.Opt(idl.Nat64)],
      [idl.Variant({ Ok: McpPrepareDelegation, Err: AccountDelegationError })],
      []
    ),
    mcp_get_delegation: idl.Func(
      [idl.Text, idl.Opt(idl.Nat64), idl.Vec(idl.Nat8), idl.Nat64],
      [idl.Variant({ Ok: SignedDelegation, Err: AccountDelegationError })],
      ["query"]
    )
  });
};
