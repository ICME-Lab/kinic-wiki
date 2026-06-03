import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const page = readFileSync(new URL("../app/cycles/page.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/cycles/cycles-client.tsx", import.meta.url), "utf8");
const appHeader = readFileSync(new URL("../app/app-header.tsx", import.meta.url), "utf8");
const appSession = readFileSync(new URL("../app/app-session-provider.tsx", import.meta.url), "utf8");
const wallet = readFileSync(new URL("../lib/cycles-wallet.ts", import.meta.url), "utf8");
const url = readFileSync(new URL("../lib/cycles-url.ts", import.meta.url), "utf8");
const idl = readFileSync(new URL("../lib/vfs-idl.ts", import.meta.url), "utf8");
const vfsClient = readFileSync(new URL("../lib/vfs-client.ts", import.meta.url), "utf8");
const connectOisy = sliceBetween(wallet, "export async function connectOisyWallet", "export async function connectPlugWallet");
const connectPlug = sliceBetween(wallet, "export async function connectPlugWallet", "export async function getConnectedWalletKinicBalance");
const walletBalance = sliceBetween(wallet, "export async function getConnectedWalletKinicBalance", "export async function purchaseCyclesWithOisy");
const purchaseOisy = sliceBetween(wallet, "export async function purchaseCyclesWithOisy", "export async function purchaseCyclesWithPlug");
const purchasePlug = sliceBetween(wallet, "export async function purchaseCyclesWithPlug", "function approveParams");

