// Where: extensions/wiki-clipper/tests/settings.test.mjs
// What: Settings UI and database-list filtering tests.
// Why: source capture setup should expose only writable DB choices and no fixed runtime URLs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AUTH_OPTIONS } from "../src/auth-client.js";
import { createDatabaseWithActor, normalizeWritableDatabases } from "../src/vfs-actor.js";
import {
  DEFAULT_DATABASE_NAME,
  databaseOptionLabel,
  isSelectedWritableDatabase,
  mergePreferredDatabase,
  shouldShowCreateDatabaseForm,
  validateCreateDatabaseName
} from "../popup/popup-state.js";
import {
  AUTH_SESSION_TTL_MS,
  AUTH_SESSION_TTL_NS,
  MAINNET_II_PROVIDER_URL,
  WIKI_CANISTER_DERIVATION_ORIGIN,
  derivationOriginForLocation,
  identityProviderUrlForLocation
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
  assert.match(contentUi, /onClick=\{openPanel\}/);
  assert.match(contentUi, /isSelectedWritableDatabase/);
  assert.match(contentUi, /const exportStartInFlight = signal\(false\)/);
  assert.match(contentUi, /const exportLocked = computed\(\(\) => exportStartInFlight\.value \|\| status\.value === "exporting"\)/);
  assert.match(contentUi, /const canExport = computed\(\(\) => !exportLocked\.value && selectedWritableDatabase\.value\)/);
  assert.match(contentUi, /disabled=\{exportLocked\.value \|\| databaseStatus\.value !== "ready"\}/);
  assert.match(contentUi, /let configLoadPromise = Promise\.resolve\(\)/);
  assert.match(contentUi, /configLoadPromise = loadConfig\(\)/);
  assert.match(contentUi, /async function openPanel\(\)/);
  assert.match(contentUi, /await refreshDatabases\(\)/);
  assert.match(contentUi, /await configLoadPromise/);
  assert.match(contentUi, /<select value=\{config\.value\.databaseId\}/);
  assert.match(contentUi, /writeCyclesAvailable !== false/);
  assert.match(contentUi, /saveDatabase\(""\)/);
  assert.match(startExportFunction(contentUi), /const requestedDatabaseId = nextConfig\.databaseId/);
  assert.match(startExportFunction(contentUi), /await refreshDatabases\(\{ repairSelection: false \}\)/);
  assert.match(startExportFunction(contentUi), /databaseId: requestedDatabaseId/);
  assert.match(startExportFunction(contentUi), /!requestedDatabaseId \|\| !requestedWritableDatabase/);
  assert.match(refreshDatabasesFunction(contentUi), /repairSelection = true/);
  assert.match(refreshDatabasesFunction(contentUi), /if \(!repairSelection\) return/);
  assertExportLockBeforeClearingLogs(startExportFunction(contentUi));
  assert.match(startExportFunction(contentUi), /exportStartInFlight\.value = true/);
  assert.match(startExportFunction(contentUi), /finally \{\s+exportStartInFlight\.value = false;\s+\}/);
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
  assert.doesNotMatch(loadConfigFunction(contentUi), /refreshDatabases/);
});

test("settings popup clears database on logout and fails closed on auth reset errors", () => {
  const popupJs = readFileSync(new URL("../popup/popup.js", import.meta.url), "utf8");
  const logoutHandler = eventHandlerFunction(popupJs, "logoutButton");
  const notifyAuthSessionChanged = namedFunction(popupJs, "notifyAuthSessionChanged");
  assert.match(logoutHandler, /await logoutInternetIdentity\(\)/);
  assert.match(logoutHandler, /await saveDatabaseSelection\(""\)/);
  assert.match(logoutHandler, /await notifyAuthSessionChanged\(\)/);
  assert.match(logoutHandler, /await refreshAuthAndDatabases\(\)/);
  assert.doesNotMatch(notifyAuthSessionChanged, /catch/);
  assert.match(notifyAuthSessionChanged, /await send\(\{ type: "auth-session-changed" \}\)/);
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
    rawDatabase("writer-db", "Writer", "Active", 20_000n),
    rawDatabase("reader-db", "Reader", "Active", 20_000n),
    rawDatabase("archived-db", "Owner", "Archived", 20_000n)
  ], { minUpdateCycles: "10000" });
  assert.deepEqual(
    databases.map((database) => [database.databaseId, database.name, database.role, database.status, database.writeCyclesAvailable]),
    [
      ["owner-db", "owner-db name", "Owner", "Active", true],
      ["writer-db", "writer-db name", "Writer", "Active", true]
    ]
  );
});

