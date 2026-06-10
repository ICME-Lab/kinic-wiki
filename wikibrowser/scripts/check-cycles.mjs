import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const page = readFileSync(new URL("../app/cycles/page.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/cycles/cycles-client.tsx", import.meta.url), "utf8");
const dashboardHome = readFileSync(new URL("../app/dashboard/dashboard-home-client.tsx", import.meta.url), "utf8");
const appHeader = readFileSync(new URL("../app/app-header.tsx", import.meta.url), "utf8");
const appSession = readFileSync(new URL("../app/app-session-provider.tsx", import.meta.url), "utf8");
const wallet = readFileSync(new URL("../lib/kinic-wallet.ts", import.meta.url), "utf8");
const cycles = readFileSync(new URL("../lib/cycles.ts", import.meta.url), "utf8");
const url = readFileSync(new URL("../lib/cycles-url.ts", import.meta.url), "utf8");
const idl = readFileSync(new URL("../lib/vfs-idl.ts", import.meta.url), "utf8");
const vfsClient = readFileSync(new URL("../lib/vfs-client.ts", import.meta.url), "utf8");
const connectOisy = sliceBetween(wallet, "export async function connectOisyWallet", "export async function connectPlugWallet");
const connectPlug = sliceBetween(wallet, "export async function connectPlugWallet", "export async function getConnectedWalletKinicBalance");
const walletBalance = sliceBetween(wallet, "export async function getConnectedWalletKinicBalance", "export async function purchaseCyclesWithOisy");
const purchaseOisy = sliceBetween(wallet, "export async function purchaseCyclesWithOisy", "export async function purchaseCyclesWithPlug");
const purchasePlug = sliceBetween(wallet, "export async function purchaseCyclesWithPlug", "export async function depositKinicBalanceWithOisy");
const kinicDepositOisy = sliceBetween(wallet, "export async function depositKinicBalanceWithOisy", "export async function depositKinicBalanceWithPlug");
const kinicDepositPlug = sliceBetween(wallet, "export async function depositKinicBalanceWithPlug", "export async function purchaseMarketAccessWithOisy");
const marketPurchaseOisy = sliceBetween(wallet, "export async function purchaseMarketAccessWithOisy", "export async function purchaseMarketAccessWithPlug");
const marketPurchasePlug = sliceBetween(wallet, "export async function purchaseMarketAccessWithPlug", "function approveParams");
const kinicFundingClient = sliceBetween(client, 'if (paymentSource === "kinic")', "if (!wallet || !selectedProvider) return;");

