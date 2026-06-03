import { IcrcWallet } from "@dfinity/oisy-wallet-signer/icrc-wallet";
import { base64ToUint8Array, uint8ArrayToBase64 } from "@dfinity/utils";
import type { ApproveParams } from "@icp-sdk/canisters/ledger/icrc";
import { Actor, AnonymousIdentity, Cbor, Certificate, HttpAgent, lookupResultToBuffer, requestIdOf } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { getCyclesBillingConfig, type DatabaseCyclesPurchaseRequest } from "@/lib/vfs-client";
import { idlFactory } from "@/lib/vfs-idl";
import { formatRawCycles, KINIC_LEDGER_FEE_E8S, MAX_CANISTER_I64, MAX_LEDGER_U64, kinicBaseUnitsPerToken } from "@/lib/cycles";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";

type WalletProvider = "oisy" | "plug";

type CyclesPurchaseRequest = {
  canisterId: string;
  databaseId: string;
  paymentAmountE8s: bigint;
};

type CyclesPurchaseResult = {
  provider: WalletProvider;
  approveBlockIndex: string;
  approvedAllowanceE8s: string;
  purchasedCycles: string;
  paymentAmountE8s: string;
  transferFeeE8s: string;
  purchaseBlockIndex: string | null;
  balanceCycles: string | null;
};

export class CyclesPurchaseAfterApproveError extends Error {
  approveBlockIndex: string;
  causeMessage: string;

  constructor(input: { approveBlockIndex: string; causeMessage: string; expiresAt: bigint }) {
    const expiry = new Date(Number(input.expiresAt / 1_000_000n)).toISOString();
    super(`cycles purchase failed after approve; approval remains until ${expiry}: ${input.causeMessage}`);
    this.name = "CyclesPurchaseAfterApproveError";
    this.approveBlockIndex = input.approveBlockIndex;
    this.causeMessage = input.causeMessage;
  }
}

