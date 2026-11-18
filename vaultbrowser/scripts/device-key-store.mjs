// Acceptance-only metadata inspection. Never returns secret-key handles or bytes.
import assert from "node:assert/strict";

export async function readDeviceKeyStore() {
  if (!(await indexedDB.databases()).some(db => db.name === "kinic-vault-device-keys-v1")) return null;
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("kinic-vault-device-keys-v1");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const stores = Array.from(db.objectStoreNames);
    if (!stores.includes("entries")) return { stores, keys: [], records: [] };
    const request = db.transaction("entries").objectStore("entries").getAll();
    const records = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { stores, records: records.map(record => ({
      fields: Object.keys(record).sort(), id: record.id, scope: record.scope, epoch: record.epoch,
      key: record.key instanceof CryptoKey ? {
        type: record.key.type, extractable: record.key.extractable,
        algorithm: record.key.algorithm.name, length: record.key.algorithm.length,
        usages: Array.from(record.key.usages).sort(),
      } : null,
    })) };
  } finally { db.close(); }
}

export function assertDeviceKeyStore(store, scope) {
  assert.ok(store, "expected a saved browser-key database");
  assert.deepEqual(store.stores, ["entries"]);
  for (const record of store.records) {
    assert.equal(record.scope, scope, "device key must belong to this canister and owner");
    if (record.id === `epoch:${scope}`) {
      assert.deepEqual(record.fields, ["epoch", "id", "scope"]);
      assert.ok(Number.isSafeInteger(record.epoch) && record.epoch >= 0);
    } else {
      assert.deepEqual(record.fields, ["id", "key", "scope"]);
      assert.ok(record.id.startsWith(`key:${scope}:`));
      const binding = JSON.parse(record.id.slice(`key:${scope}:`.length));
      assert.equal(binding.length, 3);
      assert.equal(binding[2], "root/v3");
      assert.ok(binding.slice(0, 2).every(bytes => Array.isArray(bytes)
        && bytes.length > 0 && bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)));
      assert.deepEqual(record.key, { type: "secret", extractable: false,
        algorithm: "AES-GCM", length: 256, usages: ["decrypt", "encrypt"] });
    }
  }
}
