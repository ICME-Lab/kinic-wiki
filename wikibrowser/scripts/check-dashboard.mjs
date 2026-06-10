import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const dashboardClient = readFileSync(new URL("../app/dashboard/dashboard-client.tsx", import.meta.url), "utf8");
const rootReadme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const dashboardIndex = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");
const dashboardRoute = readFileSync(new URL("../app/dashboard/project/[databaseId]/page.tsx", import.meta.url), "utf8");
const dashboardUi = readFileSync(new URL("../app/dashboard/dashboard-ui.tsx", import.meta.url), "utf8");
const dashboardActionButton = readFileSync(new URL("../app/dashboard/action-button.tsx", import.meta.url), "utf8");
const dashboardAccessControl = readFileSync(new URL("../app/dashboard/access-control.ts", import.meta.url), "utf8");
const dashboardDangerZone = readFileSync(new URL("../app/dashboard/database-danger-zone.tsx", import.meta.url), "utf8");
const dashboardMemberTable = readFileSync(new URL("../app/dashboard/member-table.tsx", import.meta.url), "utf8");
const vfsIdl = readFileSync(new URL("../lib/vfs-idl.ts", import.meta.url), "utf8");
const vfsClient = readFileSync(new URL("../lib/vfs-client.ts", import.meta.url), "utf8");
const createDatabaseDialog = readFileSync(new URL("../app/create-database-dialog.tsx", import.meta.url), "utf8");
const adminHeader = readFileSync(new URL("../components/admin-header.tsx", import.meta.url), "utf8");
const adminShell = readFileSync(new URL("../components/admin-shell.tsx", import.meta.url), "utf8");
const appHeader = readFileSync(new URL("../app/app-header.tsx", import.meta.url), "utf8");
const appSession = readFileSync(new URL("../app/app-session-provider.tsx", import.meta.url), "utf8");
const profilePage = readFileSync(new URL("../app/profile/page.tsx", import.meta.url), "utf8");
const profileClient = readFileSync(new URL("../app/profile/profile-client.tsx", import.meta.url), "utf8");
const rootLayout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const cliPage = readFileSync(new URL("../app/cli/page.tsx", import.meta.url), "utf8");
const cliGuideBlock = readFileSync(new URL("../app/cli/cli-guide-block.tsx", import.meta.url), "utf8");
const marketplaceClient = readFileSync(new URL("../app/marketplace/marketplace-client.tsx", import.meta.url), "utf8");
const cyclesClient = readFileSync(new URL("../app/cycles/cycles-client.tsx", import.meta.url), "utf8");
const homeUi = readFileSync(new URL("../app/home-ui.tsx", import.meta.url), "utf8");
const homePage = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const homeHeroSection = homePage.slice(homePage.indexOf("<section"), homePage.indexOf("</section>") + "</section>".length);
const dashboardHomeClient = readFileSync(new URL("../app/dashboard/dashboard-home-client.tsx", import.meta.url), "utf8");
const cyclesState = readFileSync(new URL("../lib/cycles-state.ts", import.meta.url), "utf8");
const apiErrors = readFileSync(new URL("../lib/api-errors.ts", import.meta.url), "utf8");
const wikiLayout = readFileSync(new URL("../app/db/[databaseId]/layout.tsx", import.meta.url), "utf8");
const canisterEntrypoint = readFileSync(new URL("../../crates/vfs_canister/src/lib.rs", import.meta.url), "utf8");
const ingestPanel = readFileSync(new URL("../components/ingest-panel.tsx", import.meta.url), "utf8");
const ingestTriggerRoute = readFileSync(new URL("../app/api/url-ingest/trigger/route.ts", import.meta.url), "utf8");
const sourceRunRoute = readFileSync(new URL("../app/api/source/run/route.ts", import.meta.url), "utf8");
const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const urlIngest = readFileSync(new URL("../lib/url-ingest.ts", import.meta.url), "utf8");
const wikiRoute = readFileSync(new URL("../app/db/[databaseId]/[[...segments]]/page.tsx", import.meta.url), "utf8");
const wikiBrowser = readFileSync(new URL("../components/wiki-browser.tsx", import.meta.url), "utf8");
const wranglerConfig = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const ownerPanelSource = dashboardUi.slice(dashboardUi.indexOf("export function OwnerPanel"), dashboardUi.indexOf("export function DashboardSettingsPanel"));
const marketListingsPanelSource = dashboardUi.slice(dashboardUi.indexOf("export function MarketListingsPanel"), dashboardUi.indexOf("export function BuyersPanel"));

