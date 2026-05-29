// Where: extensions/wiki-clipper/tests/settings.test.mjs
// What: Settings UI and database-list filtering tests.
// Why: URL ingest setup should expose only writable DB choices and no fixed runtime URLs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AUTH_OPTIONS } from "../src/auth-client.js";
import { createDatabaseWithActor, normalizeWritableDatabases } from "../src/vfs-actor.js";
import {
  DEFAULT_DATABASE_NAME,
  databaseOptionLabel,
  mergePreferredDatabase,
  shouldShowCreateDatabaseForm,
  validateCreateDatabaseName
} from "../popup/popup-state.js";
import {
  AUTH_SESSION_TTL_MS,
  AUTH_SESSION_TTL_NS,
  MAINNET_II_PROVIDER_URL,
  WIKI_CANISTER_DERIVATION_ORIGIN,
  derivationOriginForLocation
} from "../../../shared/ii-auth/index.js";

test("settings popup omits fixed runtime inputs", () => {
  const html = readFileSync(new URL("../popup/popup.html", import.meta.url), "utf8");
  assert.match(html, /<select id="database-id">/);
  assert.match(html, /<form id="create-database-form"/);
  assert.match(html, /Database name/);
  assert.match(html, /id="create-database"/);
  assert.match(html, /Kinic Wiki Clipper/);
  assert.match(html, /icons\/icon-48\.png/);
  assert.doesNotMatch(html, /refresh-databases/);
  assert.doesNotMatch(html, /save-settings/);
  assert.doesNotMatch(html, /settings-actions/);
  assert.doesNotMatch(html, /generator-url/);
  assert.doesNotMatch(html, /canister-id/);
  assert.doesNotMatch(html, /IC host/);
});

test("settings and ChatGPT export use Kinic brand colors", () => {
  const popupCss = readFileSync(new URL("../popup/popup.css", import.meta.url), "utf8");
  const contentUi = readFileSync(new URL("../src/content-ui.tsx", import.meta.url), "utf8");
  const storeAssets = readFileSync(new URL("../scripts/generate-store-assets.mjs", import.meta.url), "utf8");
  assert.match(popupCss, /margin: 0 auto/);
  assert.match(popupCss, /width: min\(380px, calc\(100vw - 28px\)\)/);
  assert.match(popupCss, /--kinic-hot-pink: #ff2686/);
  assert.match(popupCss, /--kinic-ink: #000000/);
  assert.match(contentUi, /--kinic-hot-pink:#ff2686/);
  assert.match(contentUi, /chrome\.runtime\.getURL\("icons\/icon-32\.png"\)/);
  assert.match(contentUi, /type: "open-settings"/);
  assert.match(contentUi, /type: "list-writable-databases"/);
  assert.match(contentUi, /type: "save-config"/);
  assert.match(contentUi, /<select value=\{config\.value\.databaseId\}/);
  assert.match(contentUi, /databaseOptionLabel/);
  assert.match(contentUi, /exportProviderLabel/);
  assert.match(contentUi, /onFocus=\{\(event\) => event\.currentTarget\.select\(\)\}/);
  assert.match(contentUi, /onMouseUp=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(storeAssets, /#ff2686/);
  assert.match(storeAssets, /icons\/icon-128\.png/);
  assert.match(contentUi, /Kinic Wiki Clipper/);
  assert.match(contentUi, /providerLabel/);
  assert.doesNotMatch(contentUi, /Database ID/);
  assert.doesNotMatch(contentUi, /Kinic Memory/);
});

test("manifest exposes settings as options page without popup", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.options_page, "popup/popup.html");
  assert.equal(manifest.action.default_popup, undefined);
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.ok(manifest.host_permissions.includes("https://wiki.kinic.xyz/*"));
  assert.ok(manifest.host_permissions.includes("https://claude.ai/*"));
  assert.equal(manifest.host_permissions.includes("https://*.icp0.io/*"), false);
  assert.equal(manifest.host_permissions.includes("http://127.0.0.1/*"), false);
  assert.equal(manifest.host_permissions.includes("http://localhost/*"), false);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["icons/icon-32.png"],
      matches: ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*"]
    }
  ]);
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.matches),
    [["https://chatgpt.com/*", "https://chat.openai.com/*"], ["https://claude.ai/*"]]
  );
  assert.equal(manifest.icons["128"], "icons/icon-128.png");
  assert.equal(manifest.action.default_icon["128"], "icons/icon-128.png");
});

