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
export const PER_APP_DELEGATION_TTL_NS = 5n * 60n * 1_000_000_000n;

export type IiPermission = "queries" | "all";
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
type Registration = {
  expiration: bigint;
  permissions: { queries: null } | { all: null };
};

export type IiRegistrationErrorCode =
  | "invalid_delegation"
  | "registration_rejected"
  | "temporarily_unavailable";

export type IiRegistrationStage =
  | "delegation_restore"
  | "actor_create"
  | "registration_call"
  | "registration_result";

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

export type IiDelegationStage =
  | "origin_configuration"
  | "accounts_call"
  | "accounts_result"
  | "prepare_call"
  | "prepare_result"
  | "delegation_call"
  | "delegation_result"
  | "delegation_not_ready"
  | "identity_assembly";

export class IiDelegationError extends Error {
  constructor(readonly stage: IiDelegationStage) {
    super("Internet Identity delegation unavailable");
    this.name = "IiDelegationError";
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
): Promise<{ grantExpiresAt: number; permissions: IiPermission }> {
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
  const permissions: IiPermission = "queries" in result.Ok.permissions ? "queries" : "all";
  return {
    grantExpiresAt: nanosecondsToMilliseconds(result.Ok.expiration),
    permissions
  };
}

export async function mintKinicIdentity(
  sessionKey: Ed25519KeyIdentity,
  targetOrigin: string,
  actorOverride?: InternetIdentityActor
): Promise<DelegationIdentity> {
  const actor = actorOverride ?? createIiActor(sessionKey);
  let accounts: Result<AccountInfo[], AccountDelegationError>;
  try {
    accounts = await actor.mcp_get_accounts(targetOrigin);
  } catch {
    throw new IiDelegationError("accounts_call");
  }
  unwrapIiResult(accounts, "accounts_result");

  const appKey = Ed25519KeyIdentity.generate();
  const appPublicKey = new Uint8Array(appKey.getPublicKey().toDer());
  let prepareResult: Result<PreparedDelegation, AccountDelegationError>;
  try {
    prepareResult = await actor.mcp_prepare_delegation(
      targetOrigin,
      [],
      appPublicKey,
      [PER_APP_DELEGATION_TTL_NS]
    );
  } catch {
    throw new IiDelegationError("prepare_call");
  }
  const prepared = unwrapIiResult(prepareResult, "prepare_result");
  const signed = await getPreparedDelegation(actor, targetOrigin, prepared, appPublicKey);
  const permissions = signed.delegation.permissions[0];
  if (permissions !== undefined && permissions !== "queries") {
    throw new IiDelegationError("identity_assembly");
  }
  try {
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
  } catch {
    throw new IiDelegationError("identity_assembly");
  }
}

export function resolveKinicMcpTargetOrigin(value: string | undefined, canisterId: string | undefined): string {
  const configuredOrigin = value?.trim();
  const configuredCanisterId = canisterId?.trim();
  try {
    if (!configuredOrigin || !configuredCanisterId) {
      throw new Error("missing origin configuration");
    }
    if (Principal.fromText(configuredCanisterId).toText() !== configuredCanisterId) {
      throw new Error("non-canonical canister id");
    }
    const parsed = new URL(configuredOrigin);
    const expectedOrigin = `https://${configuredCanisterId}.ic0.app`;
    if (
      configuredOrigin !== expectedOrigin ||
      parsed.origin !== configuredOrigin ||
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid target origin");
    }
    return configuredOrigin;
  } catch {
    throw new IiDelegationError("origin_configuration");
  }
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
  targetOrigin: string,
  prepared: PreparedDelegation,
  appPublicKey: Uint8Array
): Promise<RawSignedDelegation> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let result: Result<RawSignedDelegation, AccountDelegationError>;
    try {
      result = await actor.mcp_get_delegation(
        targetOrigin,
        prepared.account_number,
        appPublicKey,
        prepared.expiration
      );
    } catch {
      throw new IiDelegationError("delegation_call");
    }
    if ("Ok" in result) {
      return result.Ok;
    }
    if ("Unauthorized" in result.Err) {
      throw new IiSessionEndedError();
    }
    if (!("NoSuchDelegation" in result.Err)) {
      throw new IiDelegationError("delegation_result");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new IiDelegationError("delegation_not_ready");
}

function unwrapIiResult<T>(
  result: Result<T, AccountDelegationError>,
  stage: Extract<IiDelegationStage, "accounts_result" | "prepare_result">
): T {
  if ("Ok" in result) {
    return result.Ok;
  }
  if ("Unauthorized" in result.Err) {
    throw new IiSessionEndedError();
  }
  throw new IiDelegationError(stage);
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