assert.match(homeUi, /href=\{`\/dashboard\/project\/\$\{encodeURIComponent\(database\.databaseId\)\}`\}/);
assert.match(adminHeader, /export function AdminHeader/);
assert.match(adminHeader, /titleAction\?: ReactNode/);
assert.match(adminHeader, /titleAction \? <div className="shrink-0">/);
assert.match(adminHeader, /import Link from "next\/link";/);
assert.match(adminHeader, /href="\/dashboard" aria-label="Back to dashboard"/);
assert.match(adminHeader, /Kinic Wiki/);
assert.match(adminShell, /<section className="grid flex-1 grid-cols-1 bg-canvas text-ink lg:grid-cols-\[240px_minmax\(0,1fr\)\]">/);
assert.doesNotMatch(adminShell, /min-h-\[calc\(100vh-/);
assert.match(adminShell, /export function AdminContent/);
assert.match(adminShell, /<main className="min-h-0 px-4 pb-8 pt-4 sm:px-6">/);
assert.doesNotMatch(adminShell, /<main className="min-h-screen/);
assert.match(adminShell, /max-w-6xl/);
assert.match(adminShell, /href: "\/profile", label: "My Profile"/);
assert.match(adminShell, /pathname === "\/profile"/);
assert.match(rootLayout, /<AppSessionProvider>/);
assert.match(rootLayout, /<div className="flex min-h-screen flex-col">/);
assert.match(rootLayout, /<AppHeader \/>/);
assert.match(appHeader, /usePathname/);
assert.match(appHeader, /const isDashboard = pathname === "\/dashboard" \|\| pathname\.startsWith\("\/dashboard\/"\)/);
assert.match(appHeader, /const isMarketplace = pathname === "\/marketplace" \|\| pathname\.startsWith\("\/marketplace\/"\)/);
assert.match(appHeader, /const isCycles = pathname === "\/cycles"/);
assert.match(appHeader, /const isProfile = pathname === "\/profile"/);
assert.match(appHeader, /const isCli = pathname === "\/cli"/);
assert.doesNotMatch(appHeader, /isKinic/);
assert.match(appHeader, /if \(!isDashboard && !isCycles && !isMarketplace && !isProfile && !isCli\) return null/);
assert.match(appHeader, /title="Console"/);
assert.doesNotMatch(appHeader, /Database dashboard/);
assert.doesNotMatch(appHeader, /Kinic marketplace/);
assert.doesNotMatch(appHeader, /href="\/kinic\/wallet"/);
assert.doesNotMatch(appHeader, /Deposit KINIC/);
assert.doesNotMatch(appHeader, /depositKinicBalanceWithIdentity/);
assert.doesNotMatch(appHeader, /parseKinicAmount/);
assert.doesNotMatch(appHeader, /parseDepositAmount/);
assert.doesNotMatch(appHeader, /aria-label="App KINIC balance"/);
assert.doesNotMatch(appHeader, /<span>Deposit<\/span>/);
assert.doesNotMatch(appHeader, /<Link[\s\S]*Database dashboard/);
assert.match(appHeader, /<WalletControls/);
assert.doesNotMatch(appHeader, /<AuthControls/);
assert.match(adminShell, /AdminAccountControls/);
assert.match(adminShell, /aria-label="Account"/);
assert.match(adminShell, /aria-label="App KINIC balance"[\s\S]*onClick=\{\(\) => setDepositOpen\(true\)\}/);
assert.match(adminShell, /aria-label="Log out"/);
assert.match(adminShell, /<PowerOff aria-hidden size=\{16\} \/>/);
assert.match(adminShell, /Deposit KINIC/);
assert.match(adminShell, /event\.target === event\.currentTarget\) setDepositOpen\(false\)/);
assert.match(adminShell, /depositKinicBalanceWithIdentity/);
assert.match(adminShell, /parseKinicAmount/);
assert.match(appSession, /kinicGetBalance/);
assert.match(appSession, /refreshKinicBalance/);
assert.match(appSession, /kinicBalanceLoading/);
assert.match(homePage, /Kinic Wiki is AI memory for agents/);
assert.match(homePage, /<code[^>]*>kinic-vfs-cli<\/code> is the primary interface/);
assert.match(homePage, /import heroImage from "\.\/home-hero\.png";/);
assert.equal(existsSync(new URL("../app/home-hero.png", import.meta.url)), true);
assert.match(homePage, /Dashboard/);
assert.match(homePage, /Open Dashboard/);
assert.equal([...homePage.matchAll(/href="\/dashboard"/g)].length, 2);
assert.match(homeHeroSection, /Install CLI/);
assert.doesNotMatch(homeHeroSection, /Open Dashboard/);
assert.doesNotMatch(homeHeroSection, /Open Official Wiki/);
assert.match(homePage, /Chrome Extension/);
assert.match(homePage, /ChatGPT\/Claude conversations/);
assert.match(homePage, /raw sources/);
assert.match(homePage, /URL ingest requests/);
assert.match(homePage, /writer access/);
assert.match(homePage, /use the CLI to turn raw chats into organized \/Wiki pages/);
assert.match(homePage, /\/Sources\/ingest-requests\/\.\.\./);
assert.match(homePage, /\/Sources\/raw\/\.\.\./);
assert.match(homePage, /Open Official Wiki/);
assert.match(homePage, /Meet Kinic Wiki/);
assert.match(homePage, /Agent CLI workflow/);
assert.match(homePage, /Create databases/);
assert.match(homePage, /Manage access and cycles/);
assert.match(homePage, /Browse and edit/);
assert.doesNotMatch(homePage, /Companion UI/);
assert.doesNotMatch(homePage, /title: "Connect an agent"/);
assert.doesNotMatch(homePage, /title: "Search and read"/);
assert.doesNotMatch(homePage, /title: "Write with guards"/);
assert.doesNotMatch(homePage, /--expected-etag/);
assert.doesNotMatch(homePage, /useSearchParams/);
assert.match(dashboardIndex, /import \{ DashboardHomeClient \} from "\.\/dashboard-home-client";/);
assert.match(dashboardIndex, /<Suspense fallback=\{<DashboardHomeFallback \/>\}>/);
assert.match(dashboardIndex, /<DashboardHomeClient \/>/);
assert.doesNotMatch(dashboardHomeClient, /<AdminHeader/);
assert.doesNotMatch(dashboardHomeClient, /href="\/cli"/);
assert.match(homeUi, /href="\/cli"/);
assert.match(rootReadme, /db_kva4v2twg6jv/);
assert.match(rootReadme, /https:\/\/wiki\.kinic\.xyz\/db\/db_kva4v2twg6jv\/Wiki/);
assert.match(rootReadme, /Why Kinic Wiki/);
assert.match(rootReadme, /Vector databases/);
assert.match(rootReadme, /Chrome extension/);
assert.match(rootReadme, /\/Wiki\/\.\.\./);
assert.match(rootReadme, /\/Sources\/raw\/\.\.\./);
assert.match(cliPage, /npm install -g kinic-vfs-cli/);
assert.match(cliPage, /VFS_DATABASE_ID=<database-id>/);
assert.match(cliPage, /--expected-etag <etag>/);
assert.match(cliPage, /skill find/);
assert.match(cliPage, /--identity-mode anonymous/);
assert.match(cliPage, /const installCommands = \["npm install -g kinic-vfs-cli"\]/);
assert.doesNotMatch(cliPage, /Database dashboard/);
assert.doesNotMatch(cliPage, /ArrowLeft/);
assert.match(cliPage, /const checkCommands = \["kinic-vfs-cli --version", "kinic-vfs-cli --help"\]/);
assert.match(cliPage, /title="First Check"/);
assert.match(cliPage, /Run Kinic Wiki from the CLI/);
assert.match(cliPage, /CLI workflow/);
assert.match(cliPage, /title="Connect Database"/);
assert.match(cliPage, /title="Read Workflow"/);
assert.match(cliPage, /title="Safe Write Workflow"/);
assert.match(cliPage, /title="Skill Registry"/);
assert.doesNotMatch(cliPage, /AdminPageHeader|title="CLI Guide"|Open npm|npm-distributed operator CLI/);
assert.match(cliGuideBlock, /navigator\.clipboard\.writeText\(copyValue \?\? commandText\)/);
assert.match(cliGuideBlock, /Copy .* commands/);
assert.match(cliGuideBlock, /absolute right-2 top-2/);
assert.doesNotMatch(dashboardIndex, /<DashboardDatabaseClient databaseId="" \/>/);
assert.match(dashboardRoute, /params: Promise<\{ databaseId: string \}>/);
assert.match(dashboardRoute, /<DashboardDatabaseClient databaseId=\{databaseId\} \/>/);
assert.match(dashboardClient, /export function DashboardDatabaseClient\(\{ databaseId \}/);
assert.doesNotMatch(dashboardClient, /import \{ AdminHeader \}/);
assert.match(dashboardClient, /<DatabaseDetailHeader/);
assert.match(dashboardClient, /function DatabaseDetailHeader/);
assert.match(dashboardClient, /title=\{database\?\.name \?\? "Database access"\}/);
assert.doesNotMatch(dashboardClient, /Pencil/);
assert.doesNotMatch(dashboardClient, /href=\{`\/skills\/\$\{encodeURIComponent\(databaseId\)\}`\}/);
assert.match(dashboardClient, /const \[renameOpen, setRenameOpen\] = useState\(false\);/);
assert.match(dashboardClient, /const \[renameDraft, setRenameDraft\] = useState\(""\);/);
assert.match(dashboardClient, /setRenameDraft\(database\.name\);/);
assert.doesNotMatch(dashboardClient, /aria-label="Rename database"/);
assert.match(dashboardClient, /<RenameDatabaseDialog/);
assert.match(dashboardClient, /if \(await renameDatabase\(nextName\)\) \{/);
assert.doesNotMatch(dashboardClient, /unknown database/);
assert.doesNotMatch(dashboardClient, /useSearchParams/);
assert.doesNotMatch(dashboardClient, /usePathname/);
assert.match(dashboardUi, /!props\.busy && event\.target === event\.currentTarget\) props\.onCancel\(\)/);

assert.match(wikiLayout, /<WikiBrowser \/>/);
assert.doesNotMatch(wikiLayout, /isReservedDatabaseRouteSlug|notFound\(\)/);
for (const origin of [
  "chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj",
  "chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci",
  "chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi"
]) {
  assert.match(canisterEntrypoint, new RegExp(origin.replaceAll("/", "\\/")));
}
assert.match(canisterEntrypoint, /https:\/\/wiki\.kinic\.xyz/);
assert.match(canisterEntrypoint, /https:\/\/kinic\.xyz/);
assert.equal(existsSync(new URL("../app/.well-known/ii-alternative-origins/route.ts", import.meta.url)), false);
assert.match(wikiRoute, /return null;/);
assert.equal(existsSync(new URL("../app/w/page.tsx", import.meta.url)), false);
assert.equal(existsSync(new URL("../vercel.json", import.meta.url)), false);
assert.doesNotMatch(nextConfig, /output:\s*"export"/);

assert.match(wranglerConfig, /"name": "kinic-wiki-browser"/);
assert.match(wranglerConfig, /"main": ".open-next\/worker.js"/);
assert.match(wranglerConfig, /"nodejs_compat"/);
assert.match(wranglerConfig, /"global_fetch_strictly_public"/);
assert.match(wranglerConfig, /"WORKER_SELF_REFERENCE"/);
assert.match(wranglerConfig, /"binding": "QUERY_ANSWER_RATE_LIMIT"/);
assert.doesNotMatch(wranglerConfig, /"REPLACE_WITH_QUERY_ANSWER_RATE_LIMIT_KV_NAMESPACE_ID"/);
assert.match(wranglerConfig, /"id": "[a-f0-9]{32}"/);
assert.match(wranglerConfig, /"KINIC_WIKI_GENERATOR_URL": "https:\/\/wiki-generator\.kinic\.xyz"/);
assert.match(readFileSync(new URL("../README.md", import.meta.url), "utf8"), /wrangler kv namespace create QUERY_ANSWER_RATE_LIMIT/);
assert.match(readFileSync(new URL("../README.md", import.meta.url), "utf8"), /not an atomic counter/);

assert.equal(packageJson.scripts.preview, "opennextjs-cloudflare build && opennextjs-cloudflare preview");
assert.equal(packageJson.scripts["build:worker"], "opennextjs-cloudflare build");
assert.equal(packageJson.scripts.deploy, "opennextjs-cloudflare build && wrangler deploy --minify");
assert.equal(packageJson.scripts["cf-typegen"], "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts");
assert.equal(packageJson.scripts["e2e:ii"], "scripts/run-ii-e2e.sh");
assert.equal(packageJson.scripts["e2e:ii:headed"], "scripts/run-ii-e2e.sh --headed");
assert.equal(packageJson.scripts["e2e:ii:setup"], "../scripts/setup-wikibrowser-ii-e2e.sh");
assert.match(nextConfig, /NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
assert.doesNotMatch(nextConfig, /NEXT_PUBLIC_II_PROVIDER_URL/);
assert.doesNotMatch(nextConfig, /NEXT_PUBLIC_KINIC_WIKI_GENERATOR_URL/);
assert.match(dashboardHomeClient, /NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
assert.doesNotMatch(dashboardHomeClient, /createUrlIngestRequest/);
assert.doesNotMatch(homeUi, /Queue URL/);
assert.match(dashboardHomeClient, /listDatabasesPublic/);
assert.match(dashboardHomeClient, /listDatabasesAuthenticated/);
assert.doesNotMatch(dashboardHomeClient, /listDatabasesPublicWithWarning/);
assert.doesNotMatch(dashboardHomeClient, /listDatabasesAuthenticatedWithWarning/);
assert.match(dashboardHomeClient, /mergeDatabaseRows/);
assert.match(dashboardHomeClient, /Promise\.allSettled/);
assert.match(dashboardHomeClient, /Public database list unavailable/);
assert.match(dashboardHomeClient, /publicError/);
assert.match(dashboardHomeClient, /publicResult\.status === "rejected" \? `Public database list unavailable: \$\{errorMessage\(publicResult\.reason\)\}` : null/);
assert.match(homeUi, /publicError && mode === "public"/);
assert.doesNotMatch(homeUi, /if \(publicError && mode === "public"\)/);
assert.doesNotMatch(dashboardHomeClient, /if \(publicResult\.status === "rejected"\) return `Public database list unavailable/);
assert.match(dashboardHomeClient, /const databaseRefreshClient = principal && authClient \? authClient : null;/);
assert.match(dashboardHomeClient, /void refreshDatabases\(databaseRefreshClient\);/);
assert.match(dashboardHomeClient, /\}, \[authClient, authReady, principal, refreshDatabases\]\);/);
assert.match(dashboardHomeClient, /dashboardFundingSuccessMessage\(searchParams\)/);
assert.match(dashboardHomeClient, /params\.get\("funding"\) !== "success"/);
assert.match(dashboardHomeClient, /params\.get\("database_id"\)/);
assert.match(dashboardHomeClient, /params\.get\("provider"\)/);
assert.match(dashboardHomeClient, /params\.get\("kinic"\)/);
assert.match(dashboardHomeClient, /params\.get\("cycles"\)/);
assert.match(dashboardHomeClient, /type FundingProvider = "oisy" \| "plug" \| "ii"/);
assert.match(dashboardHomeClient, /provider === "ii" \? "funded" : "purchased"/);
assert.match(dashboardHomeClient, /\$\{fundingProviderLabel\(provider\)\} \$\{verb\} \$\{cycles\} cycles for \$\{databaseId\}; paid \$\{kinic\}\./);
const dashboardHomeModule = loadTsModule(
  "../app/dashboard/dashboard-home-client.tsx",
  {
    "lucide-react": { Plus: () => null },
    "next/navigation": { useSearchParams: () => new URLSearchParams() },
    "react": {
      useCallback: (run) => run,
      useEffect: () => undefined,
      useRef: (initial) => ({ current: initial }),
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined]
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "../app-session-provider": {
      useAppSession: () => ({
        authClient: null,
        authError: null,
        authReady: true,
        kinicBalance: null,
        kinicBalanceError: null,
        kinicBalanceLoading: false,
        principal: null,
        refreshKinicBalance: async () => undefined,
        refreshWalletBalance: async () => undefined,
        setWalletControlsLocked: () => undefined,
        wallet: null,
        walletBalance: null,
        walletBalanceError: null,
        walletBalanceLoading: false,
        walletBusyProvider: null
      })
    },
    "../create-database-dialog": { CreateDatabaseDialog: () => null },
    "../home-ui": { DatabaseBody: () => null, OfficialKinicWikiPanel: () => null, StatusPanel: () => null },
    "@/components/admin-shell": { AdminContent: ({ children }) => children },
    "@/lib/cycles": { cyclesForPaymentAmountE8s: () => 234_500_000_000n, KINIC_LEDGER_FEE_E8S: 100_000n },
    "@/lib/cycles-url": { parseKinicAmountE8sInput: () => 100_000_000n },
    "@/lib/kinic-wallet": {
      purchaseCyclesWithOisy: async () => ({}),
      purchaseCyclesWithPlug: async () => ({})
    },
    "@/lib/kinic-amount": { formatTokenAmountFromE8s: (value) => `${value} KINIC` },
    "@/lib/wallet-runtime": {
      walletRuntime: () => ({
        icHost: "https://icp0.io",
        localReplica: false,
        externalWalletsAvailable: true
      })
    },
    "@/lib/vfs-client": {
      createDatabaseAuthenticated: async () => ({ database_id: "db_ok-1" }),
      getCyclesBillingConfig: async () => ({}),
      kinicFundDatabaseCycles: async () => ({}),
      listDatabasesAuthenticated: async () => [],
      listDatabasesPublic: async () => []
    }
  },
  "Object.assign(exports, { __test: { dashboardFundingSuccessMessage } });"
);
const dashboardFundingSuccessMessage = dashboardHomeModule.__test.dashboardFundingSuccessMessage;
assert.equal(
  dashboardFundingSuccessMessage(new URLSearchParams("funding=success&database_id=db_ok-1&provider=ii&kinic=1.000 KINIC&cycles=234,500,000,000")),
  "Internet Identity funded 234,500,000,000 cycles for db_ok-1; paid 1.000 KINIC."
);
assert.equal(
  dashboardFundingSuccessMessage(new URLSearchParams("funding=success&database_id=db_ok-1&provider=oisy&kinic=1.000 KINIC&cycles=234,500,000,000")),
  "OISY purchased 234,500,000,000 cycles for db_ok-1; paid 1.000 KINIC."
);
assert.equal(
  dashboardFundingSuccessMessage(new URLSearchParams("funding=success&database_id=db_ok-1&provider=plug&kinic=1.000 KINIC&cycles=234,500,000,000")),
  "Plug purchased 234,500,000,000 cycles for db_ok-1; paid 1.000 KINIC."
);
assert.equal(
  dashboardFundingSuccessMessage(new URLSearchParams("funding=success&database_id=db_ok-1&provider=bad&kinic=1.000 KINIC&cycles=234,500,000,000")),
  null
);
assert.match(apiErrors, /wiki_api_version_mismatch/);
assert.match(apiErrors, /Wiki VFS API response unavailable\./);
assert.match(apiErrors, /CandidDecodeError\|Cannot find field hash\|subtype\|type mismatch\|variant, expected fields/);
assert.match(vfsIdl, /Deleted: idl\.Null/);
assert.match(vfsIdl, /deleted_at_ms: idl\.Opt\(idl\.Int64\)/);
assert.doesNotMatch(vfsIdl, /Hot: idl\.Null/);
assert.match(vfsIdl, /Active: idl\.Null/);
assert.match(vfsIdl, /Pending: idl\.Null/);
assert.match(vfsIdl, /status: DatabaseStatus/);
assert.match(vfsClient, /if \("Active" in status\) \{\s*return "active";\s*\}/);
assert.match(vfsClient, /if \("Pending" in status\) \{\s*return "pending";\s*\}/);
assert.match(vfsClient, /if \("Deleted" in status\) \{\s*return "deleted";\s*\}/);
assert.doesNotMatch(vfsClient, /throw new Error\(result\.Err\)/);
assert.match(vfsClient, /create_database\(\{ name \}\)[\s\S]*throwCanisterError\(result\.Err\)/);
assert.match(dashboardHomeClient, /myDatabases = databases\.filter\(\(database\) => database\.member\)/);
assert.match(dashboardHomeClient, /publicDatabases = databases\.filter\(\(database\) => !database\.member && database\.publicReadable\)/);
assert.doesNotMatch(dashboardHomeClient, /Database dashboard/);
assert.doesNotMatch(dashboardHomeClient, /<OfficialKinicWikiPanel \/>/);
assert.match(dashboardHomeClient, /const \[createDialogOpen, setCreateDialogOpen\] = useState\(false\);/);
assert.match(dashboardHomeClient, /const \[newDatabaseName, setNewDatabaseName\] = useState\(""\);/);
assert.match(dashboardHomeClient, /const databaseNameInput = newDatabaseName\.trim\(\);/);
assert.match(dashboardHomeClient, /createDatabaseAuthenticated\(canisterId, authClient\.getIdentity\(\), databaseNameInput\)/);
assert.match(dashboardHomeClient, /useAppSession/);
assert.doesNotMatch(dashboardHomeClient, /authRefreshSeq/);
assert.match(dashboardHomeClient, /setWalletControlsLocked\(creating\)/);
assert.match(appSession, /connectOisyWallet/);
assert.match(appSession, /connectPlugWallet/);
assert.match(appSession, /getConnectedWalletKinicBalance/);
assert.match(appSession, /function safeSessionStorageGet\(key: string\): string \| null/);
assert.match(appSession, /function safeSessionStorageSet\(key: string, value: string\): void/);
assert.match(appSession, /function safeSessionStorageRemove\(key: string\): void/);
assert.match(appSession, /safeSessionStorageSet\(\s*WALLET_SESSION_KEY,/);
assert.match(appSession, /safeSessionStorageRemove\(WALLET_SESSION_KEY\)/);
assert.match(appSession, /provider: nextWallet\.provider/);
assert.match(appSession, /principal: connectedWalletPrincipal\(nextWallet\)/);
assert.match(appSession, /const \[wallet, setWallet\] = useState<ConnectedKinicWallet \| null>\(null\)/);
assert.match(appSession, /const stored = readStoredWallet\(\);/);
assert.match(profilePage, /ProfileClient/);
assert.doesNotMatch(profileClient, /AdminPageHeader|title="My Profile"|Manage App KINIC for marketplace purchases/);
assert.match(profileClient, /kinicGetBalance/);
assert.match(profileClient, /depositKinicBalanceWithIdentity/);
assert.match(profileClient, /kinicWithdrawBalance/);
assert.match(profileClient, /Withdraw KINIC/);
assert.doesNotMatch(profileClient, /kinicListPendingOperations|Pending operations|No pending operations|OperationRow/);
assert.doesNotMatch(profileClient, /Use Deposit and Withdraw for App balance movements\./);
assert.doesNotMatch(profileClient, /not an App KINIC deposit address/);
assert.doesNotMatch(profileClient, /break-all.*principal|caller.*principal/i);
assert.match(dashboardHomeClient, /await refreshWalletBalance\(wallet\);/);
assert.doesNotMatch(marketplaceClient, /AdminPageHeader|matching loaded listings|title="Marketplace"/);
assert.doesNotMatch(cyclesClient, /AdminPageHeader|title="Cycles"|Fund a Kinic Wiki database cycles balance/);
assert.match(dashboardHomeClient, /await refreshKinicBalance\(\);/);
assert.match(dashboardHomeClient, /purchaseCyclesWithOisy/);
assert.match(dashboardHomeClient, /purchaseCyclesWithPlug/);
assert.match(dashboardHomeClient, /kinicFundDatabaseCycles/);
assert.match(dashboardHomeClient, /cyclesForPaymentAmountE8s\(paymentAmountE8s, BigInt\(config\.cyclesPerKinic\)\)/);
assert.match(dashboardHomeClient, /CREATE_DATABASE_PURCHASE_KINIC = "1"/);
assert.match(dashboardHomeClient, /import \{ cyclesForPaymentAmountE8s, KINIC_LEDGER_FEE_E8S \} from "@\/lib\/cycles";/);
assert.match(dashboardHomeClient, /const paymentAmountE8s = createDatabasePurchaseAmountE8s\(\);/);
assert.match(dashboardHomeClient, /function createDatabaseWalletRequiredBalanceE8s\(\): bigint/);
assert.match(dashboardHomeClient, /return createDatabasePurchaseAmountE8s\(\) \+ KINIC_LEDGER_FEE_E8S \* 2n;/);
assert.match(dashboardHomeClient, /Database created pending\. Requesting/);
assert.match(dashboardHomeClient, /Database created pending\. Initial cycles purchase did not complete\. Fund cycles later from Cycles\./);
assert.doesNotMatch(dashboardHomeClient, /purchaseQueryString\(\{ databaseId: result\.database_id \}\)/);
assert.doesNotMatch(dashboardHomeClient, /useRouter|router\.push/);
assert.match(dashboardHomeClient, /const \[createPaymentSource, setCreatePaymentSource\] = useState<CreateDatabasePaymentSource>\("wallet"\);/);
assert.match(dashboardHomeClient, /if \(walletPaymentAvailable\) \{\s*setCreatePaymentSource\("wallet"\);/);
assert.match(dashboardHomeClient, /if \(appBalanceReadyToFundCreate\) \{\s*setCreatePaymentSource\("app-balance"\);/);
assert.match(dashboardHomeClient, /if \(walletPaymentAvailable\) \{\s*setCreatePaymentSource\("wallet"\);/);
assert.match(dashboardHomeClient, /if \(createPaymentSource === "app-balance" && !appBalanceReadyToFundCreate\) return;/);
assert.match(dashboardHomeClient, /if \(createPaymentSource === "wallet" && \(!wallet \|\| !walletPaymentAvailable\)\) return;/);
assert.match(dashboardHomeClient, /createLabel=\{createPaymentSource === "app-balance" \? "Create with App balance" : "Create with wallet"\}/);
assert.match(dashboardHomeClient, /paymentSource=\{createPaymentSource\}/);
assert.match(dashboardHomeClient, /paymentSources=\{createDialogPaymentSources\}/);
assert.match(dashboardHomeClient, /walletRuntime\(\)/);
assert.match(dashboardHomeClient, /runtime\.externalWalletsAvailable && walletReadyToFundCreate/);
assert.doesNotMatch(dashboardHomeClient, /Checking KINIC balance|Create database will request the first cycles purchase|walletFundingMessage/);
assert.match(dashboardHomeClient, /await purchaseCyclesWithOisy\(\{ canisterId, databaseId: result\.database_id, paymentAmountE8s \}, wallet\.connection\)/);
assert.match(dashboardHomeClient, /await purchaseCyclesWithPlug\(\{ canisterId, databaseId: result\.database_id, paymentAmountE8s \}, wallet\.connection\)/);
assert.match(dashboardHomeClient, /const appBalanceReadyToFundCreate = balanceCanFundCreate\(kinicBalance, createDatabasePurchaseAmountE8s\(\)\);/);
assert.match(dashboardHomeClient, /const walletReadyToFundCreate = balanceCanFundCreate\(walletBalance, createDatabaseWalletRequiredBalanceE8s\(\)\);/);
assert.match(dashboardHomeClient, /const createUnavailable = !principal \|\| loadState === "loading" \|\| walletBusyProvider !== null;/);
assert.match(dashboardHomeClient, /function balanceCanFundCreate\(balanceE8s: string \| null, requiredE8s: bigint\): boolean/);
assert.match(dashboardHomeClient, /return BigInt\(balanceE8s\) >= requiredE8s;/);
assert.match(dashboardHomeClient, /function databaseCreateButtonLabel/);
assert.match(dashboardHomeClient, /iiConnected: boolean;/);
assert.match(dashboardHomeClient, /return "Connect Internet Identity"/);
assert.match(dashboardHomeClient, /return "Loading databases\.\.\."/);
assert.match(dashboardHomeClient, /return "Create database"/);
assert.match(dashboardHomeClient, /disabled=\{creating \|\| createUnavailable\}/);
assert.doesNotMatch(dashboardHomeClient, /<WalletControls/);
assert.match(appHeader, /connectedBalanceLabel=\{connectedWalletBalanceLabel\}/);
assert.match(appHeader, /balanceLoading=\{walletBalanceLoading\}/);
assert.match(appHeader, /walletRuntime\(\)/);
assert.match(appHeader, /externalWalletsAvailable=\{runtime\.externalWalletsAvailable\}/);
assert.match(appHeader, /onDisconnect=\{disconnectWallet\}/);
assert.match(appSession, /const disconnectWallet = useCallback/);
assert.match(appSession, /walletRuntime\(\)/);
assert.match(appSession, /!runtime\.externalWalletsAvailable/);
assert.match(appSession, /clearStoredWallet\(\);/);
assert.match(appSession, /if \(walletControlsLocked \|\| walletBusyProvider \|\| wallet\?\.provider !== provider\) return;/);
assert.match(appSession, /walletBalanceSeqRef\.current \+= 1;\n    setWallet\(null\);\n    setWalletBalance\(null\);\n    setWalletBalanceLoading\(false\);\n    setWalletBalanceError\(null\);\n    setWalletBusyProvider\(null\);/);
assert.match(homeUi, /export type HeaderWalletProvider = "oisy" \| "plug"/);
assert.match(homeUi, /export function WalletControls/);
assert.match(homeUi, /externalWalletsAvailable: boolean/);
assert.match(homeUi, /const externalWalletDisabled = !externalWalletsAvailable/);
assert.match(homeUi, /const plugDisabled = !plugConnected && externalWalletDisabled/);
assert.match(homeUi, /PowerOff/);
assert.match(homeUi, /onDisconnect: \(provider: HeaderWalletProvider\) => void/);
assert.match(homeUi, /onClick=\{\(\) => \(oisyConnected \? onDisconnect\("oisy"\) : onConnect\("oisy"\)\)\}/);
assert.match(homeUi, /onClick=\{\(\) => \(plugConnected \? onDisconnect\("plug"\) : onConnect\("plug"\)\)\}/);
assert.match(homeUi, /ariaLabel=\{oisyConnected \? "Disconnect OISY" : undefined\}/);
assert.match(homeUi, /ariaLabel=\{plugConnected \? "Disconnect Plug" : undefined\}/);
assert.match(homeUi, /hoverIcon=\{oisyConnected \? <PowerOff aria-hidden size=\{15\} \/> : null\}/);
assert.match(homeUi, /hoverIcon=\{plugConnected \? <PowerOff aria-hidden size=\{15\} \/> : null\}/);
assert.match(homeUi, /group-hover:opacity-0/);
assert.match(homeUi, /group-hover:opacity-100/);
assert.match(homeUi, /size-\[15px\]/);
assert.match(homeUi, /connectedBalanceLabel: string \| null/);
assert.match(homeUi, /balanceLoading: boolean/);
assert.match(homeUi, /\/ \{secondaryLabel\}/);
assert.match(homeUi, /PlugZap/);
assert.match(homeUi, /disabled=\{disabled \|\| busyProvider !== null \|\| oisyDisabled\}/);
assert.match(homeUi, /disabled=\{disabled \|\| busyProvider !== null \|\| plugDisabled\}/);
assert.match(dashboardHomeClient, /<CreateDatabaseDialog/);
assert.match(dashboardHomeClient, /requiredBalanceLabel=\{formatTokenAmountFromE8s\(createDatabasePurchaseAmountE8s\(\)\)\}/);
assert.match(dashboardHomeClient, /setCreateDialogOpen\(false\);/);
assert.match(dashboardHomeClient, /function databaseNameError\(databaseName: string\): string \| null/);
assert.match(createDatabaseDialog, /role="dialog"/);
assert.match(createDatabaseDialog, /aria-modal="true"/);
assert.match(createDatabaseDialog, /id="database-name-input"/);
assert.match(createDatabaseDialog, /disabled=\{createDisabled\}/);
assert.match(createDatabaseDialog, /!creating && event\.target === event\.currentTarget\) onCancel\(\)/);
assert.match(createDatabaseDialog, /requiredBalanceLabel: string/);
assert.match(createDatabaseDialog, /export type CreateDatabasePaymentSource = "app-balance" \| "wallet";/);
assert.match(createDatabaseDialog, /Payment source/);
assert.match(createDatabaseDialog, /Create requires \{requiredBalanceLabel\}\. External wallet pays directly from ledger balance\. App balance is for seller proceeds or internal balance\./);
assert.doesNotMatch(createDatabaseDialog, /Use Deposit to credit App balance/);
assert.match(createDatabaseDialog, /createLabel: string/);
assert.match(createDatabaseDialog, /onPaymentSourceChange: \(source: CreateDatabasePaymentSource\) => void/);
assert.match(createDatabaseDialog, /<span>\{creating \? "Creating\.\.\." : createLabel\}<\/span>/);
assert.match(dashboardHomeClient, /member: false, publicReadable: true/);
assert.match(dashboardHomeClient, /member: true, publicReadable: publicIds\.has\(database\.databaseId\)/);
assert.match(homeUi, /member: boolean/);
assert.match(homeUi, /OFFICIAL_KINIC_WIKI_DATABASE_ID = "db_kva4v2twg6jv"/);
assert.match(homeUi, /OFFICIAL_KINIC_WIKI_DATABASE_NAME = "Official Kinic Wiki"/);
assert.match(homeUi, /A canister-backed file-system wiki for agent memory: structured paths, raw sources, links, search, and safe edits\./);
assert.match(homeUi, /Use the Chrome extension to capture ChatGPT conversations and active web pages into the same database\./);
assert.match(homeUi, /publicDatabasePath\(OFFICIAL_KINIC_WIKI_DATABASE_ID\)/);
assert.doesNotMatch(homeUi, /\/dashboard\/\$\{encodeURIComponent\(OFFICIAL_KINIC_WIKI_DATABASE_ID\)\}/);
assert.match(homeUi, /TerminalSquare/);
assert.match(homeUi, /<span>CLI<\/span>/);
assert.match(homeUi, /My databases/);
assert.match(homeUi, /Public databases/);
assert.doesNotMatch(homeUi, /Databases where your signed-in principal has a direct role\./);
assert.match(homeUi, /No databases are linked to this principal\./);
assert.match(homeUi, /No public databases are available\./);
assert.match(homeUi, /publicError && mode === "public"/);
assert.doesNotMatch(homeUi, /PackageSearch/);
assert.doesNotMatch(homeUi, /Open public/);
assert.doesNotMatch(homeUi, /openPublicDatabaseHref/);
assert.match(homeUi, /ShareDatabaseLink/);
assert.match(homeUi, /Share2/);
assert.match(homeUi, /xShareDatabaseHref/);
assert.doesNotMatch(homeUi, /Archive/);
assert.match(homeUi, /function isActiveRoutableDatabase\(database: DatabaseRow\): boolean/);
assert.match(homeUi, /return database\.status === "active" && isRoutableDatabaseId\(database\.databaseId\);/);
assert.match(homeUi, /const active = isActiveRoutableDatabase\(database\);/);
assert.match(homeUi, /<th className="px-4 py-3 font-medium">Name<\/th>/);
assert.match(homeUi, /<th className="px-4 py-3 font-medium">ID<\/th>/);
assert.match(homeUi, /<th className="px-4 py-3 font-medium">Status<\/th>/);
assert.match(homeUi, /<th className="px-4 py-3 font-medium">Size<\/th>/);
assert.match(homeUi, /<th className="px-4 py-3 font-medium">Cycles<\/th>/);
assert.doesNotMatch(homeUi, /<th className="px-4 py-3 font-medium">Open<\/th>/);
assert.doesNotMatch(homeUi, /<th className="px-4 py-3 font-medium">Registry<\/th>/);
assert.match(homeUi, /<th className="px-4 py-3 font-medium">Top up<\/th>/);
assert.match(homeUi, /<th className="px-4 py-3 font-medium">Manage<\/th>/);
assert.doesNotMatch(homeUi, /<th className="px-4 py-3 font-medium">Database<\/th>/);
assert.doesNotMatch(homeUi, /Logical size/);
assert.match(homeUi, /<PublicBadge \/>/);
assert.match(homeUi, /function PublicBadge\(\)/);
assert.match(homeUi, /function databaseStatusSummary\(database: DatabaseRow, cycles: DatabaseCycleView\): string/);
assert.match(homeUi, /if \(database\.status !== "active"\) return databaseStatus/);
assert.match(homeUi, /return "Suspended"/);
assert.match(homeUi, /return "Low cycles"/);
assert.match(homeUi, /return "Active"/);
assert.match(homeUi, /return "Pending · Needs cycles"/);
assert.doesNotMatch(homeUi, /Active · Suspended/);
assert.doesNotMatch(homeUi, /Active · Low cycles/);
assert.match(homeUi, /Cycles unknown/);
assert.match(homeUi, /function databaseCyclesBalanceSummary\(database: DatabaseRow\): string/);
assert.match(homeUi, /formatCycleBalance\(balance\)/);
assert.doesNotMatch(homeUi, /formatCycleBalance\(balance\) \+ " cycles"/);
assert.doesNotMatch(homeUi, /databaseCyclesView\(database, cyclesConfig\)\.summary/);
assert.match(homeUi, /<Link className="font-semibold text-accent no-underline hover:underline" href=\{openDatabaseHref\(database\)\}>/);
assert.doesNotMatch(homeUi, /<DatabaseActionLink href=\{openDatabaseHref\(database\)\} icon=\{<BookOpen aria-hidden size=\{14\} \/>} label="Open" \/>/);
assert.match(homeUi, /\/dashboard\/project\/\$\{encodeURIComponent\(database\.databaseId\)\}/);
assert.doesNotMatch(homeUi, /active && mode === "member" && database\.publicReadable/);
assert.match(homeUi, /active && database\.publicReadable \? <ShareDatabaseLink database=\{database\} \/>/);
assert.doesNotMatch(homeUi, /label="Registry"/);
assert.match(homeUi, /label="Top up"/);
assert.doesNotMatch(homeUi, /<DatabaseActionLink[^>\n]*label="Cycles"/);
assert.match(homeUi, /href=\{`\/dashboard\/project\/\$\{encodeURIComponent\(databaseId\)\}`\}/);
assert.match(homeUi, /Manage reservation/);
assert.doesNotMatch(homeUi, /read=anonymous/);
assert.match(homeUi, /return publicDatabasePath\(database\.databaseId\);/);
assert.match(wikiBrowser, /"ingest"/);
assert.match(wikiBrowser, /<IngestPanel/);
assert.match(wikiBrowser, /databaseCyclesError=\{currentDatabaseCycleReason\}/);
assert.doesNotMatch(wikiBrowser, /parseReadMode/);
assert.match(wikiBrowser, /effectiveReadIdentity/);
assert.doesNotMatch(wikiBrowser, /Promise\.allSettled\(\[\s*listDatabasesPublic\(canisterId\),/);
assert.match(wikiBrowser, /databaseDirectory\.requestKey === databaseDirectoryRequestKey \? databaseDirectory : emptyCurrentDatabaseDirectory/);
assert.match(wikiBrowser, /void listDatabasesPublic\(canisterId\)[\s\S]*publicDatabases = nextPublicDatabases;[\s\S]*updateDatabaseRows\(\);/);
assert.match(wikiBrowser, /publicDatabaseIds: new Set\(publicDatabases\.map\(\(database\) => database\.databaseId\)\)/);
assert.match(wikiBrowser, /void \(readIdentity \? listDatabasesAuthenticated\(canisterId, readIdentity\) : Promise\.resolve<DatabaseSummary\[\]>\(\[\]\)\)/);
assert.doesNotMatch(wikiBrowser, /hrefForCurrentReadRoute/);
assert.doesNotMatch(wikiBrowser, /anonymousHref/);
assert.match(ingestPanel, /createUrlIngestRequest/);
assert.match(ingestPanel, /databaseCyclesError/);
assert.match(ingestPanel, /const submitDisabled = busy \|\| !url\.trim\(\) \|\| Boolean\(databaseCyclesError\)/);
assert.doesNotMatch(ingestPanel, /ensureUrlIngestTriggerSession\(canisterId, databaseId, readIdentity\)/);
assert.doesNotMatch(ingestPanel, /Checking access/);
assert.doesNotMatch(ingestPanel, /URL ingest disabled/);
assert.match(urlIngest, /const session = await ensureUrlIngestTriggerSession\(canisterId, databaseId, identity\)/);
assert.match(ingestPanel, /Queued and accepted/);
assert.match(urlIngest, /\/Sources\/ingest-requests/);
assert.match(urlIngest, /kinic\.url_ingest_request/);
assert.match(urlIngest, /claimed_at: null/);
assert.match(urlIngest, /finished_at: null/);
assert.match(urlIngest, /\/api\/url-ingest\/trigger/);
assert.match(ingestTriggerRoute, /KINIC_WIKI_GENERATOR_URL/);
assert.match(ingestTriggerRoute, /KINIC_WIKI_WORKER_TOKEN/);
assert.match(ingestTriggerRoute, /chrome-extension:\/\/jcfniiflikojmbfnaoamlbbddlikchaj/);
assert.match(ingestTriggerRoute, /chrome-extension:\/\/moebdnadaffhlddnhifmmdoecifhcbdi/);
assert.match(ingestTriggerRoute, /access-control-allow-origin/);
assert.match(ingestTriggerRoute, /authorization: `Bearer \$\{token\}`/);
assert.match(sourceRunRoute, /\/run/);
assert.match(sourceRunRoute, /checkSourceRunSession/);
assert.match(sourceRunRoute, /sourceEtag is required/);
assert.match(sourceRunRoute, /sourcePath must use \/Sources\/raw\/<provider>\/<id>\.md/);
assert.doesNotMatch(sourceRunRoute, /checkQueryAnswerSession/);
assert.match(sourceRunRoute, /authorization: `Bearer \$\{token\}`/);
assert.match(sourceRunRoute, /chrome-extension:\/\/moebdnadaffhlddnhifmmdoecifhcbdi/);
assert.match(dashboardClient, /NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
assert.match(dashboardClient, /listDatabasesPublic/);
assert.match(dashboardClient, /listDatabasesAuthenticated/);
assert.match(dashboardClient, /<CycleBattery cyclesBalance=\{database\?\.cyclesBalance \?\? null\} \/>/);
assert.doesNotMatch(dashboardClient, /<CycleBattery canisterId=\{canisterId\} \/>/);
assert.doesNotMatch(dashboardClient, /listDatabasesPublicWithWarning/);
assert.doesNotMatch(dashboardClient, /listDatabasesAuthenticatedWithWarning/);
assert.match(dashboardClient, /mergeDatabaseRows/);
assert.match(dashboardClient, /Promise\.allSettled/);
assert.match(dashboardClient, /Public database list unavailable/);
assert.match(dashboardClient, /useAppSession/);
assert.match(dashboardClient, /principal && authClient \? authClient : null/);
assert.doesNotMatch(dashboardClient, /AuthClient\.create/);
assert.doesNotMatch(dashboardClient, /Select a database to manage/);
assert.doesNotMatch(dashboardClient, /Open Database dashboard/);
assert.doesNotMatch(dashboardClient, /Database id is missing\./);
assert.match(dashboardClient, /databaseId && \(database \|\| principal\) \? <SummaryPanel cyclesConfig=\{cyclesConfig\} database=\{database\} databaseId=\{databaseId\} publicReadable=\{database\?\.publicReadable \?\? false\} \/>/);
assert.match(dashboardClient, /deleteDatabaseAuthenticated/);
assert.doesNotMatch(dashboardClient, /listDatabaseCyclePendingOperationsAuthenticated/);
assert.match(dashboardClient, /CyclesHistoryPanel/);
assert.match(dashboardClient, /DashboardTabs/);
assert.match(dashboardClient, /MarketListingsPanel/);
assert.match(dashboardClient, /BuyersPanel/);
assert.match(dashboardClient, /marketListDatabaseEntitlements/);
assert.match(dashboardClient, /activeTab === "list" && showDashboardTabs && canManage && database/);
assert.match(dashboardClient, /activeTab === "buyers" && showDashboardTabs && canManage/);
assert.match(dashboardClient, /activeTab === "settings" && showDashboardTabs && canManageSettings && database/);
assert.match(dashboardClient, /canManageListings=\{canManage\}/);
assert.match(dashboardClient, /canManageSettings=\{canManageSettings\}/);
assert.doesNotMatch(dashboardClient, /onCreateListing=\{createMarketListing\}/);
assert.match(dashboardClient, /listDatabaseCycleEntries/);
assert.match(dashboardClient, /listDatabaseCyclesPendingPurchasesAuthenticated/);
assert.match(dashboardClient, /CYCLES_HISTORY_LIMIT = 100/);
assert.match(dashboardClient, /identity && nextDatabase\?\.role === "owner"/);
assert.match(dashboardClient, /nextDatabase\.status === "active"/);
assert.doesNotMatch(dashboardClient, /pendingOperationCount/);
assert.match(dashboardClient, /router\.replace\("\/dashboard"\)/);
assert.match(dashboardClient, /setBusyAction\(\{ kind: "delete" \}\)/);
assert.doesNotMatch(dashboardClient, /expectedCyclesBalanceE8s|allowCycleDiscard|allow_balance_writeoff/);
assert.match(dashboardClient, /return message;/);
assert.match(dashboardClient, /onDelete=\{deleteDatabase\}/);
assert.match(dashboardAccessControl, /\| \{ kind: "delete" \}/);
assert.match(dashboardUi, /<DatabaseDangerZone/);
assert.match(dashboardUi, /export function DashboardSettingsPanel/);
assert.match(dashboardUi, /onRename: \(\) => void/);
assert.match(dashboardUi, /onClick=\{props\.onRename\}/);
assert.match(dashboardUi, /Rename database/);
assert.match(dashboardUi, /\{props\.databaseName\} \/ \{props\.databaseId\}/);
assert.doesNotMatch(ownerPanelSource, /<DatabaseDangerZone/);
assert.doesNotMatch(dashboardUi, /pendingOperationCount/);
assert.match(dashboardDangerZone, /export function DatabaseDangerZone/);
assert.match(dashboardDangerZone, /rounded-lg border border-red-200 bg-red-50\/60 shadow-sm/);
assert.match(dashboardDangerZone, /flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between/);
assert.doesNotMatch(dashboardDangerZone, /border-t border-red-200/);
assert.match(dashboardDangerZone, /ConfirmDeleteDatabaseDialog/);
assert.match(dashboardDangerZone, /const \[deleteError, setDeleteError\] = useState<string \| null>\(null\);/);
assert.match(dashboardDangerZone, /setDeleteError\(null\);/);
assert.match(dashboardDangerZone, /if \(error\) setDeleteError\(error\);/);
assert.match(dashboardDangerZone, /deleteError: string \| null;/);
assert.match(dashboardDangerZone, /role="alert"/);
assert.match(dashboardDangerZone, /This action is irreversible\. Archive first if recovery is required\./);
assert.match(dashboardDangerZone, /Type database ID to confirm/);
assert.doesNotMatch(dashboardDangerZone, /Withdraw balance before deleting|withdraw|writeoff/i);
assert.match(dashboardDangerZone, /Remaining cycles will be discarded\./);
assert.doesNotMatch(dashboardDangerZone, /pendingOperationCount|hasPendingOperations/);
assert.match(dashboardDangerZone, /typedDatabaseId === props\.databaseId/);
assert.match(dashboardDangerZone, /const deleteDisabled = props\.busy/);
assert.match(dashboardDangerZone, /disabled=\{props\.busy \|\| !deleteConfirmed\}/);
assert.match(dashboardDangerZone, /!props\.deleting && event\.target === event\.currentTarget\) props\.onCancel\(\)/);
assert.match(vfsIdl, /const DeleteDatabaseRequest = idl\.Record/);
assert.match(vfsIdl, /delete_database: idl\.Func\(\[DeleteDatabaseRequest\], \[ResultUnit\], \[\]\)/);
assert.doesNotMatch(dashboardHomeClient, /process\.env\.KINIC_WIKI_CANISTER_ID/);
assert.doesNotMatch(dashboardClient, /process\.env\.KINIC_WIKI_CANISTER_ID/);

assert.match(dashboardUi, /type PendingAclAction/);
assert.match(dashboardUi, /Enable public access/);
assert.match(dashboardUi, /Disable public access/);
assert.match(dashboardUi, /Grant owner access/);
assert.match(dashboardUi, /Revoke owner access/);
assert.match(dashboardUi, /ConfirmAclDialog/);
assert.match(dashboardUi, /!props\.busy && event\.target === event\.currentTarget\) props\.onCancel\(\)/);
assert.match(dashboardUi, /This will grant \$\{role\} access to principal/);
assert.match(dashboardUi, /ActionButton/);
assert.match(dashboardUi, /isRoutableDatabaseId/);
assert.match(dashboardUi, /xShareDatabaseHref/);
assert.match(dashboardUi, /Share2/);
assert.match(dashboardUi, /loadingLabel="Granting\.\.\."/);
assert.match(dashboardUi, /Enable LLM writer/);
assert.match(dashboardUi, /Disable LLM writer/);
assert.match(dashboardUi, /Set LLM writer/);
assert.match(dashboardUi, /flex flex-col gap-2 sm:flex-row sm:items-center/);
assert.doesNotMatch(dashboardUi, /\{props\.label\}: \{props\.enabled \? "enabled" : "disabled"\}/);
assert.match(dashboardUi, /export function RenameDatabaseDialog/);
assert.match(dashboardUi, /maxLength=\{80\}/);
assert.match(dashboardUi, /const submitDisabled = props\.busy \|\| trimmed === "" \|\| trimmed === props\.databaseName;/);
assert.match(dashboardUi, /props\.busyAction\?\.kind === "rename"/);
assert.doesNotMatch(dashboardUi, /const \[databaseName, setDatabaseName\]/);
assert.doesNotMatch(dashboardUi, /sm:flex-row sm:items-end/);
assert.match(dashboardUi, /role or cycles state changes/);
assert.match(dashboardUi, /databaseCyclesView/);
assert.match(dashboardUi, /databaseCyclesHref/);
assert.match(dashboardUi, /export type DashboardTab = "access" \| "list" \| "buyers" \| "cycles-history" \| "settings"/);
assert.match(dashboardUi, /export function MarketListingsPanel/);
assert.match(marketListingsPanelSource, /const \[tags, setTags\] = useState<string\[\]>\(\[\]\);/);
assert.match(marketListingsPanelSource, /<section className="rounded-lg border border-line bg-paper shadow-sm">/);
assert.doesNotMatch(marketListingsPanelSource, /grid gap-4 border-t border-line px-4 py-4/);
assert.match(marketListingsPanelSource, /Add tag/);
assert.match(marketListingsPanelSource, /aria-label=\{`Tag \$\{index \+ 1\}`\}/);
assert.match(marketListingsPanelSource, /Remove/);
assert.match(dashboardUi, /function tagsJsonFromTags\(value: string\[\]\): string/);
assert.match(dashboardUi, /return JSON\.stringify\(value\.map\(\(tag\) => tag\.trim\(\)\)\.filter\(\(tag\) => tag\.length > 0\)\);/);
assert.match(dashboardUi, /function tagsFromJson\(value: string\): string\[\]/);
assert.doesNotMatch(dashboardUi, /tagsJsonFromInput|\.split\(","\)|join\(", "\)/);
assert.match(dashboardUi, /export function BuyersPanel/);
assert.match(dashboardUi, /canManageListings/);
assert.match(dashboardUi, /canManageSettings/);
assert.match(dashboardUi, /label="List"/);
assert.match(dashboardUi, /label="Buyers"/);
assert.match(dashboardUi, /label="Settings"/);
assert.match(dashboardUi, /Readonly list of marketplace reader access/);
assert.match(dashboardUi, /Cycles History/);
assert.match(dashboardUi, /Pending purchases/);
assert.match(dashboardUi, /Ledger entries/);
assert.match(dashboardUi, /RequiredActionBadge/);
assert.match(dashboardUi, /formatRawCycles/);
assert.match(dashboardUi, /Your Role/);
assert.doesNotMatch(dashboardUi, /label="Principal"/);
assert.match(dashboardUi, /databaseStatusLabel/);
assert.match(dashboardUi, /active: "Active"/);
assert.match(dashboardUi, /deleted: "Deleted"/);
assert.match(dashboardUi, /SummaryActionLink/);
assert.match(dashboardUi, /Wallet/);
assert.match(dashboardUi, /BookOpen/);
assert.doesNotMatch(dashboardUi, /Minimum update/);
assert.match(homeUi, /Cycles/);
assert.match(homeUi, /Cycles/);
assert.match(dashboardHomeClient, /getCyclesBillingConfig/);
assert.match(vfsClient, /export async function listDatabaseCycleEntries/);
assert.match(vfsClient, /export async function listDatabaseCyclesPendingPurchasesAuthenticated/);
assert.match(vfsClient, /normalizeDatabaseCycleEntryPage/);
assert.match(vfsClient, /normalizeDatabaseCyclesPendingPurchase/);
assert.doesNotMatch(vfsClient, /redacted/);
assert.doesNotMatch(cyclesState, /Cycles unknown/);
assert.doesNotMatch(homeUi, /Cycles unknown \/ 0 e8s/);
assert.doesNotMatch(dashboardUi, /Cycles unknown \/ 0 e8s/);
assert.match(dashboardUi, /principalDisplayName\(props\.action\.principalText\)/);
assert.match(dashboardMemberTable, /loadingLabel="Revoking\.\.\."/);
assert.match(dashboardMemberTable, /onRoleChange/);
assert.match(dashboardMemberTable, /loadingLabel="Saving\.\.\."/);
assert.match(dashboardMemberTable, /principalDisplayName\(props\.member\.principal\)/);
assert.match(dashboardMemberTable, /ownMember \? " \(you\)" : ""/);
assert.match(dashboardAccessControl, /DATABASE_ROLES/);
assert.match(dashboardAccessControl, /LLM_WRITER_PRINCIPAL = "ckurn-x74ln-nemlm-42vfv-gej7r-4cc3e-v22e5-otcod-jndlh-pbst4-3qe"/);
assert.match(dashboardAccessControl, /LLM_WRITER_LABEL = "LLM writer"/);
assert.match(dashboardAccessControl, /principalDisplayName/);
assert.match(dashboardActionButton, /Loader2/);
assert.match(dashboardActionButton, /aria-busy/);
assert.match(dashboardActionButton, /hover:-translate-y-\[3px\]/);
assert.match(dashboardClient, /busyAction/);
assert.match(dashboardClient, /Access updated\./);

assert.match(dashboardHomeClient, /refreshSeqRef/);
assert.match(dashboardHomeClient, /isCurrentRefresh/);
assert.match(dashboardClient, /refreshSeqRef/);
assert.match(dashboardClient, /isCurrentRefresh/);
assert.match(appSession, /await authClient\.logout\(\);/);
assert.match(appSession, /setPrincipal\(null\);/);
assert.match(appSession, /clearWallet\(\);/);
assert.match(dashboardHomeClient, /const createDatabaseAction = \(/);
assert.match(dashboardHomeClient, /<DatabaseBody createDatabaseAction=\{createDatabaseAction\}/);
assert.match(dashboardHomeClient, /\{createDatabaseAction\}\s*<\/div>\s*<DatabaseBody createDatabaseAction=\{createDatabaseAction\}/);
assert.match(homeUi, /<DatabaseSection action=\{createDatabaseAction\}/);
assert.doesNotMatch(dashboardHomeClient, /setCreatedDatabase/);
assert.doesNotMatch(dashboardHomeClient, /setDatabases\(\[\]\);\n    setCreatedDatabaseId\(null\);\n    setError\(null\);\n    setWarning\(null\);\n    setLoadState\("idle"\);/);
assert.doesNotMatch(dashboardClient, /await authClient\.logout/);
assert.match(adminShell, /onClick=\{\(\) => void logout\(\)\}/);

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
    Date,
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

console.log("Dashboard checks OK");
