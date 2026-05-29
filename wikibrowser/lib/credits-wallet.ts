import { IcrcWallet } from "@dfinity/oisy-wallet-signer/icrc-wallet";
import { base64ToUint8Array, uint8ArrayToBase64 } from "@dfinity/utils";
import type { ApproveParams } from "@icp-sdk/canisters/ledger/icrc";
import { Actor, AnonymousIdentity, Cbor, Certificate, HttpAgent, lookupResultToBuffer, requestIdOf } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { getCreditsConfig, previewDatabaseCreditPurchase, type DatabaseCreditPurchaseRequest } from "@/lib/vfs-client";
import { idlFactory } from "@/lib/vfs-idl";

type WalletProvider = "oisy" | "plug";

type CreditsPurchaseRequest = {
  canisterId: string;
  databaseId: string;
  credits: bigint;
};

type CreditsPurchaseResult = {
  provider: WalletProvider;
  approveBlockIndex: string;
  approvedAllowanceE8s: string;
  creditedCredits: string;
  paymentAmountE8s: string;
  transferFeeE8s: string;
  purchaseBlockIndex: string | null;
  balanceCredits: string | null;
};

type PreparedCreditPurchase = {
  kinicLedgerCanisterId: string;
  purchaseRequest: DatabaseCreditPurchaseRequest;
  transferFeeE8s: bigint;
  paymentAmountE8s: bigint;
  approvedAllowanceE8s: bigint;
  currentAllowanceE8s: bigint;
  expiresAt: bigint;
};

type IcrcCallCanisterRequestParams = {
  canisterId: string;
  sender: string;
  method: string;
  arg: string;
  nonce?: string;
};

type IcrcCallCanisterResult = {
  contentMap: string;
  certificate: string;
};

type CreditPurchaseWalletConnectOptions = {
  url: string;
  windowOptions?: { position: "center" | "top-right"; width: number; height: number; features?: string } | string;
  connectionOptions?: { pollingIntervalInMilliseconds?: number; timeoutInMilliseconds?: number };
  onDisconnect?: () => void;
  host?: string;
};

type PlugWallet = {
  requestConnect: (input?: { whitelist?: string[]; host?: string }) => Promise<boolean>;
  createActor: <T>(input: { canisterId: string; interfaceFactory: unknown }) => Promise<T>;
  agent?: { getPrincipal: () => Promise<Principal> };
};

type PlugVfsActor = {
  purchase_database_credits: (request: DatabaseCreditPurchaseRequest) => Promise<{ Ok: { block_index: bigint; balance_credits: bigint } } | { Err: string }>;
};

type LedgerActor = {
  icrc2_allowance: (request: LedgerAllowanceArgs) => Promise<LedgerAllowance>;
  icrc2_approve: (request: LedgerApproveArgs) => Promise<{ Ok: bigint } | { Err: unknown }>;
};

type PlugLedgerActor = LedgerActor;

type LedgerAllowanceArgs = {
  account: LedgerAccount;
  spender: LedgerAccount;
};

type LedgerAllowance = {
  allowance: bigint;
  expires_at: [] | [bigint];
};

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

export type ConnectedOisyWallet = {
  wallet: CreditPurchaseIcrcWallet;
  owner: string;
};

export type ConnectedPlugWallet = {
  principal: string;
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
const APPROVE_EXPIRES_IN_MS = 30 * 60 * 1000;
type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];

type CreditPurchaseIcrcWalletOptions = {
  origin: string;
  popup: Window;
  onDisconnect?: () => void;
  host?: string;
};

class CreditPurchaseIcrcWallet extends IcrcWallet {
  constructor(options: CreditPurchaseIcrcWalletOptions) {
    super(options);
  }

  static override async connect({ onDisconnect, host, ...rest }: CreditPurchaseWalletConnectOptions): Promise<CreditPurchaseIcrcWallet> {
    return CreditPurchaseIcrcWallet.connectSigner({
      options: rest,
      init: (params) => new CreditPurchaseIcrcWallet({ ...params, onDisconnect, host })
    });
  }