assert.match(page, /\/cycles/);
assert.doesNotMatch(page, /canister_id \?\? params\.canisterId/);
assert.doesNotMatch(page, /amount_e8s \?\? params\.amountE8s/);
assert.doesNotMatch(page, /params\.kinic|initialKinic/);
assert.match(page, /parseDatabaseStatus\(first\(params\.status\)\)/);
assert.doesNotMatch(page, /value === "deleted"/);
assert.match(client, /purchaseCyclesWithOisy/);
assert.match(client, /purchaseCyclesWithPlug/);
assert.match(client, /kinicFundDatabaseCycles/);
assert.doesNotMatch(client, /fundDatabaseCyclesWithKinicBalanceAndOisy|fundDatabaseCyclesWithKinicBalanceAndPlug/);
assert.match(client, /Payment source/);
assert.match(client, /listDatabasesAuthenticated/);
assert.match(client, /databaseCyclesHref/);
assert.match(client, /databaseCyclesView/);
assert.match(client, /Select a database/);
assert.match(client, /router\.replace\(databaseCyclesHref\(nextDatabase\)\)/);
assert.match(client, /Login with Internet Identity to select a database\./);
assert.match(client, /No fundable databases linked to this principal\./);
assert.match(client, /const hasNoFundableDatabases = principal !== null && databaseLoadState === "ready" && fundableDatabases\.length === 0;/);
assert.match(client, /const targetError = typeof parsedTarget === "string" && !hasNoFundableDatabases \? parsedTarget : null;/);
assert.match(client, /typeof parsedTarget === "string" \|\|/);
assert.match(client, /Wallet KINIC/);
assert.match(client, /KINIC balance/);
assert.match(client, /useAppSession/);
assert.match(client, /authClient\.getIdentity\(\)/);
assert.match(client, /Login with Internet Identity to use KINIC balance/);
assert.match(kinicFundingClient, /getCyclesBillingConfig\(canisterId\)/);
assert.match(kinicFundingClient, /cyclesForPaymentAmountE8s\(parsedAmount, BigInt\(config\.cyclesPerKinic\)\)/);
assert.match(cycles, /export function cyclesForPaymentAmountE8s\(amountE8s: bigint, cyclesPerKinic: bigint\): bigint/);
assert.match(cycles, /\(amountE8s \* cyclesPerKinic\) \/ kinicBaseUnitsPerToken\(\)/);
assert.doesNotMatch(kinicFundingClient, /,\s*"0"\s*\)/);
assert.match(vfsClient, /export async function kinicFundDatabaseCycles/);
assert.match(dashboardHome, /type FundingProvider = "oisy" \| "plug" \| "ii"/);
assert.match(dashboardHome, /provider === "ii" \? "funded" : "purchased"/);
assert.match(dashboardHome, /Internet Identity/);
assert.match(dashboardHome, /isFundingProvider/);
assert.match(appHeader, /const isCycles = pathname === "\/cycles"/);
assert.match(appHeader, /title="Console"/);
assert.doesNotMatch(appHeader, /<Link[\s\S]*Database dashboard/);
assert.match(appHeader, /<WalletControls/);
assert.doesNotMatch(appHeader, /<AuthControls/);
assert.match(appSession, /function safeSessionStorageGet\(key: string\): string \| null/);
assert.match(appSession, /function safeSessionStorageSet\(key: string, value: string\): void/);
assert.match(appSession, /function safeSessionStorageRemove\(key: string\): void/);
assert.match(appSession, /safeSessionStorageSet\(\s*WALLET_SESSION_KEY,/);
assert.match(appSession, /const \[wallet, setWallet\] = useState<ConnectedKinicWallet \| null>\(null\)/);
assert.match(appSession, /readStoredWallet\(\)/);
assert.doesNotMatch(client, /AuthClient|AUTH_CLIENT_CREATE_OPTIONS|authLoginOptions|notifyPrincipal|notifyIdentity/);
assert.doesNotMatch(client, /connectOisyWallet|connectPlugWallet/);
assert.match(client, /Purchase cycles with OISY/);
assert.match(client, /Purchase cycles with Plug/);
assert.match(client, /router\.replace\(cyclesPurchaseSuccessHref\(\{/);
assert.match(client, /databaseId: parsedTarget\.databaseId/);
assert.match(client, /kinic: formatTokenAmountFromE8s\(result\.paymentAmountE8s\)/);
assert.match(client, /provider: result\.provider/);
assert.match(client, /function cyclesPurchaseSuccessHref/);
assert.match(client, /return `\/dashboard\?\$\{params\.toString\(\)\}`/);
assert.match(client, /params\.set\("funding", "success"\)/);
assert.match(client, /params\.set\("database_id", databaseId\)/);
assert.match(client, /params\.set\("provider", provider\)/);
assert.match(client, /params\.set\("kinic", kinic\)/);
assert.match(client, /params\.set\("cycles", cycles\)/);
assert.match(client, /paymentSource === "wallet" \? !selectedProvider \|\| oisyLocalUnavailable : authLoading \|\| !authClient \|\| kinicBalancePendingDisabled/);
assert.match(client, /LOCAL_OISY_UNAVAILABLE_MESSAGE/);
assert.match(client, /Wallet KINIC uses ledger wallet approval\. KINIC balance uses App balance; direct ledger transfers are not credited to App balance\./);
assert.match(client, /disabled=\{resolvedDatabaseStatus === "pending"\}/);
assert.doesNotMatch(client, /function WalletConnect/);
assert.match(client, /onClick=\{\(\) => void purchase\(\)\}/);
assert.doesNotMatch(client, /onCycles/);
assert.match(client, /parseKinicAmountE8sInput/);
assert.match(client, /parseCyclesTarget/);
assert.doesNotMatch(client, /initialKinic/);
assert.match(client, /useState\("1"\)/);
assert.match(client, /KINIC/);
assert.doesNotMatch(client, /Notify identity/);
assert.match(wallet, /export async function connectOisyWallet/);
assert.match(wallet, /export async function connectPlugWallet/);
assert.match(wallet, /class KinicIcrcWallet extends IcrcWallet/);
assert.match(wallet, /async callCanister\(params: IcrcCallCanisterRequestParams\)/);
assert.match(wallet, /export async function purchaseCyclesWithOisy\(request: CyclesPurchaseRequest, connection: ConnectedOisyWallet\)/);
assert.match(wallet, /export async function purchaseCyclesWithPlug\(request: CyclesPurchaseRequest, connection: ConnectedPlugWallet\)/);
assert.match(wallet, /export async function depositKinicBalanceWithOisy\(request: KinicDepositRequest, connection: ConnectedOisyWallet\)/);
assert.match(wallet, /export async function depositKinicBalanceWithPlug\(request: KinicDepositRequest, connection: ConnectedPlugWallet\)/);
assert.doesNotMatch(wallet, /export async function fundDatabaseCyclesWithKinicBalanceAndOisy/);
assert.doesNotMatch(wallet, /export async function fundDatabaseCyclesWithKinicBalanceAndPlug/);
assert.match(wallet, /export async function purchaseMarketAccessWithOisy\(request: MarketPurchaseRequest, connection: ConnectedOisyWallet\)/);
assert.match(wallet, /export async function purchaseMarketAccessWithPlug\(request: MarketPurchaseRequest, connection: ConnectedPlugWallet\)/);
assert.match(connectOisy, /openOisyWallet\(\)/);
assert.match(connectOisy, /wallet\.accounts\(\)/);
assert.match(wallet, /async function safeDisconnectOisyWallet\(wallet: KinicIcrcWallet\): Promise<void>/);
assert.match(wallet, /Cleanup failures must not hide connect, approve, or purchase errors\./);
assert.match(connectOisy, /safeDisconnectOisyWallet\(wallet\)/);
assert.doesNotMatch(connectOisy, /getCyclesBillingConfig|previewDatabaseCyclesPurchase|whitelist/);
assert.match(connectPlug, /connectPlug\(plug\)/);
assert.doesNotMatch(connectPlug, /getCyclesBillingConfig|previewDatabaseCyclesPurchase|whitelist/);
assert.match(wallet, /async function connectPlug\(plug: PlugWallet, whitelist\?: string\[\]\): Promise<boolean>/);
assert.match(wallet, /await plug\.disconnect\?\.\(\)/);
assert.match(wallet, /return plug\.requestConnect\(\{ whitelist, host \}\)/);
assert.match(walletBalance, /getCyclesBillingConfig\(canisterId\)/);
assert.match(walletBalance, /getLedgerBalance\(config\.kinicLedgerCanisterId, connectedWalletPrincipal\(wallet\)\)/);
assert.match(purchaseOisy, /prepareCyclesPurchase\(request, connection\.owner\)/);
assert.match(purchasePlug, /prepareCyclesPurchase\(request, connection\.principal\)/);
assert.match(purchasePlug, /connectPlug\(plug, \[request\.canisterId, prepared\.kinicLedgerCanisterId\]\)/);
assert.match(wallet, /icrc2_approve/);
assert.match(wallet, /icrc1_balance_of/);
assert.doesNotMatch(purchasePlug, /JSON\.stringify\(approve\.Err\)/);
assert.match(purchasePlug, /formatLedgerApproveError\(approve\.Err\)/);
assert.match(wallet, /icrc2_allowance/);
assert.doesNotMatch(wallet, /icrc1_fee/);
assert.match(wallet, /async function prepareCyclesPurchase/);
assert.match(wallet, /icrc2_allowance: idl\.Func\(\[allowanceArgs\], \[allowance\], \["query"\]\)/);
assert.match(wallet, /icrc2_approve: idl\.Func\(\[approveArgs\], \[idl\.Variant\(\{ Ok: idl\.Nat, Err: approveError \}\)\], \[\]\)/);
assert.doesNotMatch(wallet, /purchaseDatabaseCyclesFrom|notifyIdentity|wallet as unknown|OisyCanisterCaller/);
assert.doesNotMatch(wallet, /previewDatabaseCyclesPurchase/);
assert.match(wallet, /KINIC_LEDGER_FEE_E8S/);
assert.match(wallet, /MAX_CANISTER_I64/);
assert.match(wallet, /MAX_LEDGER_U64/);
assert.match(wallet, /function allowanceForKinicTransfer\(amountE8s: bigint, transferFeeE8s: bigint\)/);
assert.match(wallet, /approved allowance exceeds u64::MAX/);
assert.match(cycles, /cycles purchase amount exceeds canister limit/);
assert.match(wallet, /KINIC amount e8s exceeds canister limit/);
assert.doesNotMatch(wallet, /function paymentAmountE8sForCycles/);
assert.match(wallet, /payment_amount_e8s: paymentAmountE8s/);
assert.match(wallet, /min_expected_cycles: minExpectedCycles/);
assert.doesNotMatch(wallet, /expected_config_version/);
assert.match(wallet, /amount_cycles/);
assert.match(wallet, /currentAllowance: LedgerAllowance/);
assert.match(wallet, /approvalRequired: boolean/);
assert.match(wallet, /approvalExpiresAt: bigint \| null/);
assert.match(wallet, /function allowanceIsUsable\(allowance: LedgerAllowance, requiredAllowanceE8s: bigint, currentTimeNs: bigint\): boolean/);
assert.match(wallet, /function allowanceExpiresAt\(allowance: LedgerAllowance\): bigint \| null/);
assert.match(wallet, /if \(prepared\.approvalRequired\) \{/);
assert.match(wallet, /approveParams\(request\.canisterId, prepared\.approvedAllowanceE8s, prepared\.currentAllowance\.allowance, prepared\.expiresAt\)/);
assert.match(wallet, /rawApproveArgs\(request\.canisterId, prepared\.approvedAllowanceE8s, prepared\.currentAllowance\.allowance, prepared\.expiresAt\)/);
assert.match(wallet, /expected_allowance: \[expectedAllowanceE8s\]/);
assert.match(wallet, /expires_at: \[expiresAt\]/);
assert.match(wallet, /approveBlockIndex: string \| null/);
assert.match(wallet, /APPROVE_EXPIRES_IN_MS = 30 \* 60 \* 1000/);
assert.match(wallet, /assertConfiguredCyclesCanister\(canisterId\)/);
assert.match(purchaseOisy, /openOisyWallet\(\)/);
assert.match(purchaseOisy, /account\.owner !== connection\.owner/);
assert.match(purchaseOisy, /safeDisconnectOisyWallet\(wallet\)/);
assert.match(purchaseOisy, /callAfterApprove/);
assert.match(kinicDepositOisy, /callAfterApprove/);
assert.match(wallet, /oisyCallCyclesPurchase\(wallet, connection\.owner, request\.canisterId, prepared\.purchaseRequest\)/);
assert.match(wallet, /oisyCallKinicDeposit\(wallet, connection\.owner, request\.canisterId, prepared\.depositRequest\)/);
assert.doesNotMatch(wallet, /oisyCallKinicFundDatabaseCycles/);
assert.match(wallet, /oisyCallMarketPurchase\(wallet, connection\.owner, request\.canisterId, rawMarketPurchaseRequest\(request\)\)/);
assert.match(wallet, /sender: owner/);
assert.match(wallet, /wallet response sender mismatch/);
assert.match(wallet, /contentMap|Certificate|requestIdOf/);
assert.match(wallet, /purchase_database_cycles\(prepared\.purchaseRequest\)/);
assert.match(kinicDepositPlug, /kinic_deposit_balance\(prepared\.depositRequest\)/);
assert.match(marketPurchasePlug, /market_purchase_access\(rawMarketPurchaseRequest\(request\)\)/);
assert.match(wallet, /encodeCyclesPurchaseArgs\(request: DatabaseCyclesPurchaseRequest\)/);
assert.match(wallet, /encodeKinicDepositArgs\(request: KinicDepositCanisterRequest\)/);
assert.doesNotMatch(wallet, /encodeKinicFundDatabaseCyclesArgs/);
assert.match(wallet, /encodeMarketPurchaseArgs\(request: MarketPurchaseCanisterRequest\)/);
assert.match(wallet, /method: "market_purchase_access"/);
assert.doesNotMatch(wallet, /method: "kinic_fund_database_cycles"/);
assert.match(wallet, /connectPlug\(plug, \[request\.canisterId, prepared\.kinicLedgerCanisterId\]\)/);
assert.match(marketPurchasePlug, /connectPlug\(plug, \[request\.canisterId\]\)/);
assert.doesNotMatch(marketPurchaseOisy, /approve\(/);
assert.doesNotMatch(marketPurchasePlug, /icrc2_approve/);
assert.match(wallet, /function defaultAccount\(owner: string\): LedgerAccount/);
assert.match(wallet, /DEFAULT_OISY_SIGNER_URL/);
assert.match(wallet, /KINIC canister call failed after approval; \$\{approvalText\}/);
assert.match(wallet, /approval remains without expiry/);
assert.match(wallet, /class KinicAfterApproveError extends Error/);
assert.match(client, /purchased cycles/);
assert.match(client, /purchasedCycles/);
assert.match(client, /approved allowance/);
assert.doesNotMatch(client, /formatTokenAmountFromE8s\(result\.paymentAmountE8s\)\} KINIC/);
assert.doesNotMatch(client, /Wallet approval uses the DB cycle amount plus the ledger transfer fee/);
assert.match(client, /transfer fee/);
assert.match(client, /A newly created database is pending, not active, until this first cycles purchase completes\./);
assert.match(client, /resolvedDatabaseStatus === "pending"/);
assert.match(client, /OISY hosted signer is unavailable for local replica|LOCAL_OISY_UNAVAILABLE_MESSAGE/);
assert.doesNotMatch(client, new RegExp("extractCycles" + "RepairTarget"));
assert.doesNotMatch(client, new RegExp("saveCycles" + "Repair" + "Record"));
assert.doesNotMatch(
  client,
  new RegExp("window\\.local" + "Storage\\.setItem\\(cycles" + "Repair" + "RecordKey"),
);
assert.doesNotMatch(client, new RegExp("Billing authority " + "repair " + "required"));
assert.doesNotMatch(client, /withdraw KINIC|database balance/);
assert.doesNotMatch(client, /cycles canister does not match NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
assert.match(url, /KINIC_DECIMALS/);
assert.match(url, /MAX_CANISTER_I64/);
assert.match(url, /kinicBaseUnitsPerToken/);
assert.match(url, /KINIC must be a positive number with up to \$\{KINIC_DECIMALS\} decimals/);
assert.match(url, /KINIC amount e8s must be <= i64::MAX/);
assert.match(url, /database_id is required/);
assert.doesNotMatch(url, /params\.set\("amount_e8s"/);
assert.match(idl, /get_cycles_billing_config/);
assert.doesNotMatch(idl, /preview_database_cycles_purchase/);
assert.match(idl, /purchase_database_cycles/);
assert.match(idl, /icrc10_supported_standards/);
assert.match(idl, /icrc21_canister_call_consent_message/);
assert.doesNotMatch(idl, /purchase_database_cycles_from/);
assert.match(vfsClient, /export async function getCyclesBillingConfig/);
assert.doesNotMatch(vfsClient, /previewDatabaseCyclesPurchase/);
assert.doesNotMatch(vfsClient, /purchaseDatabaseCyclesFrom/);

const cyclesUrlModule = loadTsModule("../lib/cycles-url.ts", {
  "@/lib/cycles": {
    KINIC_DECIMALS: 8,
    MAX_CANISTER_I64: 9_223_372_036_854_775_807n,
    kinicBaseUnitsPerToken: () => 100_000_000n
  }
});
const cyclesModule = loadTsModule("../lib/cycles.ts", {});
assert.equal(cyclesModule.cyclesForPaymentAmountE8s(100_000_000n, 234_500_000_000n), 234_500_000_000n);
assert.throws(() => cyclesModule.cyclesForPaymentAmountE8s(1n, 1n), /KINIC amount is too small for a cycles purchase/);
assert.throws(
  () => cyclesModule.cyclesForPaymentAmountE8s(9_223_372_036_854_775_807n, 200_000_000n),
  /cycles purchase amount exceeds canister limit/
);
assert.equal(cyclesUrlModule.parseCyclesTarget(new URLSearchParams("database_id=db_ok-1")).databaseId, "db_ok-1");
assert.equal(cyclesUrlModule.parseCyclesTarget(new URLSearchParams("databaseId=dbLegacy")).databaseId, "dbLegacy");
assert.equal(cyclesUrlModule.parseCyclesTarget(new URLSearchParams()), "database_id is required");
assert.equal(cyclesUrlModule.parseCyclesTarget(new URLSearchParams("database_id=bad/path")), "database_id contains unsupported characters");
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("1"), 100_000_000n);
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("0.00000001"), 1n);
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("1.23456789"), 123_456_789n);
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("0"), "KINIC amount must be positive");
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("1.000000001"), "KINIC must be a positive number with up to 8 decimals");
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("92233720368.54775807"), 9_223_372_036_854_775_807n);
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("92233720368.54775808"), "KINIC amount e8s must be <= i64::MAX");