test("database creation delegates create_database and normalizes result", async () => {
  const calls = [];
  const result = await createDatabaseWithActor(
    {
      async create_database(request) {
        calls.push(request);
        return { Ok: { database_id: "db_created", name: request.name } };
      }
    },
    "My Team Wiki"
  );

  assert.deepEqual(calls, [{ name: "My Team Wiki" }]);
  assert.deepEqual(result, { databaseId: "db_created", name: "My Team Wiki" });
});

test("database creation surfaces canister errors", async () => {
  await assert.rejects(
    () =>
      createDatabaseWithActor(
        {
          async create_database() {
            return { Err: "database name is too long" };
          }
        },
        "x"
      ),
    /database name is too long/
  );
});

test("create database form only appears for authenticated users without writable databases", () => {
  assert.equal(DEFAULT_DATABASE_NAME, "My Kinic Wiki");
  assert.equal(shouldShowCreateDatabaseForm({ isAuthenticated: true, writableDatabaseCount: 0 }), true);
  assert.equal(shouldShowCreateDatabaseForm({ isAuthenticated: true, writableDatabaseCount: 1 }), false);
  assert.equal(shouldShowCreateDatabaseForm({ isAuthenticated: false, writableDatabaseCount: 0 }), false);
});

test("create database name validation trims and rejects empty names", () => {
  assert.equal(validateCreateDatabaseName("  Team Wiki  "), "Team Wiki");
  assert.throws(() => validateCreateDatabaseName("  "), /Database name is required/);
});

test("database dropdown options include only active owner and writer databases", () => {
  const databases = normalizeWritableDatabases([
    rawDatabase("owner-db", "Owner", "Active", 20_000n),
    rawDatabase("legacy-owner-db", "Owner", "Hot", 20_000n),
    rawDatabase("writer-db", "Writer", "Active", 20_000n),
    rawDatabase("reader-db", "Reader", "Active", 20_000n),
    rawDatabase("archived-db", "Owner", "Archived", 20_000n)
  ], { minUpdateCredits: "10000" });
  assert.deepEqual(
    databases.map((database) => [database.databaseId, database.name, database.role, database.status, database.writeCreditsAvailable]),
    [
      ["owner-db", "owner-db name", "Owner", "Active", true],
      ["legacy-owner-db", "legacy-owner-db name", "Owner", "Active", true],
      ["writer-db", "writer-db name", "Writer", "Active", true]
    ]
  );
});

test("database dropdown keeps credits-disabled writer databases with reasons", () => {
  const databases = normalizeWritableDatabases([
    rawDatabase("active-db", "Owner", "Active", 20_000n),
    rawDatabase("low-db", "Writer", "Active", 9_999n),
    rawDatabase("suspended-db", "Writer", "Active", 20_000n, 1n)
  ], { minUpdateCredits: "10000" });
  assert.deepEqual(
    databases.map((database) => [database.databaseId, database.writeCreditsAvailable, database.creditsReason]),
    [
      ["active-db", true, null],
      ["low-db", false, "Database credits balance is below the minimum update balance."],
      ["suspended-db", false, "Database credits are suspended."]
    ]
  );
});

test("database dropdown disables writer databases when credits config is unavailable", () => {
  const databases = normalizeWritableDatabases([
    rawDatabase("owner-db", "Owner", "Active", 20_000n)
  ]);
  assert.deepEqual(
    databases.map((database) => [database.databaseId, database.writeCreditsAvailable, database.creditsReason]),
    [["owner-db", false, "Credits config unavailable."]]
  );
});

