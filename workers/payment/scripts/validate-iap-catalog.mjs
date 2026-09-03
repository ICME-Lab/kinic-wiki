import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const paymentRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function validateCatalog({ record, sandboxConfig, productionConfig, production = false }) {
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.productId, "xyz.kinic.dbcredits.small");
  assert.equal(record.type, "CONSUMABLE");
  assert.equal(record.baseTerritory, "USA");
  assert.equal(record.grantPolicy, "fixed");
  assert.equal(record.amountCycles, "2000000000000");

  const sandboxCatalog = JSON.parse(sandboxConfig.vars.IAP_PRODUCT_CATALOG_JSON);
  assert.deepEqual(Object.keys(sandboxCatalog), [record.productId]);
  assert.equal(sandboxCatalog[record.productId], record.amountCycles);

  const productionCatalog = JSON.parse(productionConfig.vars.IAP_PRODUCT_CATALOG_JSON);
  assert.equal(productionCatalog[record.productId], record.amountCycles);
  assert.ok("xyz.kinic.dbcredits.medium" in productionCatalog);
  assert.ok("xyz.kinic.dbcredits.large" in productionCatalog);

  if (production) {
    assert.equal(record.status, "approved", "production IAP pricing record is not approved");
    assert.match(
      record.appStorePriceReadbackAt ?? "",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
      "production IAP price readback timestamp is missing"
    );
  }
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateCatalog({
    record: readJSON(join(paymentRoot, "operations", "xyz.kinic.dbcredits.small.json")),
    sandboxConfig: readJSON(join(paymentRoot, "wrangler.sandbox.jsonc")),
    productionConfig: readJSON(join(paymentRoot, "wrangler.production.jsonc.example")),
    production: process.argv.includes("--production")
  });
  console.log("IAP catalog and fixed cycles grant OK");
}