const cyclesStateModule = loadTsModule("../lib/cycles-state.ts", {
  "@/lib/cycles": { formatCycles: (value) => value.toString() }
});
assert.equal(cyclesStateModule.databaseCyclesHref({ databaseId: "db_ok-1", status: "active" }), "/cycles?database_id=db_ok-1&status=active");
assert.equal(cyclesStateModule.databaseCyclesView({ databaseId: "db_archived", role: "owner", status: "archived", cyclesBalance: "0", cyclesSuspendedAtMs: null }, { minUpdateCycles: "1" }).writeCyclesAvailable, false);
assert.equal(cyclesStateModule.databaseCyclesView({ databaseId: "db_archived", role: "owner", status: "archived", cyclesBalance: "0", cyclesSuspendedAtMs: null }, { minUpdateCycles: "1" }).purchaseAvailable, false);

const clientModule = loadTsModule(
  "../app/cycles/cycles-client.tsx",
  {
    "next/link": { __esModule: true, default: () => null },
    "next/navigation": { useRouter: () => ({ replace: () => undefined }) },
    "lucide-react": {
      CheckCircle2: () => null,
      CircleAlert: () => null,
      Info: () => null,
      PlugZap: () => null,
      Wallet: () => null
    },
    "react": {
      useEffect: () => undefined,
      useMemo: (run) => run(),
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined]
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "@/app/app-session-provider": {
      useAppSession: () => ({
        authClient: { getIdentity: () => ({}) },
        authLoading: false,
        login: async () => undefined,
        principal: "ii-principal",
        refreshWalletBalance: async () => undefined,
        wallet: null,
        walletBalanceError: null,
        walletBusyProvider: null
      })
    },
    "@/components/admin-shell": { AdminContent: ({ children }) => children },
    "@/components/admin-ui": {
      AdminField: () => null,
      AdminNotice: () => null,
      AdminPanel: ({ children }) => children,
      AdminPageHeader: () => null
    },
    "@/lib/cycles-url": {
      parseKinicAmountE8sInput: () => 100n,
      parseCyclesTarget: () => ({ databaseId: "db_alpha" })
    },
    "@/lib/cycles-state": {
      databaseCyclesHref: (database) => `/cycles?database_id=${database.databaseId}&status=${database.status}`,
      databaseCyclesView: (database) => ({ purchaseAvailable: database.status === "active" || database.status === "pending", summary: database.status })
    },
    "@/lib/ic-host": {
      configuredIcHost: () => "https://icp0.io",
      isLocalIcHost: () => false,
      LOCAL_OISY_UNAVAILABLE_MESSAGE: "OISY hosted signer is unavailable for local replica"
    },
    "@/lib/kinic-wallet": {
      purchaseCyclesWithOisy: async () => ({}),
      purchaseCyclesWithPlug: async () => ({})
    },
    "@/lib/kinic-amount": { formatTokenAmountFromE8s: (value) => String(value) },
    "@/lib/cycles": {
      cyclesForPaymentAmountE8s: (amountE8s, cyclesPerKinic) => (amountE8s * cyclesPerKinic) / 100_000_000n,
      MAX_CANISTER_I64: 9_223_372_036_854_775_807n,
      kinicBaseUnitsPerToken: () => 100_000_000n
    },
    "@/lib/vfs-client": {
      getCyclesBillingConfig: async () => ({ cyclesPerKinic: "1000" }),
      kinicFundDatabaseCycles: async () => ({
        amountCycles: "1000",
        databaseBalanceCycles: "1000",
        kinicBalanceE8s: "0",
        paymentAmountE8s: "100"
      }),
      listDatabasesAuthenticated: async () => []
    }
  }
);

console.log("Cycles checks OK");

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `${startText} not found`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `${endText} not found`);
  return source.slice(start, end);
}

function loadTsModule(relativePath, mocks, append = "") {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(`${source}\n${append}`, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const commonjsModule = { exports: {} };
  const context = {
    Buffer,
    Date,
    TextEncoder,
    Uint8Array,
    URLSearchParams,
    console,
    exports: commonjsModule.exports,
    module: commonjsModule,
    process: { env: {} },
    require: (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      throw new Error(`unexpected module import: ${id}`);
    }
  };
  vm.runInNewContext(transpiled, context, { filename: relativePath });
  return Object.assign(commonjsModule.exports, { __context: context });
}