test("database dropdown labels prefer names and disambiguate duplicates", () => {
  assert.equal(databaseOptionLabel(rawDatabase("team-db-1", "Writer", "Active", "Team Wiki")), "Team Wiki (Writer)");
  assert.equal(
    databaseOptionLabel(rawDatabase("team-db-2-long-id", "Owner", "Active", "Team Wiki"), 2),
    "Team Wiki (Owner, team-db-2-...)"
  );
  assert.equal(databaseOptionLabel(rawDatabase("legacy-db", "Writer", "Active", "")), "legacy-db (Writer, legacy-db)");
});

test("preferred created database is kept when database list query is stale", () => {
  assert.deepEqual(mergePreferredDatabase([], { databaseId: "db_created", name: "Created Wiki" }), [
    {
      databaseId: "db_created",
      name: "Created Wiki",
      role: "Owner",
      status: "Active",
      logicalSizeBytes: "0"
    }
  ]);
  const databases = normalizeWritableDatabases([rawDatabase("db_created", "Owner", "Active", "Created Wiki")]);
  assert.equal(mergePreferredDatabase(databases, { databaseId: "db_created", name: "Created Wiki" }), databases);
});

test("Internet Identity options use 29 day TTL and derivation origin", () => {
  assert.equal(AUTH_OPTIONS.loginOptions.identityProvider, MAINNET_II_PROVIDER_URL);
  assert.equal(AUTH_OPTIONS.loginOptions.derivationOrigin, WIKI_CANISTER_DERIVATION_ORIGIN);
  assert.equal(AUTH_OPTIONS.loginOptions.maxTimeToLive, AUTH_SESSION_TTL_NS);
  assert.equal(AUTH_OPTIONS.createOptions.idleOptions.idleTimeout, AUTH_SESSION_TTL_MS);
  assert.equal(AUTH_OPTIONS.createOptions.idleOptions.disableDefaultIdleCallback, true);
});

test("CLI login derivation origin uses local origin only for local development", () => {
  assert.equal(
    derivationOriginForLocation({
      hostname: "wiki.kinic.xyz",
      origin: "https://wiki.kinic.xyz"
    }),
    WIKI_CANISTER_DERIVATION_ORIGIN
  );
  assert.equal(
    derivationOriginForLocation({
      hostname: "xis3j-paaaa-aaaai-axumq-cai.icp0.io",
      origin: WIKI_CANISTER_DERIVATION_ORIGIN
    }),
    WIKI_CANISTER_DERIVATION_ORIGIN
  );
  assert.equal(
    derivationOriginForLocation({
      hostname: "localhost",
      origin: "http://localhost:4943"
    }),
    "http://localhost:4943"
  );
});

test("ChatGPT export confirmation references Internet Identity principal", () => {
  const contentUi = readFileSync(new URL("../src/content-ui.tsx", import.meta.url), "utf8");
  assert.match(contentUi, /Internet Identity principal/);
  assert.doesNotMatch(contentUi, /anonymous extension actor/);
});

test("settings docs describe automatic database save", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const usage = readFileSync(new URL("../USAGE.md", import.meta.url), "utf8");
  const storeAssets = readFileSync(new URL("../scripts/generate-store-assets.mjs", import.meta.url), "utf8");
  assert.match(readme, /selected and saved automatically/);
  assert.match(usage, /saved automatically/);
  assert.match(storeAssets, /Database selected/);
  assert.doesNotMatch(readme, /explicitly saved/);
  assert.doesNotMatch(usage, /save it before/);
  assert.doesNotMatch(storeAssets, /Save settings/);
  assert.doesNotMatch(storeAssets, /Refresh/);
});

function rawDatabase(databaseId, role, status, nameOrBalance = 20_000n, creditsSuspendedAtMs = null) {
  const name = typeof nameOrBalance === "string" ? nameOrBalance : `${databaseId} name`;
  const creditsBalance = typeof nameOrBalance === "bigint" ? nameOrBalance : 20_000n;
  return {
    database_id: databaseId,
    name,
    role: { [role]: null },
    status: { [status]: null },
    logical_size_bytes: 0n,
    credits_balance: [creditsBalance],
    credits_suspended_at_ms: creditsSuspendedAtMs === null ? [] : [creditsSuspendedAtMs],
    archived_at_ms: []
  };
}
