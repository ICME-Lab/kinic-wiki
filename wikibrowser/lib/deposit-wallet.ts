import { IcrcWallet } from "@dfinity/oisy-wallet-signer/icrc-wallet";
import { base64ToUint8Array, uint8ArrayToBase64 } from "@dfinity/utils";
import type { ApproveParams } from "@icp-sdk/canisters/ledger/icrc";
import { Actor, AnonymousIdentity, Cbor, Certificate, HttpAgent, lookupResultToBuffer, requestIdOf } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { getBillingConfig } from "@/lib/vfs-client";
import { idlFactory } from "@/lib/vfs-idl";

type WalletProvider = "oisy" | "plug";

type DepositRequest = {
  canisterId: string;
  databaseId: string;
  amountE8s: bigint;
};

type DepositResult = {
  provider: WalletProvider;
  approveBlockIndex: string;
  approvedAllowanceE8s: string;
  creditedAmountE8s: string;
  transferFeeE8s: string;
  topUpBlockIndex: string | null;
  balanceE8s: string | null;
};

type OisyCallResult = {
  contentMap: string;
  certificate: string;
};

type PlugWallet = {
  requestConnect: (input: { whitelist: string[]; host?: string }) => Promise<boolean>;
  createActor: (input: { canisterId: string; interfaceFactory: unknown }) => Promise<PlugVfsActor | PlugLedgerActor>;
  agent?: { getPrincipal: () => Promise<Principal> };
};

type PlugVfsActor = {
  top_up_database: (databaseId: string, amountE8s: bigint) => Promise<{ Ok: { block_index: bigint; balance_e8s: bigint } } | { Err: string }>;
};

type LedgerActor = {
  icrc1_fee: () => Promise<bigint>;
  icrc2_approve: (request: LedgerApproveArgs) => Promise<{ Ok: bigint } | { Err: unknown }>;
};

type PlugLedgerActor = LedgerActor;

type LedgerApproveArgs = {
  fee: [] | [bigint];
  memo: [] | [Uint8Array];
  from_subaccount: [] | [Uint8Array];
  created_at_time: [] | [bigint];
  amount: bigint;
  expected_allowance: [] | [bigint];
  expires_at: [] | [bigint];
  spender: LedgerAccount;
};

type LedgerAccount = {
  owner: Principal;
  subaccount: [] | [Uint8Array];
};

type OisyCanisterCaller = {
  call: (input: { params: { canisterId: string; sender: string; method: string; arg: string }; options?: { timeoutInMilliseconds?: number } }) => Promise<OisyCallResult>;
};

declare global {
  interface Window {
    ic?: {
      plug?: PlugWallet;
    };
  }
}

const DEFAULT_OISY_SIGNER_URL = "https://oisy.com/sign";
const CALL_TIMEOUT_MS = 120_000;
type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];

export async function depositWithOisy(request: DepositRequest): Promise<DepositResult> {
  const config = await getBillingConfig(request.canisterId);
  const transferFeeE8s = await getLedgerTransferFee(config.kinicLedgerCanisterId);
  const approvedAllowanceE8s = allowanceForTopUp(request.amountE8s, transferFeeE8s);
  const wallet = await IcrcWallet.connect({
    url: process.env.NEXT_PUBLIC_OISY_SIGNER_URL ?? DEFAULT_OISY_SIGNER_URL,
    host: process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io"
  });
  try {
    const accounts = await wallet.accounts();
    const account = accounts[0];
    if (!account) throw new Error("OISY account not found");
    const approveBlockIndex = await wallet.approve({
      owner: account.owner,
      ledgerCanisterId: config.kinicLedgerCanisterId,
      params: approveParams(request.canisterId, approvedAllowanceE8s),
      options: { timeoutInMilliseconds: CALL_TIMEOUT_MS }
    });
    const topUp = await oisyCallTopUp(wallet, account.owner, request);
    return {
      provider: "oisy",
      approveBlockIndex: approveBlockIndex.toString(),
      approvedAllowanceE8s: approvedAllowanceE8s.toString(),
      creditedAmountE8s: request.amountE8s.toString(),
      transferFeeE8s: transferFeeE8s.toString(),
      topUpBlockIndex: topUp.blockIndex,
      balanceE8s: topUp.balanceE8s
    };
  } finally {
    await wallet.disconnect();
  }
}