test("database dropdown keeps cycles-disabled writer databases with reasons", () => {
  const databases = normalizeWritableDatabases([
    rawDatabase("active-db", "Owner", "Active", 20_000n),
    rawDatabase("low-db", "Writer", "Active", 9_999n),
    rawDatabase("suspended-db", "Writer", "Active", 20_000n, 1n)
  ], { minUpdateCycles: "10000" });
  assert.deepEqual(
    databases.map((database) => [database.databaseId, database.writeCyclesAvailable, database.cyclesReason]),
    [
      ["active-db", true, null],
      ["low-db", false, "Database cycles balance is below the minimum update balance."],
      ["suspended-db", false, "Database cycles are suspended."]
    ]
  );
});

test("database dropdown disables writer databases when cycles config is unavailable", () => {
  const databases = normalizeWritableDatabases([
    rawDatabase("owner-db", "Owner", "Active", 20_000n)
  ]);
  assert.deepEqual(
    databases.map((database) => [database.databaseId, database.writeCyclesAvailable, database.cyclesReason]),
    [["owner-db", false, "Cycles config unavailable."]]
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

test("export requires the selected database to be verified writable", () => {
  const databases = [{ databaseId: "team-db" }];
  assert.equal(isSelectedWritableDatabase({ databaseStatus: "loading", databaseId: "team-db", databases }), false);
  assert.equal(isSelectedWritableDatabase({ databaseStatus: "ready", databaseId: "missing-db", databases }), false);
  assert.equal(isSelectedWritableDatabase({ databaseStatus: "ready", databaseId: "  team-db  ", databases }), true);
});

test("preferred created database is kept only when it is active and writable", () => {
  assert.deepEqual(mergePreferredDatabase([], { databaseId: "db_created", name: "Created Wiki" }), []);
  assert.deepEqual(mergePreferredDatabase([], rawDatabase("pending-db", "Owner", "Pending", "Pending Wiki")), []);
  assert.deepEqual(mergePreferredDatabase([], rawDatabase("reader-db", "Reader", "Active", "Read Wiki")), []);
  assert.deepEqual(mergePreferredDatabase([], rawDatabase("db_created", "Owner", "Active", "Created Wiki")), [
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

test("CLI login helpers use mainnet Internet Identity and canonical derivation origin", () => {
  assert.equal(
    identityProviderUrlForLocation({
      hostname: "localhost",
      origin: "http://localhost:4943"
    }),
    MAINNET_II_PROVIDER_URL
  );
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
    WIKI_CANISTER_DERIVATION_ORIGIN
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

function rawDatabase(databaseId, role, status, nameOrBalance = 20_000n, cyclesSuspendedAtMs = null) {
  const name = typeof nameOrBalance === "string" ? nameOrBalance : `${databaseId} name`;
  const cyclesBalance = typeof nameOrBalance === "bigint" ? nameOrBalance : 20_000n;
  return {
    database_id: databaseId,
    name,
    role: { [role]: null },
    status: { [status]: null },
    logical_size_bytes: 0n,
    cycles_balance: [cyclesBalance],
    cycles_suspended_at_ms: cyclesSuspendedAtMs === null ? [] : [cyclesSuspendedAtMs],
    archived_at_ms: [],
    deleted_at_ms: []
  };
}

function loadConfigFunction(source) {
  const match = /async function loadConfig\(\) \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(match, "loadConfig function should exist");
  return match[0];
}

function startExportFunction(source) {
  return namedFunction(source, "startExport");
}

function refreshDatabasesFunction(source) {
  const match = /async function refreshDatabases\(\{ repairSelection = true \} = \{\}\) \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(match, "refreshDatabases function should exist");
  return match[0];
}

function namedFunction(source, name) {
  const match = new RegExp(`async function ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(match, `${name} function should exist`);
  return match[0];
}

function eventHandlerFunction(source, targetName) {
  const match = new RegExp(`${targetName}\\.addEventListener\\("click", async \\(\\) => \\{([\\s\\S]*?)\\n\\}\\);`).exec(source);
  assert.ok(match, `${targetName} click handler should exist`);
  return match[0];
}

function assertExportLockBeforeClearingLogs(source) {
  const guardIndex = source.indexOf("if (exportLocked.value) return;");
  const lockIndex = source.indexOf("exportStartInFlight.value = true;");
  const errorClearIndex = source.indexOf('error.value = "";');
  const logsClearIndex = source.indexOf("logs.value = [];");
  assert.ok(guardIndex >= 0, "startExport should guard on exportLocked");
  assert.ok(lockIndex > guardIndex, "startExport should lock after the guard");
  assert.ok(errorClearIndex > lockIndex, "startExport should preserve existing error on duplicate clicks");
  assert.ok(logsClearIndex > lockIndex, "startExport should preserve existing logs on duplicate clicks");
}
