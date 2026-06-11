import { IcrcWallet } from "@dfinity/oisy-wallet-signer/icrc-wallet";
import { base64ToUint8Array, uint8ArrayToBase64 } from "@dfinity/utils";
import type { ApproveParams } from "@icp-sdk/canisters/ledger/icrc";
import { Actor, AnonymousIdentity, Cbor, Certificate, HttpAgent, lookupResultToBuffer, requestIdOf } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { getCyclesBillingConfig, type DatabaseCyclesPurchaseRequest } from "@/lib/vfs-client";
import { idlFactory } from "@/lib/vfs-idl";
import { cyclesForPaymentAmountE8s, formatRawCycles, KINIC_LEDGER_FEE_E8S, MAX_CANISTER_I64, MAX_LEDGER_U64 } from "@/lib/cycles";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { configuredIcHost } from "@/lib/wallet-runtime";

type WalletProvider = "oisy" | "plug";

type CyclesPurchaseRequest = {
  canisterId: string;
  databaseId: string;
  paymentAmountE8s: bigint;
};

type CyclesPurchaseResult = {
  provider: WalletProvider;
  approveBlockIndex: string | null;
  approvedAllowanceE8s: string;
  purchasedCycles: string;
  paymentAmountE8s: string;
  transferFeeE8s: string;
  purchaseBlockIndex: string | null;
  balanceCycles: string | null;
};

type MarketPurchaseRequest = {
  canisterId: string;
  listingId: string;
  priceE8s: bigint;
  accessPrincipal: string;
};

type MarketPurchaseResult = {
  provider: WalletProvider;
  approveBlockIndex: string | null;
  approvedAllowanceE8s: string;
  orderId: string;
  listingId: string;
  databaseId: string;
  buyerPrincipal: string;
  sellerPrincipal: string;
  priceE8s: string;
  ledgerBlockIndex: string;
  createdAtMs: string;
};

type MarketPurchaseCanisterRequest = {
  listing_id: string;
  price_e8s: bigint;
  access_principal: string;
};

export class KinicAfterApproveError extends Error {
  approveBlockIndex: string | null;
  causeMessage: string;

  constructor(input: { approveBlockIndex: string | null; causeMessage: string; expiresAt: bigint | null }) {
    const approvalText =
      input.expiresAt === null
        ? "approval remains without expiry"
        : `approval remains until ${new Date(Number(input.expiresAt / 1_000_000n)).toISOString()}`;
    super(`KINIC canister call failed after approval; ${approvalText}: ${input.causeMessage}`);
    this.name = "KinicAfterApproveError";
    this.approveBlockIndex = input.approveBlockIndex;
    this.causeMessage = input.causeMessage;
  }
}

type PreparedKinicAllowance = {
  kinicLedgerCanisterId: string;
  transferFeeE8s: bigint;
  approvedAllowanceE8s: bigint;
  currentAllowance: LedgerAllowance;
  approvalExpiresAt: bigint | null;
  approvalRequired: boolean;
  expiresAt: bigint;
};

type PreparedCyclesPurchase = PreparedKinicAllowance & {
  purchaseRequest: DatabaseCyclesPurchaseRequest;
  paymentAmountE8s: bigint;
};

type AllowanceCallResult<T> = {
  value: T;
  approveBlockIndex: string | null;
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
  market_purchase_access: (request: MarketPurchaseCanisterRequest) => Promise<{ Ok: RawMarketOrder } | { Err: string }>;
};

