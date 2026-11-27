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

test("editing the primary login preserves additional logins", async () => {
  const session = new Session();
  let saved;
  const engine = new VaultEngine({
    authSnapshot: async () => ({ isAuthenticated: true, identity: {}, principal: "owner" }),
    createVaultClient: async () => ({
      session,
      listVaults: async () => [{ id, state: { Active: null }, name: ["Vault"] }],
      listAccessibleVaults: async () => ({ entries: [], next: [] }),
      open: async () => { session.root = {}; },
      items: async () => [{ revision, metadata }],
      read: async () => ({ metadata, plaintext: new TextEncoder().encode(JSON.stringify(record)) }),
      save: async (nextMetadata, plaintext) => {
        saved = { metadata: nextMetadata, record: JSON.parse(new TextDecoder().decode(plaintext)) };
        return { ...revision, revision: 2n };
      }
    })
  });
  await engine.unlockVault();
  await engine.saveCredential({ objectIdHex, title: "Updated", username: "primary", password: "new-value", url: mainUrl });
  assert.deepEqual(saved.record.additionalLogins, record.additionalLogins);
  assert.deepEqual(saved.metadata.domains, ["primary.example", "secondary.example"]);
});