export async function depositWithPlug(request: DepositRequest): Promise<DepositResult> {
  const config = await getBillingConfig(request.canisterId);
  const plug = window.ic?.plug;
  if (!plug) throw new Error("Plug wallet extension not found");
  const connected = await plug.requestConnect({
    whitelist: [request.canisterId, config.kinicLedgerCanisterId],
    host: process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io"
  });
  if (!connected) throw new Error("Plug connection rejected");
  const ledgerActor = await plug.createActor({
    canisterId: config.kinicLedgerCanisterId,
    interfaceFactory: ledgerIdlFactory
  });
  const transferFeeE8s = await (ledgerActor as PlugLedgerActor).icrc1_fee();
  const approvedAllowanceE8s = allowanceForTopUp(request.amountE8s, transferFeeE8s);
  const approve = await (ledgerActor as PlugLedgerActor).icrc2_approve(rawApproveArgs(request.canisterId, approvedAllowanceE8s));
  if ("Err" in approve) throw new Error(`ledger approve failed: ${JSON.stringify(approve.Err)}`);
  const vfsActor = await plug.createActor({
    canisterId: request.canisterId,
    interfaceFactory: idlFactory
  });
  const topUp = await (vfsActor as PlugVfsActor).top_up_database(request.databaseId, request.amountE8s);
  if ("Err" in topUp) throw new Error(topUp.Err);
  return {
    provider: "plug",
    approveBlockIndex: approve.Ok.toString(),
    approvedAllowanceE8s: approvedAllowanceE8s.toString(),
    creditedAmountE8s: request.amountE8s.toString(),
    transferFeeE8s: transferFeeE8s.toString(),
    topUpBlockIndex: topUp.Ok.block_index.toString(),
    balanceE8s: topUp.Ok.balance_e8s.toString()
  };
}

function approveParams(canisterId: string, allowanceE8s: bigint): ApproveParams {
  return {
    spender: { owner: Principal.fromText(canisterId), subaccount: [] },
    amount: allowanceE8s,
    created_at_time: BigInt(Date.now()) * 1_000_000n
  };
}

function rawApproveArgs(canisterId: string, allowanceE8s: bigint): LedgerApproveArgs {
  return {
    fee: [],
    memo: [],
    from_subaccount: [],
    created_at_time: [BigInt(Date.now()) * 1_000_000n],
    amount: allowanceE8s,
    expected_allowance: [],
    expires_at: [],
    spender: { owner: Principal.fromText(canisterId), subaccount: [] }
  };
}

function allowanceForTopUp(amountE8s: bigint, transferFeeE8s: bigint): bigint {
  return amountE8s + transferFeeE8s;
}

async function getLedgerTransferFee(ledgerCanisterId: string): Promise<bigint> {
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ identity: new AnonymousIdentity(), host });
  if (agent.isLocal()) await agent.fetchRootKey();
  const actor = Actor.createActor<LedgerActor>(ledgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(ledgerCanisterId)
  });
  return actor.icrc1_fee();
}

async function oisyCallTopUp(wallet: IcrcWallet, owner: string, request: DepositRequest): Promise<{ blockIndex: string; balanceE8s: string }> {
  const caller = wallet as unknown as OisyCanisterCaller;
  const arg = encodeTopUpArgs(request.databaseId, request.amountE8s);
  const result = await caller.call({
    params: {
      canisterId: request.canisterId,
      sender: owner,
      method: "top_up_database",
      arg
    },
    options: { timeoutInMilliseconds: CALL_TIMEOUT_MS }
  });
  return decodeOisyTopUpResult({
    canisterId: request.canisterId,
    method: "top_up_database",
    arg,
    result
  });
}