  async callCreditPurchase(params: IcrcCallCanisterRequestParams): Promise<IcrcCallCanisterResult> {
    return this.call({
      params,
      options: { timeoutInMilliseconds: CALL_TIMEOUT_MS }
    });
  }
}

export async function connectOisyWallet(): Promise<ConnectedOisyWallet> {
  const wallet = await CreditPurchaseIcrcWallet.connect({
    url: process.env.NEXT_PUBLIC_OISY_SIGNER_URL ?? DEFAULT_OISY_SIGNER_URL,
    host: process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io"
  });
  try {
    const accounts = await wallet.accounts();
    const account = accounts[0];
    if (!account) throw new Error("OISY account not found");
    return { wallet, owner: account.owner };
  } catch (cause) {
    await wallet.disconnect();
    throw cause;
  }
}

export async function connectPlugWallet(): Promise<ConnectedPlugWallet> {
  const plug = window.ic?.plug;
  if (!plug) throw new Error("Plug wallet extension not found");
  const connected = await plug.requestConnect({
    host: process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io"
  });
  if (!connected) throw new Error("Plug connection rejected");
  const principal = await plug.agent?.getPrincipal();
  if (!principal) throw new Error("Plug principal is not available");
  return { principal: principal.toText() };
}

export async function purchaseCreditsWithOisy(request: CreditsPurchaseRequest, connection: ConnectedOisyWallet): Promise<CreditsPurchaseResult> {
  const prepared = await prepareCreditPurchase(request, connection.owner);
  const approveBlockIndex = await connection.wallet.approve({
    owner: connection.owner,
    ledgerCanisterId: prepared.kinicLedgerCanisterId,
    params: approveParams(request.canisterId, prepared.approvedAllowanceE8s, prepared.currentAllowanceE8s, prepared.expiresAt),
    options: { timeoutInMilliseconds: CALL_TIMEOUT_MS }
  });
  const purchase = await purchaseAfterApprove(
    () => oisyCallCreditPurchase(connection.wallet, connection.owner, request.canisterId, prepared.purchaseRequest),
    prepared.expiresAt
  );
  return {
    provider: "oisy",
    approveBlockIndex: approveBlockIndex.toString(),
    approvedAllowanceE8s: prepared.approvedAllowanceE8s.toString(),
    creditedCredits: request.credits.toString(),
    paymentAmountE8s: prepared.paymentAmountE8s.toString(),
    transferFeeE8s: prepared.transferFeeE8s.toString(),
    purchaseBlockIndex: purchase.blockIndex,
    balanceCredits: purchase.balanceCredits
  };
}

export async function purchaseCreditsWithPlug(request: CreditsPurchaseRequest, connection: ConnectedPlugWallet): Promise<CreditsPurchaseResult> {
  const prepared = await prepareCreditPurchase(request, connection.principal);
  const plug = window.ic?.plug;
  if (!plug) throw new Error("Plug wallet extension not found");
  const connected = await plug.requestConnect({
    whitelist: [request.canisterId, prepared.kinicLedgerCanisterId],
    host: process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io"
  });
  if (!connected) throw new Error("Plug connection rejected");
  const principal = await plug.agent?.getPrincipal();
  if (!principal) throw new Error("Plug principal is not available");
  if (principal.toText() !== connection.principal) throw new Error("Plug principal changed; connect Plug again");
  const ledgerActor = await plug.createActor<PlugLedgerActor>({
    canisterId: prepared.kinicLedgerCanisterId,
    interfaceFactory: ledgerIdlFactory
  });
  const approve = await ledgerActor.icrc2_approve(
    rawApproveArgs(request.canisterId, prepared.approvedAllowanceE8s, prepared.currentAllowanceE8s, prepared.expiresAt)
  );
  if ("Err" in approve) throw new Error(`ledger approve failed: ${JSON.stringify(approve.Err)}`);
  const vfsActor = await plug.createActor<PlugVfsActor>({
    canisterId: request.canisterId,
    interfaceFactory: idlFactory
  });
  const purchase = await purchaseAfterApprove(async () => {
    const result = await vfsActor.purchase_database_credits(prepared.purchaseRequest);
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok;
  }, prepared.expiresAt);
  return {
    provider: "plug",
    approveBlockIndex: approve.Ok.toString(),
    approvedAllowanceE8s: prepared.approvedAllowanceE8s.toString(),
    creditedCredits: request.credits.toString(),
    paymentAmountE8s: prepared.paymentAmountE8s.toString(),
    transferFeeE8s: prepared.transferFeeE8s.toString(),
    purchaseBlockIndex: purchase.block_index.toString(),
    balanceCredits: purchase.balance_credits.toString()
  };
}

