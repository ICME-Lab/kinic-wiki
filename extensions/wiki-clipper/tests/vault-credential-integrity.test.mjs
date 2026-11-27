import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "@kinic/vault-client/session";
import { VaultEngine } from "../src/vault/vault-engine.ts";
import { handleMessage, setServiceWorkerDepsForTest } from "../src/vault/service-worker.ts";

const id = new Uint8Array(16).fill(1);
const objectIdHex = "01".repeat(16);
const mainUrl = "https://primary.example";
const additionalUrl = "https://secondary.example";
const record = {
  label: "Accounts", username: "primary", password: "primary-value", URL: mainUrl,
  additionalLogins: [{ username: "secondary", password: "secondary-value", URL: additionalUrl }]
};
const metadata = { kind: "credential", title: "Accounts", username: "primary", domains: ["primary.example", "secondary.example"] };
const revision = { object: id, vault: id, revision: 1n, sequence: 1n, deleted: false };

test("inline fill rejects an item whose primary login does not match the site", async () => {
  const url = additionalUrl;
  setServiceWorkerDepsForTest({
    extensionId: () => "kinic",
    storage: { getLocal: async () => ({}) },
    scheduleAutoLock: async () => {},
    offscreenBridge: async (message) => {
      if (message.type === "get-matches-for-url") {
        return { ok: true, result: { unlocked: true, matches: [{ objectIdHex }] } };
      }
      assert.equal(message.type, "read-item");
      return { ok: true, result: { summary: { ...metadata }, username: record.username,
        password: record.password, url: mainUrl, urls: [mainUrl], totp: null } };
    }
  });
  try {
    await assert.rejects(handleMessage({ type: "fill-inline-item", objectIdHex },
      { id: "kinic", frameId: 0, tab: { id: 1, url } }), /CREDENTIAL_DOMAIN_MISMATCH/);
  } finally {
    setServiceWorkerDepsForTest({});
  }
});

async function unlockedEngine(source = record, indexedMetadata = metadata) {
  const session = new Session();
  let saved;
  const client = {
    session,
    listVaults: async () => [{ id, state: { Active: null }, name: ["Vault"] }],
    listAccessibleVaults: async () => ({ entries: [], next: [] }),
    open: async () => { session.root = {}; },
    items: async () => [{ revision, metadata: indexedMetadata }],
    read: async () => ({ metadata: indexedMetadata, plaintext: new TextEncoder().encode(JSON.stringify(source)) }),
    save: async (nextMetadata, plaintext) => {
      saved = { metadata: nextMetadata, record: JSON.parse(new TextDecoder().decode(plaintext)) };
      return { ...revision, revision: 2n };
    }
  };
  const engine = new VaultEngine({
    authSnapshot: async () => ({ isAuthenticated: true, identity: {}, principal: "owner" }),
    createVaultClient: async () => client,
  });
  await engine.unlockVault();
  return { engine, client, saved: () => saved };
}

test("editing the primary login preserves additional logins", async () => {
  const fixture = await unlockedEngine();
  await fixture.engine.saveCredential({ objectIdHex, title: "Updated", username: "primary", password: "new-value", url: mainUrl });
  assert.deepEqual(fixture.saved().record.additionalLogins, record.additionalLogins);
  assert.deepEqual(fixture.saved().metadata.domains, ["primary.example", "secondary.example"]);
});

test("autofill offers each account for the site and fills only the selected account", async () => {
  const fixture = await unlockedEngine({
    ...record,
    additionalLogins: [...record.additionalLogins,
      { URL: additionalUrl, username: "another", password: "another-value" }],
  });
  const { engine } = fixture;
  const result = await engine.getLoginMatchesForUrl(additionalUrl);
  assert.deepEqual(result.matches.map(item => item.username), ["secondary", "another"]);
  assert.ok(result.matches.every(item => !("password" in item)));
  assert.deepEqual(await engine.readLoginForUrl(result.matches[1], additionalUrl),
    { username: "another", password: "another-value", totp: null });
  await assert.rejects(engine.readLoginForUrl(result.matches[1], mainUrl), /CREDENTIAL_DOMAIN_MISMATCH/);
  await assert.rejects(engine.readLoginForUrl({ ...result.matches[1], revision: "0" }, additionalUrl), /ITEM_CHANGED/);
});

test("the save banner updates the matching secondary account only", async () => {
  const { engine, saved } = await unlockedEngine();
  const decision = await engine.evaluateSubmittedLogin({ url: additionalUrl, username: "secondary", password: "changed" });
  assert.equal(decision.action, "update");
  await engine.saveCredential({ objectIdHex, loginIndex: decision.existingLoginIndex,
    expectedRevision: decision.existingRevision, title: "Accounts", username: "secondary",
    password: "changed", url: additionalUrl });
  assert.equal(saved().record.password, "primary-value");
  assert.equal(saved().record.additionalLogins[0].password, "changed");
});

test("popup fill stops if the active origin changed after selection", async () => {
  setServiceWorkerDepsForTest({
    extensionId: () => "kinic",
    queryActiveTab: async () => ({ id: 1, url: "https://another.example" }),
    offscreenBridge: async () => ({ ok: true, result: { username: "alice", password: "example", totp: null } }),
    sendToTab: async () => ({ ok: true, result: { filledPassword: true } }),
    storage: { getLocal: async () => ({}) },
    scheduleAutoLock: async () => {},
  });
  try {
    await assert.rejects(handleMessage({ type: "fill-active-tab", objectIdHex, revision: "1", loginIndex: 0,
      expectedOrigin: mainUrl }, { id: "kinic", url: "chrome-extension://kinic/popup" }), /origin changed/);
  } finally {
    setServiceWorkerDepsForTest({});
  }
});

test("a login is not returned after its revision changes during decryption", async () => {
  const { engine, client } = await unlockedEngine();
  const selected = (await engine.getLoginMatchesForUrl(additionalUrl)).matches[0];
  const originalRead = client.read;
  const started = Promise.withResolvers();
  const result = Promise.withResolvers();
  client.read = async (...args) => {
    client.read = originalRead;
    started.resolve();
    await result.promise;
    return originalRead(...args);
  };
  const pending = engine.readLoginForUrl(selected, additionalUrl);
  await started.promise;
  await engine.saveCredential({ objectIdHex, title: "Updated", username: "primary", password: "new", url: mainUrl });
  result.resolve();
  await assert.rejects(pending, /ITEM_CHANGED/);
});

test("a saturated manifest still finds a login outside its domain index", async () => {
  const { engine } = await unlockedEngine(record, {
    ...metadata, domains: Array.from({ length: 32 }, (_, index) => `index-${index}.example`),
  });
  const result = await engine.getLoginMatchesForUrl(additionalUrl);
  assert.deepEqual(result.matches.map(item => item.username), ["secondary"]);
});

test("a pending save banner is not shown on a different origin of the same host", async () => {
  setServiceWorkerDepsForTest({
    extensionId: () => "kinic",
    now: () => 100,
    storage: {
      getSession: async key => ({ [key]: { 1: {
        id: "pending", domain: "primary.example", url: mainUrl, createdAtMs: 100, mode: "update",
      } } }),
      setSession: async () => {},
    },
  });
  try {
    const result = await handleMessage({ type: "check-pending-save-banner" },
      { id: "kinic", frameId: 0, tab: { id: 1, url: mainUrl + ":8443" } });
    assert.equal(result.result.prompt, null);
  } finally {
    setServiceWorkerDepsForTest({});
  }
});