function encodeTopUpArgs(databaseId: string, amountE8s: bigint): string {
  return uint8ArrayToBase64(IDL.encode([IDL.Text, IDL.Nat64], [databaseId, amountE8s]));
}

async function decodeOisyTopUpResult({
  canisterId,
  method,
  arg,
  result
}: {
  canisterId: string;
  method: string;
  arg: string;
  result: OisyCallResult;
}): Promise<{ blockIndex: string; balanceE8s: string }> {
  const contentMap = Cbor.decode<Record<string, unknown>>(base64ToUint8Array(result.contentMap));
  if (String(contentMap.method_name) !== method) throw new Error("wallet response method mismatch");
  if (Principal.fromUint8Array(contentMap.canister_id as Uint8Array).toText() !== Principal.fromText(canisterId).toText()) {
    throw new Error("wallet response canister mismatch");
  }
  if (!sameBytes(base64ToUint8Array(arg), contentMap.arg as Uint8Array)) throw new Error("wallet response argument mismatch");
  const requestId = requestIdOf(contentMap);
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ identity: new AnonymousIdentity(), host });
  if (agent.isLocal()) await agent.fetchRootKey();
  if (!agent.rootKey) throw new Error("agent root key unavailable");
  const certificate = await Certificate.create({
    certificate: base64ToUint8Array(result.certificate),
    rootKey: agent.rootKey,
    principal: { canisterId: Principal.fromText(canisterId) }
  });
  const reply = lookupResultToBuffer(certificate.lookup_path([new TextEncoder().encode("request_status"), requestId, "reply"]));
  if (!reply) throw new Error("wallet response reply unavailable");
  const [decoded] = IDL.decode([topUpResultType()], reply) as [{ Ok: { block_index: bigint; balance_e8s: bigint } } | { Err: string }];
  if ("Err" in decoded) throw new Error(decoded.Err);
  return {
    blockIndex: decoded.Ok.block_index.toString(),
    balanceE8s: decoded.Ok.balance_e8s.toString()
  };
}

function topUpResultType() {
  return IDL.Variant({
    Ok: IDL.Record({ block_index: IDL.Nat64, balance_e8s: IDL.Nat64 }),
    Err: IDL.Text
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

const ledgerIdlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {
  const account = idl.Record({ owner: idl.Principal, subaccount: idl.Opt(idl.Vec(idl.Nat8)) });
  const approveArgs = idl.Record({
    fee: idl.Opt(idl.Nat),
    memo: idl.Opt(idl.Vec(idl.Nat8)),
    from_subaccount: idl.Opt(idl.Vec(idl.Nat8)),
    created_at_time: idl.Opt(idl.Nat64),
    amount: idl.Nat,
    expected_allowance: idl.Opt(idl.Nat),
    expires_at: idl.Opt(idl.Nat64),
    spender: account
  });
  const approveError = idl.Variant({
    GenericError: idl.Record({ message: idl.Text, error_code: idl.Nat }),
    TemporarilyUnavailable: idl.Null,
    Duplicate: idl.Record({ duplicate_of: idl.Nat }),
    BadFee: idl.Record({ expected_fee: idl.Nat }),
    AllowanceChanged: idl.Record({ current_allowance: idl.Nat }),
    CreatedInFuture: idl.Record({ ledger_time: idl.Nat64 }),
    TooOld: idl.Null,
    Expired: idl.Record({ ledger_time: idl.Nat64 }),
    InsufficientFunds: idl.Record({ balance: idl.Nat })
  });
  return idl.Service({
    icrc1_fee: idl.Func([], [idl.Nat], ["query"]),
    icrc2_approve: idl.Func([approveArgs], [idl.Variant({ Ok: idl.Nat, Err: approveError })], [])
  });
};