function approveParams(canisterId: string, allowanceE8s: bigint, expectedAllowanceE8s: bigint, expiresAt: bigint): ApproveParams {
  return {
    spender: { owner: Principal.fromText(canisterId), subaccount: [] },
    amount: allowanceE8s,
    expected_allowance: expectedAllowanceE8s,
    expires_at: expiresAt,
    created_at_time: BigInt(Date.now()) * 1_000_000n
  };
}

function rawApproveArgs(canisterId: string, allowanceE8s: bigint, expectedAllowanceE8s: bigint, expiresAt: bigint): LedgerApproveArgs {
  return {
    fee: [],
    memo: [],
    from_subaccount: [],
    created_at_time: [BigInt(Date.now()) * 1_000_000n],
    amount: allowanceE8s,
    expected_allowance: [expectedAllowanceE8s],
    expires_at: [expiresAt],
    spender: { owner: Principal.fromText(canisterId), subaccount: [] }
  };
}

async function prepareCreditPurchase(request: CreditsPurchaseRequest, payer: string): Promise<PreparedCreditPurchase> {
  assertConfiguredCreditsCanister(request.canisterId);
  const config = await getCreditsConfig(request.canisterId);
  const preview = await previewDatabaseCreditPurchase(request.canisterId, request.databaseId, request.credits);
  const transferFeeE8s = BigInt(preview.ledgerFeeE8s);
  const paymentAmountE8s = BigInt(preview.paymentAmountE8s);
  const approvedAllowanceE8s = allowanceForCreditPurchase(paymentAmountE8s, transferFeeE8s);
  const expiresAt = approveExpiresAt();
  const currentAllowanceE8s = await getLedgerAllowance(config.kinicLedgerCanisterId, payer, request.canisterId);
  return {
    kinicLedgerCanisterId: config.kinicLedgerCanisterId,
    purchaseRequest: {
      database_id: request.databaseId,
      credits: request.credits,
      expected_payment_amount_e8s: paymentAmountE8s,
      expected_config_version: BigInt(preview.configVersion)
    },
    transferFeeE8s,
    paymentAmountE8s,
    approvedAllowanceE8s,
    currentAllowanceE8s,
    expiresAt
  };
}

function allowanceForCreditPurchase(amountE8s: bigint, transferFeeE8s: bigint): bigint {
  return amountE8s + transferFeeE8s;
}

function approveExpiresAt(): bigint {
  return BigInt(Date.now() + APPROVE_EXPIRES_IN_MS) * 1_000_000n;
}

function assertConfiguredCreditsCanister(canisterId: string): void {
  const configured = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID;
  if (!configured) throw new Error("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured");
  if (Principal.fromText(canisterId).toText() !== Principal.fromText(configured).toText()) {
    throw new Error("VFS canister does not match NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID");
  }
}

async function getLedgerAllowance(ledgerCanisterId: string, owner: string, spender: string): Promise<bigint> {
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ identity: new AnonymousIdentity(), host });
  if (agent.isLocal()) await agent.fetchRootKey();
  const actor = Actor.createActor<LedgerActor>(ledgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(ledgerCanisterId)
  });
  const result = await actor.icrc2_allowance(allowanceArgs(owner, spender));
  return result.allowance;
}

function allowanceArgs(owner: string, spender: string): LedgerAllowanceArgs {
  return {
    account: { owner: Principal.fromText(owner), subaccount: [] },
    spender: { owner: Principal.fromText(spender), subaccount: [] }
  };
}