type RawMarketOrder = {
  order_id: string;
  listing_id: string;
  database_id: string;
  buyer_principal: string;
  seller_principal: string;
  price_e8s: bigint;
  ledger_block_index: bigint;
  created_at_ms: bigint;
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

type KinicIcrcWalletOptions = {
  origin: string;
  popup: Window;
  onDisconnect?: () => void;
  host?: string;
};

class KinicIcrcWallet extends IcrcWallet {
  constructor(options: KinicIcrcWalletOptions) {
    super(options);
  }

  static override async connect({ onDisconnect, host, ...rest }: CyclesPurchaseWalletConnectOptions): Promise<KinicIcrcWallet> {
    return KinicIcrcWallet.connectSigner({
      options: rest,
      init: (params) => new KinicIcrcWallet({ ...params, onDisconnect, host })
    });
  }

  async callCanister(params: IcrcCallCanisterRequestParams): Promise<IcrcCallCanisterResult> {
    return this.call({
      params,
      options: { timeoutInMilliseconds: CALL_TIMEOUT_MS }
    });
  }
}

function openOisyWallet(): Promise<KinicIcrcWallet> {
  return KinicIcrcWallet.connect({
    url: process.env.NEXT_PUBLIC_OISY_SIGNER_URL ?? DEFAULT_OISY_SIGNER_URL,
    host: configuredIcHost()
  });
}

async function safeDisconnectOisyWallet(wallet: KinicIcrcWallet): Promise<void> {
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
    host: configuredIcHost()
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

export async function getPrincipalKinicLedgerBalance(canisterId: string, principal: string): Promise<string> {
  assertConfiguredCyclesCanister(canisterId);
  const config = await getCyclesBillingConfig(canisterId);
  const balance = await getLedgerBalance(config.kinicLedgerCanisterId, principal);
  return balance.toString();
}

export async function purchaseCyclesWithWallet(request: CyclesPurchaseRequest, wallet: ConnectedKinicWallet): Promise<CyclesPurchaseResult> {
  return wallet.provider === "oisy"
    ? purchaseCyclesWithOisy(request, wallet.connection)
    : purchaseCyclesWithPlug(request, wallet.connection);
}

export async function purchaseMarketAccessWithWallet(request: MarketPurchaseRequest, wallet: ConnectedKinicWallet): Promise<MarketPurchaseResult> {
  return wallet.provider === "oisy"
    ? purchaseMarketAccessWithOisy(request, wallet.connection)
    : purchaseMarketAccessWithPlug(request, wallet.connection);
}

export async function purchaseCyclesWithOisy(request: CyclesPurchaseRequest, connection: ConnectedOisyWallet): Promise<CyclesPurchaseResult> {
  const prepared = await prepareCyclesPurchase(request, connection.owner);
  const { value: purchase, approveBlockIndex } = await runOisyAllowanceCall(prepared, request.canisterId, connection.owner, (wallet) =>
    oisyCallCyclesPurchase(wallet, connection.owner, request.canisterId, prepared.purchaseRequest)
  );
  return {
    provider: "oisy",
    approveBlockIndex,
    approvedAllowanceE8s: prepared.approvedAllowanceE8s.toString(),
    purchasedCycles: formatRawCycles(BigInt(purchase.amountCycles)),
    paymentAmountE8s: prepared.paymentAmountE8s.toString(),
    transferFeeE8s: prepared.transferFeeE8s.toString(),
    purchaseBlockIndex: purchase.blockIndex,
    balanceCycles: purchase.balanceCycles ? formatRawCycles(BigInt(purchase.balanceCycles)) : null
  };
}

export async function purchaseCyclesWithPlug(request: CyclesPurchaseRequest, connection: ConnectedPlugWallet): Promise<CyclesPurchaseResult> {
  const prepared = await prepareCyclesPurchase(request, connection.principal);
  const { value: purchase, approveBlockIndex } = await runPlugAllowanceCall(prepared, request.canisterId, connection.principal, async (vfsActor) => {
    const result = await vfsActor.purchase_database_cycles(prepared.purchaseRequest);
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok;
  });
  return {
    provider: "plug",
    approveBlockIndex,
    approvedAllowanceE8s: prepared.approvedAllowanceE8s.toString(),
    purchasedCycles: formatRawCycles(purchase.amount_cycles),
    paymentAmountE8s: prepared.paymentAmountE8s.toString(),
    transferFeeE8s: prepared.transferFeeE8s.toString(),
    purchaseBlockIndex: purchase.block_index.toString(),
    balanceCycles: formatRawCycles(purchase.balance_cycles)
  };
}

export async function purchaseMarketAccessWithOisy(request: MarketPurchaseRequest, connection: ConnectedOisyWallet): Promise<MarketPurchaseResult> {
  assertConfiguredCyclesCanister(request.canisterId);
  const prepared = await prepareMarketPurchase(request, connection.owner);
  const { value: order, approveBlockIndex } = await runOisyAllowanceCall(prepared, request.canisterId, connection.owner, (wallet) =>
    oisyCallMarketPurchase(wallet, connection.owner, request.canisterId, rawMarketPurchaseRequest(request))
  );
  return normalizeMarketOrder(order, "oisy", approveBlockIndex, prepared.approvedAllowanceE8s.toString());
}

export async function purchaseMarketAccessWithPlug(request: MarketPurchaseRequest, connection: ConnectedPlugWallet): Promise<MarketPurchaseResult> {
  assertConfiguredCyclesCanister(request.canisterId);
  const prepared = await prepareMarketPurchase(request, connection.principal);
  const { value: order, approveBlockIndex } = await runPlugAllowanceCall(prepared, request.canisterId, connection.principal, async (vfsActor) => {
    const result = await vfsActor.market_purchase_access(rawMarketPurchaseRequest(request));
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok;
  });
  return normalizeMarketOrder(order, "plug", approveBlockIndex, prepared.approvedAllowanceE8s.toString());
}

async function runOisyAllowanceCall<T>(
  prepared: PreparedKinicAllowance,
  canisterId: string,
  owner: string,
  callCanister: (wallet: KinicIcrcWallet) => Promise<T>
): Promise<AllowanceCallResult<T>> {
  const wallet = await openOisyWallet();
  try {
    const accounts = await wallet.accounts();
    const account = accounts[0];
    if (!account) throw new Error("OISY account not found");
    if (account.owner !== owner) throw new Error("OISY owner changed; connect OISY again");
    let approveBlockIndex: string | null = null;
    if (prepared.approvalRequired) {
      const approvedBlockIndex = await wallet.approve({
        owner,
        ledgerCanisterId: prepared.kinicLedgerCanisterId,
        params: approveParams(canisterId, prepared.approvedAllowanceE8s, prepared.currentAllowance.allowance, prepared.expiresAt),
        options: { timeoutInMilliseconds: CALL_TIMEOUT_MS }
      });
      approveBlockIndex = approvedBlockIndex.toString();
    }
    const value = await callAfterApprove(() => callCanister(wallet), { approveBlockIndex, expiresAt: prepared.approvalExpiresAt });
    return { value, approveBlockIndex };
  } finally {
    await safeDisconnectOisyWallet(wallet);
  }
}

async function runPlugAllowanceCall<T>(
  prepared: PreparedKinicAllowance,
  canisterId: string,
  expectedPrincipal: string,
  callCanister: (vfsActor: PlugVfsActor) => Promise<T>
): Promise<AllowanceCallResult<T>> {
  const plug = window.ic?.plug;
  if (!plug) throw new Error("Plug wallet extension not found");
  const connected = await plug.requestConnect({
    whitelist: [canisterId, prepared.kinicLedgerCanisterId],
    host: configuredIcHost()
  });
  if (!connected) throw new Error("Plug connection rejected");
  const principal = await plug.agent?.getPrincipal();
  if (!principal) throw new Error("Plug principal is not available");
  if (principal.toText() !== expectedPrincipal) throw new Error("Plug principal changed; connect Plug again");
  let approveBlockIndex: string | null = null;
  if (prepared.approvalRequired) {
    const ledgerActor = await plug.createActor<PlugLedgerActor>({
      canisterId: prepared.kinicLedgerCanisterId,
      interfaceFactory: ledgerIdlFactory
    });
    const approve = await ledgerActor.icrc2_approve(
      rawApproveArgs(canisterId, prepared.approvedAllowanceE8s, prepared.currentAllowance.allowance, prepared.expiresAt)
    );
    if ("Err" in approve) throw new Error(`ledger approve failed: ${formatLedgerApproveError(approve.Err)}`);
    approveBlockIndex = approve.Ok.toString();
  }
  const vfsActor = await plug.createActor<PlugVfsActor>({
    canisterId,
    interfaceFactory: idlFactory
  });
  const value = await callAfterApprove(() => callCanister(vfsActor), { approveBlockIndex, expiresAt: prepared.approvalExpiresAt });
  return { value, approveBlockIndex };
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
  const paymentAmountE8s = request.paymentAmountE8s;
  const allowance = await prepareKinicAllowance(request.canisterId, payer, paymentAmountE8s);
  const config = await getCyclesBillingConfig(request.canisterId);
  const minExpectedCycles = cyclesForPaymentAmountE8s(paymentAmountE8s, BigInt(config.cyclesPerKinic));
  return {
    ...allowance,
    purchaseRequest: {
      database_id: request.databaseId,
      payment_amount_e8s: paymentAmountE8s,
      min_expected_cycles: minExpectedCycles,
    },
    paymentAmountE8s
  };
}

async function prepareMarketPurchase(request: MarketPurchaseRequest, payer: string): Promise<PreparedKinicAllowance> {
  return prepareKinicAllowance(request.canisterId, payer, request.priceE8s);
}

async function prepareKinicAllowance(canisterId: string, payer: string, amountE8s: bigint): Promise<PreparedKinicAllowance> {
  assertConfiguredCyclesCanister(canisterId);
  assertCanisterPaymentAmountE8s(amountE8s);
  const config = await getCyclesBillingConfig(canisterId);
  const transferFeeE8s = KINIC_LEDGER_FEE_E8S;
  const approvedAllowanceE8s = allowanceForKinicTransfer(amountE8s, transferFeeE8s);
  const expiresAt = approveExpiresAt();
  const currentAllowance = await getLedgerAllowance(config.kinicLedgerCanisterId, payer, canisterId);
  const approvalRequired = !allowanceIsUsable(currentAllowance, approvedAllowanceE8s, nowNs());
  return {
    kinicLedgerCanisterId: config.kinicLedgerCanisterId,
    transferFeeE8s,
    approvedAllowanceE8s,
    currentAllowance,
    approvalExpiresAt: approvalRequired ? expiresAt : allowanceExpiresAt(currentAllowance),
    approvalRequired,
    expiresAt
  };
}

function allowanceForKinicTransfer(amountE8s: bigint, transferFeeE8s: bigint): bigint {
  const allowance = amountE8s + transferFeeE8s;
  if (allowance > MAX_LEDGER_U64) throw new Error("approved allowance exceeds u64::MAX");
  return allowance;
}

function assertCanisterPaymentAmountE8s(amountE8s: bigint): void {
  if (amountE8s <= 0n) throw new Error("KINIC amount must be positive");
  if (amountE8s > MAX_CANISTER_I64) throw new Error("KINIC amount e8s exceeds canister limit");
}

function allowanceIsUsable(allowance: LedgerAllowance, requiredAllowanceE8s: bigint, currentTimeNs: bigint): boolean {
  if (allowance.allowance < requiredAllowanceE8s) return false;
  const expiresAt = allowanceExpiresAt(allowance);
  return expiresAt === null || expiresAt > currentTimeNs;
}

function allowanceExpiresAt(allowance: LedgerAllowance): bigint | null {
  return allowance.expires_at[0] ?? null;
}

function approveExpiresAt(): bigint {
  return nowNs() + BigInt(APPROVE_EXPIRES_IN_MS) * 1_000_000n;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function assertConfiguredCyclesCanister(canisterId: string): void {
  const configured = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID;
  if (!configured) throw new Error("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured");
  if (Principal.fromText(canisterId).toText() !== Principal.fromText(configured).toText()) {
    throw new Error("VFS canister does not match NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID");
  }
}

async function getLedgerAllowance(ledgerCanisterId: string, owner: string, spender: string): Promise<LedgerAllowance> {
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ identity: new AnonymousIdentity(), host });
  if (agent.isLocal()) await agent.fetchRootKey();
  const actor = Actor.createActor<LedgerActor>(ledgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(ledgerCanisterId)
  });
  return actor.icrc2_allowance(allowanceArgs(owner, spender));
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
  wallet: KinicIcrcWallet,
  owner: string,
  canisterId: string,
  request: DatabaseCyclesPurchaseRequest
): Promise<{ blockIndex: string; amountCycles: string; balanceCycles: string }> {
  const arg = encodeCyclesPurchaseArgs(request);
  const result = await wallet.callCanister({
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

async function oisyCallMarketPurchase(
  wallet: KinicIcrcWallet,
  owner: string,
  canisterId: string,
  request: MarketPurchaseCanisterRequest
): Promise<RawMarketOrder> {
  const arg = encodeMarketPurchaseArgs(request);
  const result = await wallet.callCanister({
    canisterId,
    sender: owner,
    method: "market_purchase_access",
    arg
  });
  return decodeOisyMarketPurchaseResult({
    canisterId,
    sender: owner,
    method: "market_purchase_access",
    arg,
    result
  });
}

async function callAfterApprove<T>(run: () => Promise<T>, context: { approveBlockIndex: string | null; expiresAt: bigint | null }): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new KinicAfterApproveError({
      approveBlockIndex: context.approveBlockIndex,
      causeMessage: errorMessage(cause),
      expiresAt: context.expiresAt
    });
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isObject(cause)) {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string") return message;
    return safeJsonWithBigInts(cause);
  }
  return String(cause);
}

function encodeCyclesPurchaseArgs(request: DatabaseCyclesPurchaseRequest): string {
  const PurchaseRequest = IDL.Record({
    database_id: IDL.Text,
    payment_amount_e8s: IDL.Nat64,
    min_expected_cycles: IDL.Nat64
  });
  return uint8ArrayToBase64(IDL.encode([PurchaseRequest], [request]));
}

function encodeMarketPurchaseArgs(request: MarketPurchaseCanisterRequest): string {
  const PurchaseRequest = IDL.Record({
    listing_id: IDL.Text,
    price_e8s: IDL.Nat64,
    access_principal: IDL.Text
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
  const reply = await decodeOisyCanisterReply({ canisterId, sender, method, arg, result });
  return decodePurchaseResult(reply);
}

async function decodeOisyMarketPurchaseResult({
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
}): Promise<RawMarketOrder> {
  const reply = await decodeOisyCanisterReply({ canisterId, sender, method, arg, result });
  return decodeMarketPurchaseResult(reply);
}

async function decodeOisyCanisterReply({
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
}): Promise<Uint8Array> {
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
  return reply;
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

function decodeMarketPurchaseResult(reply: Uint8Array): RawMarketOrder {
  const [decoded] = IDL.decode([marketPurchaseResultType()], reply);
  if (!isObject(decoded)) throw new Error("wallet response result mismatch");
  if (hasOwn(decoded, "Err")) {
    const error = Reflect.get(decoded, "Err");
    throw new Error(typeof error === "string" ? error : "market purchase failed");
  }
  const ok = Reflect.get(decoded, "Ok");
  if (!isRawMarketOrder(ok)) throw new Error("wallet response result mismatch");
  return ok;
}

function marketPurchaseResultType() {
  const MarketOrder = IDL.Record({
    order_id: IDL.Text,
    listing_id: IDL.Text,
    database_id: IDL.Text,
    buyer_principal: IDL.Text,
    seller_principal: IDL.Text,
    price_e8s: IDL.Nat64,
    ledger_block_index: IDL.Nat64,
    created_at_ms: IDL.Int64
  });
  return IDL.Variant({
    Ok: MarketOrder,
    Err: IDL.Text
  });
}

function rawMarketPurchaseRequest(request: MarketPurchaseRequest): MarketPurchaseCanisterRequest {
  return {
    listing_id: request.listingId,
    price_e8s: request.priceE8s,
    access_principal: request.accessPrincipal
  };
}

function normalizeMarketOrder(raw: RawMarketOrder, provider: WalletProvider, approveBlockIndex: string | null, approvedAllowanceE8s: string): MarketPurchaseResult {
  return {
    provider,
    approveBlockIndex,
    approvedAllowanceE8s,
    orderId: raw.order_id,
    listingId: raw.listing_id,
    databaseId: raw.database_id,
    buyerPrincipal: raw.buyer_principal,
    sellerPrincipal: raw.seller_principal,
    priceE8s: raw.price_e8s.toString(),
    ledgerBlockIndex: raw.ledger_block_index.toString(),
    createdAtMs: raw.created_at_ms.toString()
  };
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

function isRawMarketOrder(value: unknown): value is RawMarketOrder {
  if (!isObject(value)) return false;
  return (
    typeof Reflect.get(value, "order_id") === "string" &&
    typeof Reflect.get(value, "listing_id") === "string" &&
    typeof Reflect.get(value, "database_id") === "string" &&
    typeof Reflect.get(value, "buyer_principal") === "string" &&
    typeof Reflect.get(value, "seller_principal") === "string" &&
    typeof Reflect.get(value, "price_e8s") === "bigint" &&
    typeof Reflect.get(value, "ledger_block_index") === "bigint" &&
    typeof Reflect.get(value, "created_at_ms") === "bigint"
  );
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