assert.match(page, /\/cycles/);
assert.doesNotMatch(page, /canister_id \?\? params\.canisterId/);
assert.doesNotMatch(page, /amount_e8s \?\? params\.amountE8s/);
assert.doesNotMatch(page, /params\.kinic|initialKinic/);
assert.match(page, /parseDatabaseStatus\(first\(params\.status\)\)/);
assert.match(client, /purchaseCyclesWithOisy/);
assert.match(client, /purchaseCyclesWithPlug/);
assert.match(client, /useAppSession/);
assert.match(appHeader, /pathname !== "\/" && pathname !== "\/cycles"/);
assert.match(appHeader, /Database cycles purchase/);
assert.match(appHeader, /<WalletControls/);
assert.match(appHeader, /<AuthControls/);
assert.match(appSession, /function safeSessionStorageGet\(key: string\): string \| null/);
assert.match(appSession, /function safeSessionStorageSet\(key: string, value: string\): void/);
assert.match(appSession, /function safeSessionStorageRemove\(key: string\): void/);
assert.match(appSession, /safeSessionStorageSet\(\s*WALLET_SESSION_KEY,/);
assert.match(appSession, /useState<ConnectedKinicWallet \| null>\(\(\) => readStoredWallet\(\)\)/);
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
assert.match(client, /params\.set\("funding", "success"\)/);
assert.match(client, /params\.set\("database_id", databaseId\)/);
assert.match(client, /params\.set\("provider", provider\)/);
assert.match(client, /params\.set\("kinic", kinic\)/);
assert.match(client, /params\.set\("cycles", cycles\)/);
assert.match(client, /const purchaseDisabled = !selectedProvider \|\| Boolean\(error\) \|\| Boolean\(amountError\) \|\| busy/);
assert.doesNotMatch(client, /function WalletConnect/);
assert.match(client, /onClick=\{\(\) => void purchase\(\)\}/);
assert.doesNotMatch(client, /onCycles/);
assert.match(client, /parseKinicAmountE8sInput/);
assert.match(client, /parseCyclesTarget/);
assert.doesNotMatch(client, /initialKinic/);
assert.match(client, /useState\("1"\)/);
assert.match(client, /KINIC/);
assert.doesNotMatch(client, /Login with Internet Identity|Notify identity/);
assert.match(wallet, /export async function connectOisyWallet/);
assert.match(wallet, /export async function connectPlugWallet/);
assert.match(wallet, /class CyclesPurchaseIcrcWallet extends IcrcWallet/);
assert.match(wallet, /async callCyclesPurchase\(params: IcrcCallCanisterRequestParams\)/);
assert.match(wallet, /export async function purchaseCyclesWithOisy\(request: CyclesPurchaseRequest, connection: ConnectedOisyWallet\)/);
assert.match(wallet, /export async function purchaseCyclesWithPlug\(request: CyclesPurchaseRequest, connection: ConnectedPlugWallet\)/);
assert.match(connectOisy, /openOisyWallet\(\)/);
assert.match(connectOisy, /wallet\.accounts\(\)/);
assert.match(wallet, /async function safeDisconnectOisyWallet\(wallet: CyclesPurchaseIcrcWallet\): Promise<void>/);
assert.match(wallet, /Cleanup failures must not hide connect, approve, or purchase errors\./);
assert.match(connectOisy, /safeDisconnectOisyWallet\(wallet\)/);
assert.doesNotMatch(connectOisy, /getCyclesBillingConfig|previewDatabaseCyclesPurchase|whitelist/);
assert.match(connectPlug, /plug\.requestConnect\(\{\s*host:/);
assert.doesNotMatch(connectPlug, /getCyclesBillingConfig|previewDatabaseCyclesPurchase|whitelist/);
assert.match(walletBalance, /getCyclesBillingConfig\(canisterId\)/);
assert.match(walletBalance, /getLedgerBalance\(config\.kinicLedgerCanisterId, connectedWalletPrincipal\(wallet\)\)/);
assert.match(purchaseOisy, /prepareCyclesPurchase\(request, connection\.owner\)/);
assert.match(purchasePlug, /prepareCyclesPurchase\(request, connection\.principal\)/);
assert.match(purchasePlug, /whitelist: \[request\.canisterId, prepared\.kinicLedgerCanisterId\]/);
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
assert.match(wallet, /function allowanceForCyclesPurchase\(amountE8s: bigint, transferFeeE8s: bigint\)/);
assert.match(wallet, /approved allowance exceeds u64::MAX/);
assert.match(wallet, /cycles purchase amount exceeds canister limit/);
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
assert.match(wallet, /assertConfiguredCyclesCanister\(request\.canisterId\)/);
assert.match(purchaseOisy, /openOisyWallet\(\)/);
assert.match(purchaseOisy, /account\.owner !== connection\.owner/);
assert.match(purchaseOisy, /safeDisconnectOisyWallet\(wallet\)/);
assert.match(purchaseOisy, /purchaseAfterApprove/);
assert.match(wallet, /oisyCallCyclesPurchase\(wallet, connection\.owner, request\.canisterId, prepared\.purchaseRequest\)/);
assert.match(wallet, /sender: owner/);
assert.match(wallet, /wallet response sender mismatch/);
assert.match(wallet, /contentMap|Certificate|requestIdOf/);
assert.match(wallet, /purchase_database_cycles\(prepared\.purchaseRequest\)/);
assert.match(wallet, /encodeCyclesPurchaseArgs\(request: DatabaseCyclesPurchaseRequest\)/);
assert.match(wallet, /whitelist: \[request\.canisterId, prepared\.kinicLedgerCanisterId\]/);
assert.match(wallet, /function defaultAccount\(owner: string\): LedgerAccount/);
assert.match(wallet, /DEFAULT_OISY_SIGNER_URL/);
assert.match(wallet, /cycles purchase failed after approval; \$\{approvalText\}/);
assert.match(wallet, /approval remains without expiry/);
assert.match(wallet, /class CyclesPurchaseAfterApproveError extends Error/);
assert.match(client, /purchased cycles/);
assert.match(client, /purchasedCycles/);
assert.match(client, /approved allowance/);
assert.doesNotMatch(client, /Wallet approval uses the DB cycle amount plus the ledger transfer fee/);
assert.match(client, /transfer fee/);
assert.match(client, /A newly created database is pending, not active, until this first cycles purchase completes\./);
assert.match(client, /databaseStatus === "pending"/);
assert.match(client, /Any authenticated wallet can purchase non-refundable cycles/);
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
        refreshWalletBalance: async () => undefined,
        wallet: null,
        walletBalanceError: null,
        walletBusyProvider: null
      })
    },
    "@/lib/cycles-url": {
      parseKinicAmountE8sInput: () => 100n,
      parseCyclesTarget: () => ({ databaseId: "db_alpha" })
    },
    "@/lib/cycles-wallet": {
      purchaseCyclesWithOisy: async () => ({}),
      purchaseCyclesWithPlug: async () => ({})
    },
    "@/lib/kinic-amount": { formatTokenAmountFromE8s: (value) => String(value) }
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