async function oisyCallCreditPurchase(
  wallet: CreditPurchaseIcrcWallet,
  owner: string,
  canisterId: string,
  request: DatabaseCreditPurchaseRequest
): Promise<{ blockIndex: string; balanceCredits: string }> {
  const arg = encodeCreditPurchaseArgs(request);
  const result = await wallet.callCreditPurchase({
    canisterId,
    sender: owner,
    method: "purchase_database_credits",
    arg
  });
  return decodeOisyCreditPurchaseResult({
    canisterId,
    method: "purchase_database_credits",
    arg,
    result
  });
}

async function purchaseAfterApprove<T>(run: () => Promise<T>, expiresAt: bigint): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const expiry = new Date(Number(expiresAt / 1_000_000n)).toISOString();
    throw new Error(`credits purchase failed after approve; approval remains until ${expiry}: ${errorMessage(cause)}`);
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function encodeCreditPurchaseArgs(request: DatabaseCreditPurchaseRequest): string {
  const PurchaseRequest = IDL.Record({
    database_id: IDL.Text,
    credits: IDL.Nat64,
    expected_payment_amount_e8s: IDL.Nat64,
    expected_config_version: IDL.Nat64
  });
  return uint8ArrayToBase64(IDL.encode([PurchaseRequest], [request]));
}

async function decodeOisyCreditPurchaseResult({
  canisterId,
  method,
  arg,
  result
}: {
  canisterId: string;
  method: string;
  arg: string;
  result: IcrcCallCanisterResult;
}): Promise<{ blockIndex: string; balanceCredits: string }> {
  const contentMap = Cbor.decode<Record<string, unknown>>(base64ToUint8Array(result.contentMap));
  const responseMethod = contentMap.method_name;
  if (typeof responseMethod !== "string" || responseMethod !== method) throw new Error("wallet response method mismatch");
  const responseCanisterId = bytesFromUnknown(contentMap.canister_id, "wallet response canister");
  if (Principal.fromUint8Array(responseCanisterId).toText() !== Principal.fromText(canisterId).toText()) {
    throw new Error("wallet response canister mismatch");
  }
  const responseArg = bytesFromUnknown(contentMap.arg, "wallet response argument");
  if (!sameBytes(base64ToUint8Array(arg), responseArg)) throw new Error("wallet response argument mismatch");
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
  return decodePurchaseResult(reply);
}

function decodePurchaseResult(reply: Uint8Array): { blockIndex: string; balanceCredits: string } {
  const [decoded] = IDL.decode([purchaseResultType()], reply);
  if (!isObject(decoded)) throw new Error("wallet response result mismatch");
  if (hasOwn(decoded, "Err")) {
    const error = Reflect.get(decoded, "Err");
    throw new Error(typeof error === "string" ? error : "credits purchase failed");
  }
  const ok = Reflect.get(decoded, "Ok");
  if (!isObject(ok)) throw new Error("wallet response result mismatch");
  const blockIndex = Reflect.get(ok, "block_index");
  const balanceCredits = Reflect.get(ok, "balance_credits");
  if (typeof blockIndex !== "bigint" || typeof balanceCredits !== "bigint") {
    throw new Error("wallet response result mismatch");
  }
  return {
    blockIndex: blockIndex.toString(),
    balanceCredits: balanceCredits.toString()
  };
}

function purchaseResultType() {
  return IDL.Variant({
    Ok: IDL.Record({ block_index: IDL.Nat64, balance_credits: IDL.Nat64 }),
    Err: IDL.Text
  });
}

function bytesFromUnknown(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`${label} mismatch`);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

const ledgerIdlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {
  const account = idl.Record({ owner: idl.Principal, subaccount: idl.Opt(idl.Vec(idl.Nat8)) });
  const allowanceArgs = idl.Record({ account, spender: account });
  const allowance = idl.Record({ allowance: idl.Nat, expires_at: idl.Opt(idl.Nat64) });
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
    icrc2_allowance: idl.Func([allowanceArgs], [allowance], ["query"]),
    icrc2_approve: idl.Func([approveArgs], [idl.Variant({ Ok: idl.Nat, Err: approveError })], [])
  });
};
