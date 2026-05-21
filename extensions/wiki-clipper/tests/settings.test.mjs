// Where: extensions/wiki-clipper/tests/settings.test.mjs
// What: Settings UI and database-list filtering tests.
// Why: URL ingest setup should expose only writable DB choices and no fixed runtime URLs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AUTH_OPTIONS } from "../src/auth-client.js";
import { normalizeWritableDatabases } from "../src/vfs-actor.js";
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
  assert.match(html, /Kinic Wiki Clipper/);
  assert.match(html, /icons\/icon-48\.png/);
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
  assert.match(storeAssets, /#ff2686/);
  assert.match(storeAssets, /icons\/icon-128\.png/);
  assert.match(contentUi, /Kinic Wiki Clipper/);
  assert.match(contentUi, /ChatGPT export/);
  assert.doesNotMatch(contentUi, /Kinic Memory/);
});

test("manifest exposes settings as options page without popup", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.options_page, "popup/popup.html");
  assert.equal(manifest.action.default_popup, undefined);
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.ok(manifest.host_permissions.includes("https://wiki.kinic.xyz/*"));
  assert.equal(manifest.host_permissions.includes("https://*.icp0.io/*"), false);
  assert.equal(manifest.host_permissions.includes("http://127.0.0.1/*"), false);
  assert.equal(manifest.host_permissions.includes("http://localhost/*"), false);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["icons/icon-32.png"],
      matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
    }
  ]);
  assert.equal(manifest.icons["128"], "icons/icon-128.png");
  assert.equal(manifest.action.default_icon["128"], "icons/icon-128.png");
});

test("database dropdown options include only hot owner and writer databases", () => {
  const databases = normalizeWritableDatabases([
    rawDatabase("owner-db", "Owner", "Hot"),
    rawDatabase("writer-db", "Writer", "Hot"),
    rawDatabase("reader-db", "Reader", "Hot"),
    rawDatabase("archived-db", "Owner", "Archived")
  ]);
  assert.deepEqual(
    databases.map((database) => [database.databaseId, database.name, database.role, database.status]),
    [
      ["owner-db", "owner-db name", "Owner", "Hot"],
      ["writer-db", "writer-db name", "Writer", "Hot"]
    ]
  );
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

function rawDatabase(databaseId, role, status) {
  return {
    database_id: databaseId,
    name: `${databaseId} name`,
    role: { [role]: null },
    status: { [status]: null },
    logical_size_bytes: 0n,
    archived_at_ms: [],
    deleted_at_ms: []
  };
}