type PreparedCyclesPurchase = {
  kinicLedgerCanisterId: string;
  purchaseRequest: DatabaseCyclesPurchaseRequest;
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

type CyclesPurchaseWalletConnectOptions = {
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
  purchase_database_cycles: (request: DatabaseCyclesPurchaseRequest) => Promise<{ Ok: { block_index: bigint; amount_cycles: bigint; balance_cycles: bigint } } | { Err: string }>;
};

type LedgerActor = {
  icrc1_balance_of: (request: LedgerAccount) => Promise<bigint>;
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
  owner: string;
};

export type ConnectedPlugWallet = {
  principal: string;
};

export type ConnectedKinicWallet = { provider: "oisy"; connection: ConnectedOisyWallet } | { provider: "plug"; connection: ConnectedPlugWallet };

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

type CyclesPurchaseIcrcWalletOptions = {
  origin: string;
  popup: Window;
  onDisconnect?: () => void;
  host?: string;
};

class CyclesPurchaseIcrcWallet extends IcrcWallet {
  constructor(options: CyclesPurchaseIcrcWalletOptions) {
    super(options);
  }

  static override async connect({ onDisconnect, host, ...rest }: CyclesPurchaseWalletConnectOptions): Promise<CyclesPurchaseIcrcWallet> {
    return CyclesPurchaseIcrcWallet.connectSigner({
      options: rest,
      init: (params) => new CyclesPurchaseIcrcWallet({ ...params, onDisconnect, host })
    });
  }

  async callCyclesPurchase(params: IcrcCallCanisterRequestParams): Promise<IcrcCallCanisterResult> {
    return this.call({
      params,
      options: { timeoutInMilliseconds: CALL_TIMEOUT_MS }
    });
  }
}

function openOisyWallet(): Promise<CyclesPurchaseIcrcWallet> {
  return CyclesPurchaseIcrcWallet.connect({
    url: process.env.NEXT_PUBLIC_OISY_SIGNER_URL ?? DEFAULT_OISY_SIGNER_URL,
    host: process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io"
  });
}

async function safeDisconnectOisyWallet(wallet: CyclesPurchaseIcrcWallet): Promise<void> {
  try {
    await wallet.disconnect();
  } catch {
    // Cleanup failures must not hide connect, approve, or purchase errors.
  }
}

export async function connectOisyWallet(): Promise<ConnectedOisyWallet> {
  const wallet = await openOisyWallet();
  try {
    const accounts = await wallet.accounts();
    const account = accounts[0];
    if (!account) throw new Error("OISY account not found");
    return { owner: account.owner };
  } finally {
    await safeDisconnectOisyWallet(wallet);
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

export async function getConnectedWalletKinicBalance(canisterId: string, wallet: ConnectedKinicWallet): Promise<string> {
  assertConfiguredCyclesCanister(canisterId);
  const config = await getCyclesBillingConfig(canisterId);
  const balance = await getLedgerBalance(config.kinicLedgerCanisterId, connectedWalletPrincipal(wallet));
  return balance.toString();
}

export async function purchaseCyclesWithOisy(request: CyclesPurchaseRequest, connection: ConnectedOisyWallet): Promise<CyclesPurchaseResult> {
  const prepared = await prepareCyclesPurchase(request, connection.owner);
  const wallet = await openOisyWallet();
  try {
    const accounts = await wallet.accounts();
    const account = accounts[0];
    if (!account) throw new Error("OISY account not found");
    if (account.owner !== connection.owner) throw new Error("OISY owner changed; connect OISY again");
    const approveBlockIndex = await wallet.approve({
      owner: connection.owner,
      ledgerCanisterId: prepared.kinicLedgerCanisterId,
      params: approveParams(request.canisterId, prepared.approvedAllowanceE8s, prepared.currentAllowanceE8s, prepared.expiresAt),
      options: { timeoutInMilliseconds: CALL_TIMEOUT_MS }
    });
    const purchase = await purchaseAfterApprove(
      () => oisyCallCyclesPurchase(wallet, connection.owner, request.canisterId, prepared.purchaseRequest),
      { approveBlockIndex: approveBlockIndex.toString(), expiresAt: prepared.expiresAt }
    );
    return {
      provider: "oisy",
      approveBlockIndex: approveBlockIndex.toString(),
      approvedAllowanceE8s: prepared.approvedAllowanceE8s.toString(),
      purchasedCycles: formatRawCycles(BigInt(purchase.amountCycles)),
      paymentAmountE8s: prepared.paymentAmountE8s.toString(),
      transferFeeE8s: prepared.transferFeeE8s.toString(),
      purchaseBlockIndex: purchase.blockIndex,
      balanceCycles: purchase.balanceCycles ? formatRawCycles(BigInt(purchase.balanceCycles)) : null
    };
  } finally {
    await safeDisconnectOisyWallet(wallet);
  }
}

export async function purchaseCyclesWithPlug(request: CyclesPurchaseRequest, connection: ConnectedPlugWallet): Promise<CyclesPurchaseResult> {
  const prepared = await prepareCyclesPurchase(request, connection.principal);
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
  if ("Err" in approve) throw new Error(`ledger approve failed: ${formatLedgerApproveError(approve.Err)}`);
  const vfsActor = await plug.createActor<PlugVfsActor>({
    canisterId: request.canisterId,
    interfaceFactory: idlFactory
  });
  const purchase = await purchaseAfterApprove(async () => {
    const result = await vfsActor.purchase_database_cycles(prepared.purchaseRequest);
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok;
  }, { approveBlockIndex: approve.Ok.toString(), expiresAt: prepared.expiresAt });
  return {
    provider: "plug",
    approveBlockIndex: approve.Ok.toString(),
    approvedAllowanceE8s: prepared.approvedAllowanceE8s.toString(),
    purchasedCycles: formatRawCycles(purchase.amount_cycles),
    paymentAmountE8s: prepared.paymentAmountE8s.toString(),
    transferFeeE8s: prepared.transferFeeE8s.toString(),
    purchaseBlockIndex: purchase.block_index.toString(),
    balanceCycles: formatRawCycles(purchase.balance_cycles)
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

async function prepareCyclesPurchase(request: CyclesPurchaseRequest, payer: string): Promise<PreparedCyclesPurchase> {
  assertConfiguredCyclesCanister(request.canisterId);
  const config = await getCyclesBillingConfig(request.canisterId);
  const transferFeeE8s = KINIC_LEDGER_FEE_E8S;
  const paymentAmountE8s = request.paymentAmountE8s;
  assertCanisterPaymentAmountE8s(paymentAmountE8s);
  const minExpectedCycles = cyclesForPaymentAmountE8s(paymentAmountE8s, BigInt(config.cyclesPerKinic));
  const approvedAllowanceE8s = allowanceForCyclesPurchase(paymentAmountE8s, transferFeeE8s);
  const expiresAt = approveExpiresAt();
  const currentAllowanceE8s = await getLedgerAllowance(config.kinicLedgerCanisterId, payer, request.canisterId);
  return {
    kinicLedgerCanisterId: config.kinicLedgerCanisterId,
    purchaseRequest: {
      database_id: request.databaseId,
      payment_amount_e8s: paymentAmountE8s,
      min_expected_cycles: minExpectedCycles,
    },
    transferFeeE8s,
    paymentAmountE8s,
    approvedAllowanceE8s,
    currentAllowanceE8s,
    expiresAt
  };
}

function allowanceForCyclesPurchase(amountE8s: bigint, transferFeeE8s: bigint): bigint {
  const allowance = amountE8s + transferFeeE8s;
  if (allowance > MAX_LEDGER_U64) throw new Error("approved allowance exceeds u64::MAX");
  return allowance;
}

function cyclesForPaymentAmountE8s(amountE8s: bigint, cyclesPerKinic: bigint): bigint {
  const cycles = (amountE8s * cyclesPerKinic) / kinicBaseUnitsPerToken();
  if (cycles <= 0n) throw new Error("KINIC amount is too small for a cycles purchase");
  if (cycles > MAX_CANISTER_I64) throw new Error("cycles purchase amount exceeds canister limit");
  return cycles;
}

function assertCanisterPaymentAmountE8s(amountE8s: bigint): void {
  if (amountE8s <= 0n) throw new Error("KINIC amount must be positive");
  if (amountE8s > MAX_CANISTER_I64) throw new Error("KINIC amount e8s exceeds canister limit");
}

function approveExpiresAt(): bigint {
  return BigInt(Date.now() + APPROVE_EXPIRES_IN_MS) * 1_000_000n;
}

function assertConfiguredCyclesCanister(canisterId: string): void {
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

async function getLedgerBalance(ledgerCanisterId: string, owner: string): Promise<bigint> {
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ identity: new AnonymousIdentity(), host });
  if (agent.isLocal()) await agent.fetchRootKey();
  const actor = Actor.createActor<LedgerActor>(ledgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(ledgerCanisterId)
  });
  return actor.icrc1_balance_of(defaultAccount(owner));
}

function allowanceArgs(owner: string, spender: string): LedgerAllowanceArgs {
  return {
    account: defaultAccount(owner),
    spender: defaultAccount(spender)
  };
}

function defaultAccount(owner: string): LedgerAccount {
  return { owner: Principal.fromText(owner), subaccount: [] };
}

function connectedWalletPrincipal(wallet: ConnectedKinicWallet): string {
  return wallet.provider === "oisy" ? wallet.connection.owner : wallet.connection.principal;
}

async function oisyCallCyclesPurchase(
  wallet: CyclesPurchaseIcrcWallet,
  owner: string,
  canisterId: string,
  request: DatabaseCyclesPurchaseRequest
): Promise<{ blockIndex: string; amountCycles: string; balanceCycles: string }> {
  const arg = encodeCyclesPurchaseArgs(request);
  const result = await wallet.callCyclesPurchase({
    canisterId,
    sender: owner,
    method: "purchase_database_cycles",
    arg
  });
  return decodeOisyCyclesPurchaseResult({
    canisterId,
    sender: owner,
    method: "purchase_database_cycles",
    arg,
    result
  });
}

async function purchaseAfterApprove<T>(run: () => Promise<T>, context: { approveBlockIndex: string; expiresAt: bigint }): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new CyclesPurchaseAfterApproveError({
      approveBlockIndex: context.approveBlockIndex,
      causeMessage: errorMessage(cause),
      expiresAt: context.expiresAt
    });
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function encodeCyclesPurchaseArgs(request: DatabaseCyclesPurchaseRequest): string {
  const PurchaseRequest = IDL.Record({
    database_id: IDL.Text,
    payment_amount_e8s: IDL.Nat64,
    min_expected_cycles: IDL.Nat64
  });
  return uint8ArrayToBase64(IDL.encode([PurchaseRequest], [request]));
}

async function decodeOisyCyclesPurchaseResult({
  canisterId,
  sender,
  method,
  arg,
  result
}: {
  canisterId: string;
  sender: string;
  method: string;
  arg: string;
  result: IcrcCallCanisterResult;
}): Promise<{ blockIndex: string; amountCycles: string; balanceCycles: string }> {
  const contentMap = Cbor.decode<Record<string, unknown>>(base64ToUint8Array(result.contentMap));
  const responseMethod = contentMap.method_name;
  if (typeof responseMethod !== "string" || responseMethod !== method) throw new Error("wallet response method mismatch");
  const responseCanisterId = bytesFromUnknown(contentMap.canister_id, "wallet response canister");
  if (Principal.fromUint8Array(responseCanisterId).toText() !== Principal.fromText(canisterId).toText()) {
    throw new Error("wallet response canister mismatch");
  }
  const responseSender = bytesFromUnknown(contentMap.sender, "wallet response sender");
  if (Principal.fromUint8Array(responseSender).toText() !== Principal.fromText(sender).toText()) {
    throw new Error("wallet response sender mismatch");
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

function decodePurchaseResult(reply: Uint8Array): { blockIndex: string; amountCycles: string; balanceCycles: string } {
  const [decoded] = IDL.decode([purchaseResultType()], reply);
  if (!isObject(decoded)) throw new Error("wallet response result mismatch");
  if (hasOwn(decoded, "Err")) {
    const error = Reflect.get(decoded, "Err");
    throw new Error(typeof error === "string" ? error : "cycles purchase failed");
  }
  const ok = Reflect.get(decoded, "Ok");
  if (!isObject(ok)) throw new Error("wallet response result mismatch");
  const blockIndex = Reflect.get(ok, "block_index");
  const amountCycles = Reflect.get(ok, "amount_cycles");
  const balanceCycles = Reflect.get(ok, "balance_cycles");
  if (typeof blockIndex !== "bigint" || typeof amountCycles !== "bigint" || typeof balanceCycles !== "bigint") {
    throw new Error("wallet response result mismatch");
  }
  return {
    blockIndex: blockIndex.toString(),
    amountCycles: amountCycles.toString(),
    balanceCycles: balanceCycles.toString()
  };
}

function purchaseResultType() {
  return IDL.Variant({
    Ok: IDL.Record({ block_index: IDL.Nat64, amount_cycles: IDL.Nat64, balance_cycles: IDL.Nat64 }),
    Err: IDL.Text
  });
}

function formatLedgerApproveError(error: unknown): string {
  const known = formatKnownLedgerApproveError(error);
  return known ?? safeJsonWithBigInts(error);
}

function formatKnownLedgerApproveError(error: unknown): string | null {
  if (!isObject(error)) return null;
  if (hasOwn(error, "InsufficientFunds")) {
    return formatApproveErrorField(error, "InsufficientFunds", "balance", "kinic");
  }
  if (hasOwn(error, "BadFee")) {
    return formatApproveErrorField(error, "BadFee", "expected_fee", "kinic");
  }
  if (hasOwn(error, "AllowanceChanged")) {
    return formatApproveErrorField(error, "AllowanceChanged", "current_allowance", "kinic");
  }
  if (hasOwn(error, "Duplicate")) {
    return formatApproveErrorField(error, "Duplicate", "duplicate_of", null);
  }
  if (hasOwn(error, "CreatedInFuture")) {
    return formatApproveErrorField(error, "CreatedInFuture", "ledger_time", null);
  }
  if (hasOwn(error, "Expired")) {
    return formatApproveErrorField(error, "Expired", "ledger_time", null);
  }
  if (hasOwn(error, "GenericError")) {
    const generic = Reflect.get(error, "GenericError");
    if (!isObject(generic)) return "GenericError";
    const message = Reflect.get(generic, "message");
    const errorCode = Reflect.get(generic, "error_code");
    const messageText = typeof message === "string" ? message : "unknown ledger error";
    const codeText = scalarText(errorCode);
    return codeText ? `GenericError: ${messageText} (code ${codeText})` : `GenericError: ${messageText}`;
  }
  if (hasOwn(error, "TemporarilyUnavailable")) return "TemporarilyUnavailable";
  if (hasOwn(error, "TooOld")) return "TooOld";
  return null;
}

function formatApproveErrorField(error: object, variant: string, field: string, unit: "kinic" | null): string {
  const details = Reflect.get(error, variant);
  if (!isObject(details)) return variant;
  const value = Reflect.get(details, field);
  const text = scalarText(value);
  if (!text) return variant;
  const display = unit === "kinic" ? formatTokenAmountFromE8s(text) : text;
  return `${variant}: ${field} ${display}`;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return value.toString();
  }
  return null;
}

function safeJsonWithBigInts(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
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
    icrc1_balance_of: idl.Func([account], [idl.Nat], ["query"]),
    icrc2_allowance: idl.Func([allowanceArgs], [allowance], ["query"]),
    icrc2_approve: idl.Func([approveArgs], [idl.Variant({ Ok: idl.Nat, Err: approveError })], [])
  });
};
